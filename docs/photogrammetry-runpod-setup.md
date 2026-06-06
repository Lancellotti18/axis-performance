# Photogrammetry RunPod Worker — Deployment Guide

**Status:** Phase 2. Not deployed yet. This document is the spec a future engineer
(or current you) follows to ship the COLMAP/OpenSfM container that turns the
exterior module's photo sets into 3D meshes.

The Axis backend already has the **scaffold** for this — when this worker is
deployed, set `RUNPOD_PHOTOGRAMMETRY_ENDPOINT_ID` on the Render env and the
`/exterior/v1/jobs/{id}/photogrammetry/submit` endpoint will route work to it
without any further backend changes.

---

## What this worker does

Input:
- A list of 6–20 photo URLs (already classified by elevation upstream)
- Optional metadata (axis job ID, GPS, EXIF)

Output:
- Dense surface mesh as `.gltf` (or `.glb`) — uploaded to S3/R2, URL returned
- Dense point cloud as `.ply` — uploaded, URL returned
- Quality stats: reprojection error, % reconstructed area, photo coverage map

Pipeline:
1. **SfM (Structure from Motion)** — feature extraction (SIFT/SuperPoint) + match + bundle adjustment → sparse point cloud + camera poses
2. **MVS (Multi-View Stereo)** — dense reconstruction from images + poses → dense point cloud
3. **Surface reconstruction** — Poisson or Ball-Pivoting → watertight mesh
4. **Mesh cleanup** — decimation to ~50k triangles, hole filling, normal estimation
5. **Texture baking** (optional Phase 2.5) — back-project source photos onto mesh faces for textured viewer
6. **Export** — GLTF + PLY → upload → return URLs

---

## Worker contract (what the Axis backend expects)

The Axis backend hits `https://api.runpod.ai/v2/{endpoint_id}/run` with this
body:

```json
{
  "input": {
    "photos": ["https://.../front.jpg", "https://.../left.jpg", "..."],
    "metadata": {
      "axis_job_id": "uuid"
    }
  }
}
```

The worker must accept that shape and return (when complete):

```json
{
  "status": "COMPLETED",
  "output": {
    "mesh_url": "https://.../mesh.gltf",
    "point_cloud_url": "https://.../cloud.ply",
    "stats": {
      "reprojection_error_px": 0.83,
      "reconstructed_pct": 92.4,
      "photos_used": 12,
      "photos_rejected": 0
    },
    "progress_pct": 100
  }
}
```

For polling, the standard `/status/{job_id}` endpoint must return
`"status": "IN_PROGRESS"` with `output.progress_pct` updating as the pipeline
advances. See [photogrammetry_service.py](../backend/app/services/photogrammetry_service.py)
for the exact status mapping.

---

## Container recipe

Use **GPU base** image (RunPod serverless GPU). Suggested:

```dockerfile
FROM colmap/colmap:latest

# OpenMVS for MVS step (or replace with OpenSfM end-to-end)
RUN apt-get update && apt-get install -y openmvs python3-pip wget

# Python deps
RUN pip install runpod open3d trimesh pygltflib boto3 httpx pillow

# Worker entrypoint
COPY worker.py /worker.py
CMD ["python3", "-u", "/worker.py"]
```

Worker `worker.py` outline:

```python
import os, tempfile, subprocess, httpx, json
import runpod

def handler(event):
    photos = event["input"]["photos"]
    job_meta = event["input"].get("metadata", {})

    with tempfile.TemporaryDirectory() as wd:
        # 1. Download all photos
        for i, url in enumerate(photos):
            with httpx.Client(timeout=60) as c:
                r = c.get(url); r.raise_for_status()
            open(f"{wd}/img_{i:03d}.jpg", "wb").write(r.content)

        # 2. COLMAP feature extraction + matching + SfM
        subprocess.run([
            "colmap", "automatic_reconstructor",
            "--workspace_path", wd,
            "--image_path", wd,
            "--data_type", "individual",
            "--quality", "medium",     # 'high' = 4x slower
        ], check=True)

        # 3. Export sparse + dense models
        subprocess.run([
            "colmap", "model_converter",
            "--input_path", f"{wd}/sparse/0",
            "--output_path", f"{wd}/sparse.ply",
            "--output_type", "PLY",
        ], check=True)

        # 4. (OpenMVS would run here for MVS dense + mesh)
        # ...

        # 5. Upload outputs to S3 (or RunPod's bundled storage)
        mesh_url = upload_to_s3(f"{wd}/mesh.gltf", job_meta)
        cloud_url = upload_to_s3(f"{wd}/cloud.ply", job_meta)

        return {
            "mesh_url": mesh_url,
            "point_cloud_url": cloud_url,
            "stats": {
                "photos_used": len(photos),
                "reconstructed_pct": 0,   # parse from COLMAP logs
                "reprojection_error_px": 0,
            },
            "progress_pct": 100,
        }

runpod.serverless.start({"handler": handler})
```

