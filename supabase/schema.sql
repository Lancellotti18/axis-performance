-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Profiles (extends Supabase auth.users)
CREATE TABLE profiles (
  id            UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name     TEXT,
  company_name  TEXT,
  phone         TEXT,
  region        TEXT DEFAULT 'US-TX',
  plan          TEXT DEFAULT 'starter' CHECK (plan IN ('starter', 'pro', 'enterprise')),
  stripe_customer_id TEXT,
  uploads_used  INT DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Projects
CREATE TABLE projects (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  description     TEXT,
  region          TEXT,
  blueprint_type  TEXT DEFAULT 'residential',
  status          TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'complete', 'failed')),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Blueprints
CREATE TABLE blueprints (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  file_url      TEXT NOT NULL,
  file_type     TEXT CHECK (file_type IN ('pdf', 'png', 'jpg', 'jpeg')),
  page_count    INT DEFAULT 1,
  file_size_kb  INT,
  status        TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'complete', 'failed')),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Analyses
CREATE TABLE analyses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  blueprint_id    UUID NOT NULL REFERENCES blueprints(id) ON DELETE CASCADE,
  raw_detections  JSONB,
  rooms           JSONB DEFAULT '[]'::jsonb,
  walls           JSONB DEFAULT '[]'::jsonb,
  openings        JSONB DEFAULT '[]'::jsonb,
  electrical      JSONB DEFAULT '[]'::jsonb,
  plumbing        JSONB DEFAULT '[]'::jsonb,
  structural      JSONB DEFAULT '[]'::jsonb,
  total_sqft      NUMERIC DEFAULT 0,
  scale_factor    NUMERIC,
  confidence      NUMERIC DEFAULT 0,
  overlay_url     TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Material estimates
CREATE TABLE material_estimates (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id   UUID NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
  category      TEXT NOT NULL,
  item_name     TEXT NOT NULL,
  quantity      NUMERIC NOT NULL,
  unit          TEXT NOT NULL,
  unit_cost     NUMERIC NOT NULL,
  total_cost    NUMERIC NOT NULL,
  region        TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Cost estimates
CREATE TABLE cost_estimates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  materials_total NUMERIC DEFAULT 0,
  labor_total     NUMERIC DEFAULT 0,
  markup_pct      NUMERIC DEFAULT 15,
  overhead_pct    NUMERIC DEFAULT 10,
  grand_total     NUMERIC DEFAULT 0,
  region          TEXT,
  labor_rate      NUMERIC,
  labor_hours     NUMERIC,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Reports
CREATE TABLE reports (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  report_url    TEXT,
  excel_url     TEXT,
  csv_url       TEXT,
  generated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Regional pricing
CREATE TABLE regional_pricing (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  region_code     TEXT UNIQUE NOT NULL,
  region_name     TEXT NOT NULL,
  labor_rate_hr   NUMERIC NOT NULL,
  lumber_index    NUMERIC DEFAULT 1.0,
  concrete_index  NUMERIC DEFAULT 1.0,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Seed regional pricing
INSERT INTO regional_pricing (region_code, region_name, labor_rate_hr, lumber_index, concrete_index) VALUES
('US-CA', 'California', 85, 1.20, 1.25),
('US-TX', 'Texas', 65, 1.0, 1.0),
('US-NY', 'New York', 95, 1.25, 1.30),
('US-FL', 'Florida', 60, 1.05, 1.05),
('US-WA', 'Washington', 80, 1.10, 1.15),
('US-CO', 'Colorado', 72, 1.05, 1.08),
('US-AZ', 'Arizona', 62, 1.02, 1.03),
('US-GA', 'Georgia', 58, 0.98, 0.97),
('US-NC', 'North Carolina', 57, 0.97, 0.96),
('US-IL', 'Illinois', 78, 1.08, 1.10),
('US-OH', 'Ohio', 62, 0.99, 0.98),
('US-MI', 'Michigan', 64, 1.01, 1.00);

-- Row Level Security
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE blueprints ENABLE ROW LEVEL SECURITY;
ALTER TABLE analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE material_estimates ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_estimates ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can view own profile" ON profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Users can update own profile" ON profiles FOR UPDATE USING (auth.uid() = id);

CREATE POLICY "Users can CRUD own projects" ON projects FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Users can access blueprints via projects" ON blueprints FOR ALL
  USING (project_id IN (SELECT id FROM projects WHERE user_id = auth.uid()));

CREATE POLICY "Users can access analyses" ON analyses FOR ALL
  USING (blueprint_id IN (
    SELECT b.id FROM blueprints b
    JOIN projects p ON b.project_id = p.id
    WHERE p.user_id = auth.uid()
  ));

CREATE POLICY "Users can access estimates" ON cost_estimates FOR ALL
  USING (project_id IN (SELECT id FROM projects WHERE user_id = auth.uid()));

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name)
  VALUES (new.id, new.raw_user_meta_data->>'full_name');
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

-- Compliance checks
CREATE TABLE compliance_checks (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status       TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'complete', 'failed')),
  region       TEXT,
  city         TEXT,
  project_type TEXT,
  summary      TEXT,
  risk_level   TEXT CHECK (risk_level IN ('low', 'medium', 'high')),
  raw_data     JSONB,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Individual compliance items
CREATE TABLE compliance_items (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  check_id     UUID NOT NULL REFERENCES compliance_checks(id) ON DELETE CASCADE,
  category     TEXT NOT NULL,
  title        TEXT NOT NULL,
  description  TEXT,
  severity     TEXT CHECK (severity IN ('required', 'recommended', 'info')),
  action       TEXT,
  deadline     TEXT,
  penalty      TEXT,
  source       TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- RLS for compliance tables
ALTER TABLE compliance_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can access own compliance checks" ON compliance_checks FOR ALL
  USING (project_id IN (SELECT id FROM projects WHERE user_id = auth.uid()));

CREATE POLICY "Users can access own compliance items" ON compliance_items FOR ALL
  USING (check_id IN (
    SELECT cc.id FROM compliance_checks cc
    JOIN projects p ON cc.project_id = p.id
    WHERE p.user_id = auth.uid()
  ));
