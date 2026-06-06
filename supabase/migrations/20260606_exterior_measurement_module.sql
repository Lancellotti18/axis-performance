-- ============================================================================
-- Axis Performance — Exterior Measurement Module v1
-- ============================================================================
-- Phase-1 honest MVP: contractors upload photos, Gemini Vision classifies each
-- photo by elevation, contractors trace measurements (walls/openings/corners)
-- on those photos using scale references. The 8-section Hover-style PDF is
-- populated from contractor-confirmed traces only — no AI-claimed dimensions.
--
-- Photogrammetry scaffold (mesh_url / photogrammetry_job_id columns + RunPod
-- service) is in place but the COLMAP/OpenSfM RunPod endpoint is left
-- unwired. Section 2 of the build plan covers integrating it once a real
-- endpoint is deployed.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. exterior_jobs
-- ----------------------------------------------------------------------------
-- One row per measurement attempt against a project. Holds photogrammetry
-- status, the assembled cover photo, and aggregate counts populated when the
-- PDF is generated.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS exterior_jobs (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id               UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  report_type              TEXT NOT NULL DEFAULT 'complete' CHECK (report_type IN ('complete', 'roof_only')),
  status                   TEXT NOT NULL DEFAULT 'collecting' CHECK (status IN (
                             'collecting',         -- contractor adding photos / measurements
                             'classifying',        -- Gemini elevation classification running
                             'photogrammetry',     -- mesh reconstruction running on RunPod
                             'ready',              -- measurements + (optional) mesh ready, PDF generatable
                             'failed'
                           )),
  -- Photogrammetry handoff (RunPod or future replacement)
  photogrammetry_job_id    TEXT,
  photogrammetry_provider  TEXT DEFAULT 'runpod_colmap',
  photogrammetry_started_at TIMESTAMPTZ,
  photogrammetry_ready_at  TIMESTAMPTZ,
  mesh_url                 TEXT,
  point_cloud_url          TEXT,
  -- Aggregates (recomputed when measurements change)
  photo_count              INTEGER DEFAULT 0,
  measurement_count        INTEGER DEFAULT 0,
  cover_photo_id           UUID,
  -- Confidence
  scale_calibration_source TEXT,                          -- 'door_80in' / 'garage_84in' / 'user_entered' / 'photogrammetry'
  overall_confidence       NUMERIC DEFAULT 0,             -- 0..1
  notes                    TEXT,
  warnings                 JSONB DEFAULT '[]'::jsonb,
  created_at               TIMESTAMPTZ DEFAULT NOW(),
  updated_at               TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS exterior_jobs_project_idx ON exterior_jobs (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS exterior_jobs_status_idx  ON exterior_jobs (status);

ALTER TABLE exterior_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can CRUD their exterior jobs" ON exterior_jobs;
CREATE POLICY "Users can CRUD their exterior jobs"
  ON exterior_jobs FOR ALL
  USING (axis_project_owner(project_id))
  WITH CHECK (axis_project_owner(project_id));


-- ----------------------------------------------------------------------------
-- 2. exterior_photos
-- ----------------------------------------------------------------------------
-- Each uploaded photo. classified_elevation is Gemini-suggested but the user
-- can override (classification_user_confirmed flips to true). The
-- vision_observations JSON is "what does the model see in this photo" —
-- never used as dimensions, just to help the contractor pick the right photo
-- when tracing.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS exterior_photos (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                        UUID NOT NULL REFERENCES exterior_jobs(id) ON DELETE CASCADE,
  photo_url                     TEXT NOT NULL,         -- Supabase Storage public URL
  storage_path                  TEXT,                   -- bucket-relative path for cleanup
  original_filename             TEXT,
  file_size_kb                  INTEGER,
  width_px                      INTEGER,
  height_px                     INTEGER,
  -- Vision classification
  classified_elevation          TEXT CHECK (classified_elevation IN (
                                  'front', 'right', 'rear', 'left',
                                  'front_right', 'right_rear', 'rear_left', 'left_front',
                                  'aerial', 'detail', 'unknown'
                                )) DEFAULT 'unknown',
  classification_confidence     NUMERIC DEFAULT 0,      -- 0..1
  classification_user_confirmed BOOLEAN DEFAULT FALSE,
  -- Qualitative observations from Gemini (NOT measurements)
  vision_observations           JSONB DEFAULT '{}'::jsonb,
                                                        -- {"siding_material": "vinyl", "openings_visible": 4, "features": ["chimney","gable_end"]}
  -- EXIF (for SfM later)
  exif_data                     JSONB DEFAULT '{}'::jsonb,
  gps_lat                       NUMERIC,
  gps_lng                       NUMERIC,
  taken_at                      TIMESTAMPTZ,
  is_cover                      BOOLEAN DEFAULT FALSE,
  sort_index                    INTEGER DEFAULT 0,
  created_at                    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS exterior_photos_job_idx   ON exterior_photos (job_id, sort_index);
CREATE INDEX IF NOT EXISTS exterior_photos_elev_idx  ON exterior_photos (job_id, classified_elevation);

ALTER TABLE exterior_photos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can CRUD photos via job ownership" ON exterior_photos;
CREATE POLICY "Users can CRUD photos via job ownership"
  ON exterior_photos FOR ALL
  USING (job_id IN (SELECT id FROM exterior_jobs WHERE axis_project_owner(project_id)))
  WITH CHECK (job_id IN (SELECT id FROM exterior_jobs WHERE axis_project_owner(project_id)));


-- ----------------------------------------------------------------------------
-- 3. exterior_measurements
-- ----------------------------------------------------------------------------
-- Per-measurement contractor-traced records. measurement_type controls what
-- the geometry means:
--   wall    — facade region polygon (replaces manual_siding_measurements role)
--   window  — opening rectangle (W-103 style ID)
--   door    — opening rectangle (D-1 style ID)
--   trim    — linear trim run (level_starter / sloped / vertical)
--   corner  — corner mark (single point with inside/outside flag)
--   roof_visible — roof face visible from this elevation (for cross-check
--                   with the satellite-traced roof_facets)
--
-- All measurements are contractor_entered=TRUE — flag is a permanent reminder
-- in the report that no AI sized these.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS exterior_measurements (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id              UUID NOT NULL REFERENCES exterior_jobs(id) ON DELETE CASCADE,
  photo_id            UUID REFERENCES exterior_photos(id) ON DELETE SET NULL,
  measurement_type    TEXT NOT NULL CHECK (measurement_type IN (
                        'wall', 'window', 'door', 'trim',
                        'corner_inside', 'corner_outside', 'roof_visible'
                      )),
  facade_id           TEXT,                            -- 'SI-1', 'BR-2', 'W-103', 'D-1', etc.
  elevation           TEXT CHECK (elevation IN (
                        'front', 'right', 'rear', 'left', 'other'
                      )),
  material_type       TEXT,                            -- 'vinyl', 'fiber_cement', 'brick', 'stone', 'stucco', 'wood', 'other'
  -- Scale anchor used for this trace
  reference_object    TEXT CHECK (reference_object IN ('standard_door_80', 'garage_door_84', 'window_36', 'custom', 'photogrammetry')),
  reference_height_in NUMERIC,
  reference_pixel_h   NUMERIC,
  scale_in_per_px     NUMERIC,
  -- Geometry: polygon for areas, two-point line for corners, rectangle for openings
  region_polygon      JSONB,                           -- [[x,y],...] pixel coords
  -- Derived metrics (computed at write time)
  area_sqft           NUMERIC NOT NULL DEFAULT 0,
  length_ft           NUMERIC NOT NULL DEFAULT 0,
  width_in            NUMERIC,                          -- openings only
  height_in           NUMERIC,                          -- openings only
  united_inches       NUMERIC,                          -- openings only: width + height
  -- Whether snapped to standard window/door size
  snapped_to_standard BOOLEAN DEFAULT FALSE,
  notes               TEXT,
  contractor_entered  BOOLEAN NOT NULL DEFAULT TRUE,    -- permanent label
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS exterior_meas_job_idx      ON exterior_measurements (job_id);
CREATE INDEX IF NOT EXISTS exterior_meas_type_idx     ON exterior_measurements (job_id, measurement_type);
CREATE INDEX IF NOT EXISTS exterior_meas_elev_idx     ON exterior_measurements (job_id, elevation);
CREATE INDEX IF NOT EXISTS exterior_meas_photo_idx    ON exterior_measurements (photo_id);

ALTER TABLE exterior_measurements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can CRUD measurements via job ownership" ON exterior_measurements;
CREATE POLICY "Users can CRUD measurements via job ownership"
  ON exterior_measurements FOR ALL
  USING (job_id IN (SELECT id FROM exterior_jobs WHERE axis_project_owner(project_id)))
  WITH CHECK (job_id IN (SELECT id FROM exterior_jobs WHERE axis_project_owner(project_id)));


-- ----------------------------------------------------------------------------
-- 4. Storage bucket for exterior photos
-- ----------------------------------------------------------------------------
-- Bucket is created in Supabase Storage. RLS policies below ensure users can
-- only read/write their own job's photos. We use the storage.objects table
-- directly to set the policies.
-- ----------------------------------------------------------------------------

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'exterior-photos',
  'exterior-photos',
  TRUE,                                                                 -- public read for share-link PDFs
  20 * 1024 * 1024,                                                     -- 20 MB per photo
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
)
ON CONFLICT (id) DO NOTHING;

-- Policy: authenticated users can upload to paths starting with their user_id
DROP POLICY IF EXISTS "Users can upload exterior photos" ON storage.objects;
CREATE POLICY "Users can upload exterior photos"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'exterior-photos'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "Users can update their exterior photos" ON storage.objects;
CREATE POLICY "Users can update their exterior photos"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'exterior-photos'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "Users can delete their exterior photos" ON storage.objects;
CREATE POLICY "Users can delete their exterior photos"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'exterior-photos'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Read is public (matches bucket setting) so PDFs / share-links can render
-- without a session token. Photos are signed via the public URL.


-- ----------------------------------------------------------------------------
-- 5. Updated-at triggers
-- ----------------------------------------------------------------------------

DROP TRIGGER IF EXISTS exterior_jobs_touch_updated ON exterior_jobs;
CREATE TRIGGER exterior_jobs_touch_updated BEFORE UPDATE ON exterior_jobs
  FOR EACH ROW EXECUTE FUNCTION axis_touch_updated_at();

DROP TRIGGER IF EXISTS exterior_meas_touch_updated ON exterior_measurements;
CREATE TRIGGER exterior_meas_touch_updated BEFORE UPDATE ON exterior_measurements
  FOR EACH ROW EXECUTE FUNCTION axis_touch_updated_at();