---

## Deployment steps

1. Build the container locally:
   ```
   docker build -t axis-photogrammetry .
   ```

2. Test against a local photo set (sanity-check SfM completes):
   ```
   docker run --gpus all -v $(pwd)/test_photos:/photos axis-photogrammetry \
     python3 /worker.py --local-test /photos
   ```

3. Push to a registry (Docker Hub, GHCR, or RunPod's registry):
   ```
   docker tag axis-photogrammetry your-registry/axis-photogrammetry:v1
   docker push your-registry/axis-photogrammetry:v1
   ```

4. Create a RunPod Serverless Endpoint pointing at the image. Recommended:
   - **GPU:** A10 or A40 (24GB VRAM minimum for high-quality MVS)
   - **Idle timeout:** 60 seconds (saves money between jobs)
   - **Container start command:** default (from CMD)
   - **Environment variables:** `AXIS_S3_BUCKET`, `AXIS_S3_REGION`, AWS creds

5. Note the endpoint ID. In Render env vars:
   ```
   RUNPOD_PHOTOGRAMMETRY_ENDPOINT_ID=<the endpoint id>
   ```
   The Axis backend picks this up automatically — no code change.

6. Smoke-test from the Axis UI:
   - Open `/exterior` for any project
   - Upload 8+ photos covering all 4 elevations
   - Click "Submit for 3D reconstruction"
   - Watch the photogrammetry status panel — should move through `queued` →
     `in_progress` (with progress %) → `completed` with a mesh URL

---

## Cost ballpark

- **A10 24GB on RunPod Serverless:** ~$0.20/hour while running, billed per
  second after the first 30s warmup.
- **Typical residential job (12 photos, medium quality):** 4–8 minutes wall
  clock → roughly **$0.03–$0.05 per job**.
- **High quality (more photos, finer mesh):** 15–25 minutes → ~$0.10–$0.15.

Compare to EagleView at ~$25/report or HOVER at ~$95–$130/report.

---

## Phase 2.5+ extensions (not in initial deployment)

- **Texture baking** — back-project source photos onto mesh faces so the
  Three.js viewer shows photoreal walls. Adds ~30s to pipeline.
- **Semantic mesh segmentation** — fine-tune SAM on aerial+facade imagery so
  the worker also returns labeled per-face JSON (wall vs. roof vs. window vs.
  trim). This is the part HOVER spent years building. Realistic timeline: 2–4
  months of focused engineering once you have ground-truth labels.
- **Auto-measurement extraction** — once segmentation is reliable, you can
  derive facet areas + edge lengths from the labeled mesh. **Only valuable
  if accuracy approaches HOVER's ±3% — until then, the contractor manual
  trace is more honest.**

---

## Files modified when this worker ships

When the container is live and `RUNPOD_PHOTOGRAMMETRY_ENDPOINT_ID` is set:

- No backend code changes needed (the scaffold is already in place)
- `/exterior` UI auto-detects `photogrammetry_available=true` via the
  `/jobs/{id}` response and unhides the "Submit for 3D reconstruction" button
- The exterior PDF's Section 8 (Methodology) will start reporting the
  photogrammetry status as `completed` and the mesh URL on the cover page
- Phase 3 follow-up: add a Three.js `MeshViewer.tsx` component that loads the
  returned GLTF and overlays the contractor's facade IDs

---

## Why this isn't a session-scope task

Estimated effort:
- Container build + COLMAP tuning: **3–5 days**
- OpenMVS integration: **2–3 days**
- GLTF export + texture baking: **2 days**
- Worker contract + RunPod integration + error handling: **2 days**
- End-to-end testing across diverse photo sets: **3–5 days**
- Iteration based on real contractor photo quality: **ongoing**

That's a 1–2 week focused engineering project even for an experienced computer
vision engineer. The pipeline is well-understood but every step has knobs.

When you're ready to start, hand this doc to whoever's building it (could be
me, could be a contractor) and we can iterate from here.
