'use client'

/**
 * Axis Performance — Exterior Measurement Module (Phase 1 MVP).
 *
 * Flow:
 *   1. Pick project + create or open an exterior job
 *   2. Upload photos → Gemini classifies elevation + observations
 *   3. Coverage map shows per-elevation status
 *   4. (Optional, scaffolded) Submit photos for photogrammetry on RunPod
 *   5. Trace measurements per photo using scale anchors (wall / window /
 *      door / trim / corner). Every measurement is contractor-entered.
 *   6. Summary panel rolls up totals by material + elevation
 *   7. (Coming) PDF report extension picks up the same data
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import { getUser } from '@/lib/auth'
import PhotoUploadZone from '@/components/exterior/PhotoUploadZone'
import CoverageMap from '@/components/exterior/CoverageMap'
import MeasurementTraceTool from '@/components/exterior/MeasurementTraceTool'

interface Project {
  id: string
  name: string
  address?: string
  city?: string
  state?: string
  zip?: string
}

interface Job {
  id: string
  project_id: string
  status: string
  photo_count?: number
  measurement_count?: number
  mesh_url?: string
  photogrammetry_job_id?: string
}

interface Photo {
  id: string
  photo_url: string
  classified_elevation: string
  classification_confidence: number
  vision_observations: Record<string, unknown>
  original_filename?: string
  width_px?: number
  height_px?: number
}

interface Coverage { count: number; effective_count?: number; status: string }

interface Measurement {
  id: string
  measurement_type: string
  elevation?: string
  material_type?: string
  facade_id?: string
  area_sqft?: number
  length_ft?: number
  width_in?: number
  height_in?: number
  united_inches?: number
}

export default function ExteriorPage() {
  const router = useRouter()
  const [userId, setUserId] = useState<string | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState<string | null>(null)
  const [job, setJob] = useState<Job | null>(null)
  const [photos, setPhotos] = useState<Photo[]>([])
  const [measurements, setMeasurements] = useState<Measurement[]>([])
  const [coverage, setCoverage] = useState<Record<string, Coverage>>({})
  const [photogrammetryAvailable, setPhotogrammetryAvailable] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<Record<string, unknown> | null>(null)

  // Load user + projects
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const u = await getUser()
        if (!u) { router.push('/login'); return }
        if (cancelled) return
        setUserId(u.id)
        const res = await api.projects.list(u.id)
        if (cancelled) return
        setProjects(res as Project[])
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load projects')
      }
    })()
    return () => { cancelled = true }
  }, [router])

  const loadJob = useCallback(async (jobId: string) => {
    setBusy(true)
    setError(null)
    try {
      const data = await api.exterior.getJob(jobId)
      setJob(data.job as unknown as Job)
      setPhotos(data.photos as unknown as Photo[])
      setMeasurements(data.measurements as unknown as Measurement[])
      setCoverage(data.coverage)
      setPhotogrammetryAvailable(data.photogrammetry_available)
      try {
        const sum = await api.exterior.getSummary(jobId)
        setSummary(sum)
      } catch { /* summary is optional */ }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load job')
    } finally {
      setBusy(false)
    }
  }, [])

  const pickProject = useCallback(async (pId: string) => {
    setProjectId(pId)
    setJob(null)
    setPhotos([])
    setMeasurements([])
    setCoverage({})
    setBusy(true)
    setError(null)
    try {
      const { jobs } = await api.exterior.listJobs(pId)
      if (jobs && jobs.length > 0) {
        await loadJob((jobs[0] as unknown as Job).id)
      } else {
        // No existing job — create one
        const j = await api.exterior.createJob({ project_id: pId, report_type: 'complete' })
        await loadJob((j as unknown as Job).id)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open job')
    } finally {
      setBusy(false)
    }
  }, [loadJob])

  const refresh = useCallback(() => {
    if (job?.id) void loadJob(job.id)
  }, [job?.id, loadJob])

  const onSubmitPhotogrammetry = useCallback(async () => {
    if (!job?.id) return
    setBusy(true)
    setError(null)
    try {
      const result = await api.exterior.submitPhotogrammetry(job.id)
      if ((result as { status?: string }).status === 'disabled') {
        setError('Photogrammetry endpoint not configured. Set RUNPOD_API_KEY + RUNPOD_PHOTOGRAMMETRY_ENDPOINT_ID on the backend, or proceed with manual measurements.')
      } else {
        await loadJob(job.id)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Submit failed')
    } finally {
      setBusy(false)
    }
  }, [job?.id, loadJob])

  const measurementsByType = useMemo(() => {
    const out: Record<string, Measurement[]> = {}
    for (const m of measurements) {
      const key = m.measurement_type
      ;(out[key] = out[key] || []).push(m)
    }
    return out
  }, [measurements])

  // ----- Render -----

  return (
    <div className="mx-auto max-w-[1400px] space-y-5 p-6 text-slate-100">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Exterior Measurement Module</h1>
          <p className="text-sm text-slate-400">
            Phase 1 — manual measurement workflow. Upload photos, classify by elevation,
            trace walls/openings/corners with scale anchors. Every number is contractor-entered
            (no AI hallucination ends up in your material orders).
          </p>
        </div>
        {photogrammetryAvailable && job && photos.length >= 6 && (
          <button
            onClick={onSubmitPhotogrammetry}
            disabled={busy}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500 disabled:opacity-50"
          >Submit for 3D reconstruction</button>
        )}
      </header>

      {error && (
        <div className="rounded-lg border border-rose-400/30 bg-rose-500/10 p-3 text-sm text-rose-200">{error}</div>
      )}

      {/* Project picker */}
      {!projectId && (
        <section className="rounded-lg border border-white/10 bg-slate-900/40 p-4">
          <h2 className="mb-3 text-sm font-semibold">Pick a project</h2>
          {projects.length === 0 ? (
            <p className="text-xs text-slate-400">No projects yet — create one from the Projects page first.</p>
          ) : (
            <ul className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
              {projects.map(p => (
                <li
                  key={p.id}
                  onClick={() => void pickProject(p.id)}
                  className="cursor-pointer rounded-md border border-white/10 bg-slate-800/40 p-3 text-sm transition hover:border-blue-400/40 hover:bg-blue-500/10"
                >
                  <div className="font-medium">{p.name}</div>
                  {p.address && (
                    <div className="text-xs text-slate-400">
                      {[p.address, p.city, p.state, p.zip].filter(Boolean).join(', ')}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {projectId && job && userId && (
        <>
          <div className="flex items-center justify-between rounded border border-white/10 bg-slate-900/40 px-3 py-2 text-xs">
            <div>
              <strong>Project:</strong> {projects.find(p => p.id === projectId)?.name ?? projectId}
              <span className="ml-3 text-slate-400">Job status: <strong className="text-slate-200">{job.status}</strong></span>
            </div>
            <button
              onClick={() => { setProjectId(null); setJob(null) }}
              className="rounded bg-slate-700 px-2 py-1 text-slate-200 hover:bg-slate-600"
            >Change project</button>
          </div>

          <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <h2 className="mb-2 text-sm font-semibold text-slate-200">1. Upload photos</h2>
              <PhotoUploadZone
                jobId={job.id}
                userId={userId}
                onPhotosRegistered={refresh}
              />
            </div>
            <div>
              <h2 className="mb-2 text-sm font-semibold text-slate-200">Coverage</h2>
              <CoverageMap coverage={coverage} />
            </div>
          </section>

          {photos.length > 0 && (
            <section>
              <h2 className="mb-2 text-sm font-semibold text-slate-200">Photos ({photos.length})</h2>
              <ul className="grid grid-cols-2 gap-2 md:grid-cols-4 lg:grid-cols-6">
                {photos.map(p => {
                  const obs = (p.vision_observations || {}) as Record<string, unknown>
                  return (
                    <li key={p.id} className="overflow-hidden rounded border border-white/10 bg-slate-900/40">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={p.photo_url} alt="" className="block h-28 w-full object-cover" />
                      <div className="p-2 text-[10px]">
                        <select
                          value={p.classified_elevation}
                          onChange={async (e) => {
                            await api.exterior.patchPhoto(p.id, { classified_elevation: e.target.value })
                            refresh()
                          }}
                          className="w-full rounded bg-slate-800 px-1 py-0.5 text-slate-100"
                        >
                          {['front', 'right', 'rear', 'left', 'front_right', 'right_rear', 'rear_left', 'left_front', 'aerial', 'detail', 'unknown'].map(e => (
                            <option key={e} value={e}>{e}</option>
                          ))}
                        </select>
                        <div className="mt-1 text-slate-400">
                          {String(obs.siding_material_guess || '—')} · {String(obs.openings_visible || 0)} openings
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </section>
          )}

          <section>
            <h2 className="mb-2 text-sm font-semibold text-slate-200">2. Trace measurements</h2>
            <MeasurementTraceTool
              jobId={job.id}
              photos={photos}
              onSaved={refresh}
            />
          </section>

          {measurements.length > 0 && summary && (
            <section className="rounded-lg border border-white/10 bg-slate-900/40 p-4">
              <h2 className="mb-3 text-sm font-semibold text-slate-200">3. Summary</h2>
              <div className="grid grid-cols-2 gap-3 text-xs md:grid-cols-4">
                <SummaryCard label="Walls (total ft²)" value={(summary.walls as { total_sqft?: number })?.total_sqft ?? 0} />
                <SummaryCard label="Windows" value={(summary.openings as { windows_count?: number })?.windows_count ?? 0} />
                <SummaryCard label="Doors" value={(summary.openings as { doors_count?: number })?.doors_count ?? 0} />
                <SummaryCard label="Trim (lf)" value={(summary.trim_lf as number) ?? 0} />
              </div>

              <details className="mt-4 text-xs">
                <summary className="cursor-pointer text-slate-400 hover:text-slate-200">All measurements ({measurements.length})</summary>
                <ul className="mt-2 space-y-1">
                  {Object.entries(measurementsByType).map(([type, items]) => (
                    <li key={type}>
                      <div className="mt-2 text-slate-400">{type} ({items.length})</div>
                      <ul className="ml-3 space-y-1">
                        {items.map(m => (
                          <li key={m.id} className="flex items-center justify-between rounded bg-slate-800/40 px-2 py-1">
                            <span>
                              {m.facade_id || '—'} · {m.elevation || '?'} · {m.material_type || ''}
                              {m.area_sqft ? ` · ${m.area_sqft} ft²` : ''}
                              {m.length_ft ? ` · ${m.length_ft} lf` : ''}
                              {m.width_in && m.height_in ? ` · ${m.width_in}" × ${m.height_in}"` : ''}
                            </span>
                            <button
                              onClick={async () => {
                                await api.exterior.deleteMeasurement(m.id)
                                refresh()
                              }}
                              className="text-rose-400 hover:text-rose-300"
                            >×</button>
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              </details>
            </section>
          )}

          {/* Photogrammetry status panel */}
          {photogrammetryAvailable && job.photogrammetry_job_id && (
            <PhotogrammetryStatusPanel jobId={job.id} />
          )}

          {!photogrammetryAvailable && (
            <div className="rounded border border-amber-400/30 bg-amber-500/10 p-3 text-xs text-amber-200">
              <strong>Photogrammetry not yet enabled.</strong> The COLMAP/OpenSfM RunPod endpoint is unconfigured.
              Set <code>RUNPOD_PHOTOGRAMMETRY_ENDPOINT_ID</code> on the backend once the worker is deployed.
              Until then, all measurements come from your manual traces above — which is the honest workflow either way.
            </div>
          )}
        </>
      )}
    </div>
  )
}

function SummaryCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded border border-white/10 bg-slate-900/60 p-2">
      <div className="text-[10px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className="text-lg font-semibold text-slate-100">{value}</div>
    </div>
  )
}

function PhotogrammetryStatusPanel({ jobId }: { jobId: string }) {
  const [status, setStatus] = useState<Record<string, unknown> | null>(null)
  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const s = await api.exterior.photogrammetryStatus(jobId)
        if (!cancelled) setStatus(s)
      } catch { /* ignore */ }
    }
    void tick()
    const id = setInterval(tick, 8000)
    return () => { cancelled = true; clearInterval(id) }
  }, [jobId])

  if (!status) return null
  const s = String(status.status || 'unknown')
  return (
    <div className="rounded border border-white/10 bg-slate-900/40 p-3 text-xs">
      <strong>Photogrammetry:</strong> {s}
      {status.progress_pct != null && Number(status.progress_pct) > 0 && (
        <span className="ml-2">{Number(status.progress_pct).toFixed(0)}%</span>
      )}
      {Boolean(status.error) && <div className="mt-1 text-rose-300">{String(status.error)}</div>}
      {Boolean(status.mesh_url) && (
        <a href={String(status.mesh_url)} target="_blank" rel="noreferrer" className="ml-2 text-blue-400 hover:text-blue-300">
          Open mesh →
        </a>
      )}
    </div>
  )
}
