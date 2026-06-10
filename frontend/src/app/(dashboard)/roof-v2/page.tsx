'use client'

/**
 * Axis Performance — Roof v2 (per-facet measurement workflow).
 *
 * End-to-end flow:
 *   1. Pick a project (or use the standalone mode)
 *   2. Validate property address via US Census Geocoder
 *   3. Fetch a healthy satellite tile via multi-provider chain
 *   4. Draw roof facets, set per-facet pitch, label each edge
 *   5. Live recompute totals + materials at every standard waste %
 *   6. Add penetrations (AI-suggested → user-confirmed)
 *   7. Manual siding measurements on elevation photos
 *   8. Download the 8-section PDF report
 *
 * Coexists with the legacy /aerial-report page; this is the contractor-
 * facing accuracy-first workflow.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import { getUser } from '@/lib/auth'
import LocationPicker, { type LocationSelected } from '@/components/roof-v2/LocationPicker'
import RoofFacetEditor, { type Facet, type LabeledEdge } from '@/components/roof-v2/RoofFacetEditor'
import MeasurementsSummary from '@/components/roof-v2/MeasurementsSummary'
import PenetrationSuggestions from '@/components/roof-v2/PenetrationSuggestions'
import FacetSuggestions from '@/components/roof-v2/FacetSuggestions'
import EdgeLabelSuggestions from '@/components/roof-v2/EdgeLabelSuggestions'
import AnnotatedRoofView from '@/components/roof-v2/AnnotatedRoofView'
import RoofViewer3D from '@/components/roof-v2/RoofViewer3D'
import SidingMeasurementTool from '@/components/roof-v2/SidingMeasurementTool'
import ReportsPanel from '@/components/roof-v2/ReportsPanel'

interface Project {
  id: string
  name: string
  address?: string
  city?: string
  state?: string
  zip?: string
}

interface ImageryPayload {
  status: 'ok' | 'degraded' | 'unavailable'
  provider?: string
  url?: string
  width_px?: number
  height_px?: number
  zoom?: number
  lat?: number
  lng?: number
  metres_per_pixel?: number
  feet_per_pixel?: number
  health_score: number
  warnings: string[]
  providers_tried: string[]
  // Track both the original (unsharpened) URL and the sharpened URL so the
  // contractor can compare them with their own eyes and verify whether
  // sharpening is actually adding value.
  original_url?: string
  sharpened_url?: string
  display_mode?: 'original' | 'sharpened'
}

type Step = 'project' | 'location' | 'imagery' | 'editor' | 'siding' | 'report'

export default function RoofV2Page() {
  const router = useRouter()
  const [userId, setUserId] = useState<string | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState<string | null>(null)
  const [project, setProject] = useState<Project | null>(null)
  const [location, setLocation] = useState<LocationSelected | null>(null)
  const [imagery, setImagery] = useState<ImageryPayload | null>(null)
  const [runId, setRunId] = useState<string | null>(null)
  const [facets, setFacets] = useState<Facet[]>([])
  const [edges, setEdges] = useState<LabeledEdge[]>([])
  const [geometryStamp, setGeometryStamp] = useState(0)
  const [step, setStep] = useState<Step>('project')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confidence, setConfidence] = useState<number>(0)

  // Load projects on mount
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const u = await getUser()
        if (!u) {
          router.push('/login')
          return
        }
        if (!cancelled) setUserId(u.id)
        const res = await api.projects.list(u.id)
        if (!cancelled) setProjects(res as Project[])
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load projects')
      }
    })()

    // Pre-warm the backend by hitting /health when the contractor lands on
    // this page. Render free tier sleeps after 15min of inactivity → cold
    // start takes ~75 seconds. By firing this ping now, the backend is
    // (hopefully) already warm by the time the contractor finishes picking
    // a project + address, so sharpening doesn't time out on a cold start.
    fetch('https://build-backend-jcp9.onrender.com/health', { cache: 'no-store' })
      .catch(() => { /* pre-warm is best-effort; failures are silent */ })

    return () => { cancelled = true }
  }, [router])

  // When a project is picked
  const pickProject = useCallback(async (id: string) => {
    setProjectId(id)
    setError(null)
    setBusy(true)
    try {
      const p = await api.projects.get(id)
      setProject(p as Project)
      const addr = [(p as Project).address, (p as Project).city, (p as Project).state, (p as Project).zip].filter(Boolean).join(', ')
      if (addr) {
        // Try to pre-validate
        try {
          const loc = await api.roofing.v2.locationValidate(addr)
          setLocation(loc as LocationSelected)
        } catch {
          // Address validation optional at this stage
        }
      }
      setStep('location')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load project')
    } finally {
      setBusy(false)
    }
  }, [])

  // When a location is confirmed: fetch the imagery health and surface it to
  // the user immediately. Sharpening is OPT-IN via a button — the user
  // reported it wasn't adding visible value, so we don't run it automatically.
  const [sharpening, setSharpening] = useState(false)
  const [nudging, setNudging] = useState(false)

  // Nudge the displayed view by N metres in lat/lng directions. Used by the
  // N/S/E/W arrow buttons when the geocoded center isn't quite on the house.
  // 1 degree latitude ≈ 111,320 m; longitude varies with cos(lat).
  const nudgeImagery = useCallback(async (eastMetres: number, northMetres: number) => {
    if (!location || !imagery) return
    setNudging(true)
    try {
      const newLat = location.lat + (northMetres / 111320)
      const newLng = location.lng + (eastMetres / (111320 * Math.cos(location.lat * Math.PI / 180)))
      const updatedLoc: LocationSelected = { ...location, lat: newLat, lng: newLng }
      setLocation(updatedLoc)
      const health = await api.roofing.v2.imageryHealth(newLat, newLng, 22, 2048, 1366) as ImageryPayload
      // Drop any previous sharpened URL since the view moved
      setImagery({ ...health, original_url: health.url, display_mode: 'original' })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not re-fetch imagery at new center')
    } finally {
      setNudging(false)
    }
  }, [location, imagery])

  // Optional on-demand sharpening when the contractor explicitly asks for it.
  // Same code path as before but only fires when they click the button.
  const trySharpening = useCallback(async () => {
    if (!imagery?.url || sharpening) return
    setSharpening(true)
    try {
      const sharp = await api.roofing.v2.upscaleImagery(imagery.url, 4) as {
        status: string
        upscaled_url?: string
        scale_factor?: number
        error?: string
      }
      // eslint-disable-next-line no-console
      console.log('[axis] manual sharpen result:', sharp.status, sharp.upscaled_url ? 'URL changed' : 'URL same', sharp.error || '')
      if (sharp.status === 'completed' && sharp.upscaled_url && sharp.upscaled_url !== imagery.url) {
        const factor = sharp.scale_factor ?? 4
        setImagery(prev => prev ? ({
          ...prev,
          url: sharp.upscaled_url,
          sharpened_url: sharp.upscaled_url,
          display_mode: 'sharpened',
          feet_per_pixel: (prev.feet_per_pixel ?? 0) / factor,
          warnings: [
            ...(prev.warnings || []),
            `✨ Tile AI-sharpened ${factor}x — toggle below to compare with original`,
          ],
        }) : prev)
      } else if (sharp.status === 'failed' || sharp.error) {
        setError(`Sharpening failed: ${sharp.error || sharp.status}. Original tile is still loaded.`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sharpening errored')
    } finally {
      setSharpening(false)
    }
  }, [imagery, sharpening])

  const onLocationSelected = useCallback(async (loc: LocationSelected) => {
    setLocation(loc)
    setStep('imagery')
    if (loc.lat === 0 && loc.lng === 0) {
      setImagery({ status: 'unavailable', providers_tried: [], warnings: ['Manual address entry — no coordinates available for imagery.'], health_score: 0 })
      return
    }
    setBusy(true)
    setError(null)
    try {
      // Zoom 22 + 2048x1366 request → MapTiler @2x retina returns 4096x2732
      // native pixels at the same ~38m x 25m ground area. That's about 4× more
      // pixels than the previous 1024x683 setting — real native resolution,
      // not AI hallucination. Backend falls back z22 -> z21 -> z20 if provider
      // lacks coverage at that location.
      const health = await api.roofing.v2.imageryHealth(loc.lat, loc.lng, 22, 2048, 1366) as ImageryPayload
      // Native resolution from MapTiler @2x retina is already much better than
      // what AI sharpening was producing. Auto-sharpen is OFF — contractor
      // can opt-in via 'Try AI sharpening' button on the panel if they want it.
      setImagery({ ...health, original_url: health.url, display_mode: 'original' })
      setBusy(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Imagery health check failed')
      setBusy(false)
    }
  }, [])

  // Create a measurement run + advance to editor. Heavily instrumented so we
  // can see EXACTLY what happens on each click and where it gets stuck if it
  // does — silent failures here have made debugging hard before.
  const startRun = useCallback(async () => {
    // eslint-disable-next-line no-console
    console.log('[axis] startRun click', { projectId, hasLocation: !!location, hasImagery: !!imagery, imageryUrl: imagery?.url })

    if (!projectId) {
      setError('Cannot open editor: no project selected. Go back to step 1.')
      return
    }
    if (!location) {
      setError('Cannot open editor: location not validated. Go back to step 2.')
      return
    }
    if (!imagery || !imagery.url) {
      setError('Cannot open editor: satellite tile failed to load. Go back to step 3.')
      return
    }

    setBusy(true)
    setError(null)
    try {
      // eslint-disable-next-line no-console
      console.log('[axis] startRun → POST /runs', {
        project_id: projectId,
        source: 'aerial_outline',
        satellite_image_url: imagery.url,
      })
      const run = await api.roofing.v2.createRun({
        project_id: projectId,
        source: 'aerial_outline',
        satellite_image_url: imagery.url,
        satellite_provider: imagery.provider,
        satellite_zoom: imagery.zoom,
        satellite_lat: imagery.lat,
        satellite_lng: imagery.lng,
        imagery_health: imagery.health_score,
      })
      // eslint-disable-next-line no-console
      console.log('[axis] startRun → run created', run)
      if (!run || !(run as { id?: string }).id) {
        setError('Backend returned no run id. Check Render logs.')
        return
      }
      setRunId((run as { id: string }).id)
      setStep('editor')
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown'
      // eslint-disable-next-line no-console
      console.error('[axis] startRun → failed', err)
      setError(
        `Failed to open editor: ${msg}. Check browser DevTools Network tab for `
        + 'the failing /api/v1/roofing/v2/runs request, OR check Render logs for backend errors.',
      )
    } finally {
      setBusy(false)
    }
  }, [projectId, location, imagery])

  // Persist facets + edges to backend whenever the editor publishes them.
  // Surfaces specific errors instead of silently failing so the contractor
  // doesn't end up staring at an empty Measurements panel wondering why.
  const persistGeometry = useCallback(async (newFacets: Facet[], newEdges: LabeledEdge[]) => {
    setFacets(newFacets)
    setEdges(newEdges)
    if (!runId) {
      setError('No measurement run created yet — refresh the page if this persists.')
      return
    }
    if (!imagery) {
      setError('Satellite imagery not loaded — go back to the Imagery step.')
      return
    }
    if (!location) {
      setError('Address not validated — go back to the Location step. Without a lat/lng, geometry cannot be measured.')
      return
    }
    if (newFacets.length === 0) {
      // Empty editor state isn't an error — just nothing to save
      return
    }
    const lat = location.lat
    const lng = location.lng
    if (lat === 0 && lng === 0) {
      setError('Address used manual entry (no coordinates). Pick an autocomplete suggestion instead so the platform can compute real measurements.')
      return
    }
    try {
      await api.roofing.v2.putFacets(runId, {
        image_width_px: imagery.width_px ?? 2048,
        image_height_px: imagery.height_px ?? 1366,
        zoom: imagery.zoom ?? 20,
        lat,
        lng,
        facets: newFacets.map(f => ({
          facet_label: f.label,
          polygon: f.polygon,
          pitch: f.pitch,
          confidence: f.confidence,
          user_confirmed: f.userConfirmed,
        })),
      })
      await api.roofing.v2.putEdges(runId, {
        image_width_px: imagery.width_px ?? 2048,
        image_height_px: imagery.height_px ?? 1366,
        zoom: imagery.zoom ?? 20,
        lat,
        edges: newEdges.map(e => ({
          facet_label: e.facetLabel,
          vertex_index_start: e.vertexIndexStart,
          vertex_index_end: e.vertexIndexEnd,
          edge_type: e.edgeType,
          shared_with_facet_label: e.sharedWithFacetLabel,
          user_confirmed: e.userConfirmed,
        })),
      })
      setGeometryStamp(s => s + 1)
      setError(null)   // clear any prior visible error on success
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown save error'
      setError(`Save failed: ${msg}. Check browser DevTools Network tab for the failing request.`)
    }
  }, [runId, imagery, location])

  // Debounced wrapper so we don't hammer the API on every vertex drag
  const debouncedRef = useMemo(() => ({ t: null as ReturnType<typeof setTimeout> | null }), [])
  const onEditorChange = useCallback((newFacets: Facet[], newEdges: LabeledEdge[]) => {
    setFacets(newFacets)
    setEdges(newEdges)
    if (debouncedRef.t) clearTimeout(debouncedRef.t)
    debouncedRef.t = setTimeout(() => { void persistGeometry(newFacets, newEdges) }, 800)
  }, [persistGeometry, debouncedRef])

  const confirmAndDownload = useCallback(async () => {
    if (!runId) return
    setBusy(true)
    setError(null)
    try {
      await api.roofing.v2.patchRun(runId, { confirmed: true })
      await api.roofing.v2.downloadReport(runId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Report download failed')
    } finally {
      setBusy(false)
    }
  }, [runId])

  return (
    <div className="mx-auto max-w-[1400px] space-y-6 p-6 text-slate-100">
      <header>
        <h1 className="text-2xl font-bold">Axis Roof Report (v2)</h1>
        <p className="text-sm text-slate-400">
          Multi-facet measurement with edge labeling. All numbers downstream — area, squares,
          ridge cap, drip edge, materials — are computed from your polygons and pitches. Nothing
          is fabricated.
        </p>
      </header>

      {/* Stepper */}
      <nav className="flex flex-wrap gap-2 text-xs">
        {(['project', 'location', 'imagery', 'editor', 'siding', 'report'] as Step[]).map((s, i) => {
          const reached =
            (s === 'project') ||
            (s === 'location' && !!projectId) ||
            (s === 'imagery' && !!location) ||
            (s === 'editor' && !!imagery && imagery.status !== 'unavailable') ||
            (s === 'siding' && !!runId) ||
            (s === 'report' && !!runId && facets.length > 0)
          return (
            <button
              key={s}
              onClick={() => reached && setStep(s)}
              disabled={!reached}
              className={`rounded-full px-3 py-1.5 transition ${
                step === s ? 'bg-blue-600 text-white'
                  : reached ? 'bg-slate-800 text-slate-200 hover:bg-slate-700'
                  : 'cursor-not-allowed bg-slate-900 text-slate-600'
              }`}
            >{i + 1}. {s}</button>
          )
        })}
      </nav>

      {error && (
        <div className="rounded-lg border border-rose-400/30 bg-rose-500/10 p-3 text-sm text-rose-200">
          {error}
        </div>
      )}

      {/* PROJECT step */}
      {step === 'project' && (
        <section className="space-y-4">
          {/* Quick start: create a new roofing project right here */}
          <div className="rounded-lg border border-emerald-400/30 bg-emerald-500/5 p-4">
            <h2 className="mb-2 text-sm font-semibold text-emerald-200">Quick start — new project</h2>
            <p className="mb-3 text-xs text-slate-400">
              Skip the Projects page. Just name your job (the property address or anything memorable)
              and start measuring. We'll create the project record automatically.
            </p>
            <QuickCreateProject
              userId={userId}
              busy={busy}
              onCreated={async (newProject) => {
                setProjects(prev => [newProject, ...prev])
                await pickProject(newProject.id)
              }}
              onError={(msg) => setError(msg)}
            />
          </div>

          {/* Existing projects */}
          <div className="rounded-lg border border-white/10 bg-slate-900/40 p-4">
            <h2 className="mb-3 text-sm font-semibold">Or pick an existing project</h2>
            {projects.length === 0 ? (
              <p className="text-xs text-slate-400">
                No existing projects. Use the quick-start form above to create your first one.
              </p>
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
          </div>
        </section>
      )}

      {/* LOCATION step */}
      {step === 'location' && (
        <section className="rounded-lg border border-white/10 bg-slate-900/40 p-4">
          <h2 className="mb-3 text-sm font-semibold">Validate property address</h2>
          <LocationPicker
            initialQuery={project ? [project.address, project.city, project.state, project.zip].filter(Boolean).join(', ') : ''}
            onSelected={onLocationSelected}
          />
        </section>
      )}

      {/* IMAGERY step */}
      {step === 'imagery' && (
        <section className="rounded-lg border border-white/10 bg-slate-900/40 p-4">
          <h2 className="mb-3 text-sm font-semibold">
            {busy ? 'Loading + sharpening satellite tile…' : 'Satellite imagery health'}
          </h2>
          {busy && !imagery && (
            <div className="flex items-center gap-3 rounded bg-slate-900/60 p-3 text-sm text-slate-300">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-blue-400 border-t-transparent" />
              <span>Fetching tile at zoom 22 + running AI 4x upscale… (~10 seconds)</span>
            </div>
          )}
          {imagery && (
            <>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Stat
                  label="Zoom (requested 22)"
                  value={imagery.zoom != null ? `z${imagery.zoom}` : '—'}
                  color={imagery.zoom === 22 ? 'text-emerald-300' : imagery.zoom && imagery.zoom < 22 ? 'text-amber-300' : undefined}
                />
                <Stat label="Status" value={imagery.status} color={
                  imagery.status === 'ok' ? 'text-emerald-300'
                  : imagery.status === 'degraded' ? 'text-amber-300'
                  : 'text-rose-300'
                }/>
                <Stat label="Provider" value={imagery.provider ?? '—'} />
                <Stat label="Health" value={`${Math.round((imagery.health_score ?? 0) * 100)}%`} />
                <Stat
                  label="Resolution"
                  value={`${imagery.feet_per_pixel?.toFixed(3) ?? '?'} ft/px`}
                  color={(imagery.warnings || []).some(w => w.includes('sharpened')) ? 'text-emerald-300' : undefined}
                />
              </div>
              {imagery.warnings.length > 0 && (
                <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-amber-300">
                  {imagery.warnings.map((w, i) => <li key={i} className={w.includes('sharpened') ? 'text-emerald-300' : ''}>{w}</li>)}
                </ul>
              )}

              {/* Main tile preview with corner keypad overlay for centering */}
              {imagery.url && imagery.status !== 'unavailable' && (
                <div className="relative mt-4 overflow-hidden rounded border border-white/10 bg-black">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={imagery.url}
                    alt="satellite tile preview"
                    className="block max-h-[500px] w-full object-contain"
                  />
                  {/* 4-arrow keypad overlay in top-right corner */}
                  <div className="absolute right-2 top-2 grid grid-cols-3 gap-0.5 rounded-md border border-white/20 bg-slate-900/85 p-1 shadow-lg backdrop-blur">
                    <div></div>
                    <button
                      onClick={() => nudgeImagery(0, 10)}
                      disabled={nudging}
                      title="Move view north (up)"
                      className="flex h-8 w-8 items-center justify-center rounded bg-slate-800 text-base text-white hover:bg-blue-600 disabled:opacity-50"
                    >↑</button>
                    <div></div>
                    <button
                      onClick={() => nudgeImagery(-10, 0)}
                      disabled={nudging}
                      title="Move view west (left)"
                      className="flex h-8 w-8 items-center justify-center rounded bg-slate-800 text-base text-white hover:bg-blue-600 disabled:opacity-50"
                    >←</button>
                    <div className="flex h-8 w-8 items-center justify-center text-[10px] text-slate-500" title="Each arrow click moves the view 10 metres">
                      {nudging ? <div className="h-3 w-3 animate-spin rounded-full border-2 border-blue-400 border-t-transparent" /> : '·'}
                    </div>
                    <button
                      onClick={() => nudgeImagery(10, 0)}
                      disabled={nudging}
                      title="Move view east (right)"
                      className="flex h-8 w-8 items-center justify-center rounded bg-slate-800 text-base text-white hover:bg-blue-600 disabled:opacity-50"
                    >→</button>
                    <div></div>
                    <button
                      onClick={() => nudgeImagery(0, -10)}
                      disabled={nudging}
                      title="Move view south (down)"
                      className="flex h-8 w-8 items-center justify-center rounded bg-slate-800 text-base text-white hover:bg-blue-600 disabled:opacity-50"
                    >↓</button>
                    <div></div>
                  </div>
                  <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-black/70 px-2 py-1 text-[10px] text-white">
                    Use arrows to center the house · each click = 10 m
                  </div>
                </div>
              )}

              {/* A/B comparison toggle when sharpening succeeded */}
              {imagery.sharpened_url && imagery.original_url && (
                <div className="mt-4 rounded-lg border border-emerald-400/30 bg-emerald-500/5 p-3">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <div className="text-xs font-semibold text-emerald-200">
                      Verify sharpening visually — toggle between the two:
                    </div>
                    <div className="flex gap-2 text-xs">
                      <button
                        onClick={() => setImagery(prev => prev ? ({
                          ...prev,
                          url: prev.original_url,
                          display_mode: 'original',
                        }) : prev)}
                        className={`rounded px-3 py-1.5 font-medium transition ${
                          imagery.display_mode === 'original'
                            ? 'bg-slate-700 text-white ring-2 ring-blue-400'
                            : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                        }`}
                      >Original</button>
                      <button
                        onClick={() => setImagery(prev => prev ? ({
                          ...prev,
                          url: prev.sharpened_url,
                          display_mode: 'sharpened',
                        }) : prev)}
                        className={`rounded px-3 py-1.5 font-medium transition ${
                          imagery.display_mode === 'sharpened'
                            ? 'bg-emerald-700 text-white ring-2 ring-emerald-400'
                            : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                        }`}
                      >✨ Sharpened</button>
                    </div>
                  </div>
                  {/* Preview the currently-selected tile */}
                  {imagery.url && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={imagery.url}
                      alt="tile preview"
                      className="block max-h-[400px] w-full rounded border border-white/10 bg-black object-contain"
                    />
                  )}
                  <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-slate-400">
                    <a href={imagery.original_url} target="_blank" rel="noreferrer" className="underline hover:text-slate-200">
                      Open original in new tab ↗
                    </a>
                    <span>·</span>
                    <a href={imagery.sharpened_url} target="_blank" rel="noreferrer" className="underline hover:text-slate-200">
                      Open sharpened in new tab ↗
                    </a>
                    <span>·</span>
                    <span>
                      Click both, switch between tabs to A/B compare at full resolution
                    </span>
                  </div>
                </div>
              )}
              {imagery.url && imagery.status !== 'unavailable' && (
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <button
                    onClick={startRun}
                    disabled={busy}
                    className="flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm text-white transition hover:bg-blue-500 disabled:opacity-60"
                  >
                    {busy ? (
                      <>
                        <div className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
                        <span>Opening editor…</span>
                      </>
                    ) : (
                      <>Open facet editor →</>
                    )}
                  </button>
                  {!imagery.sharpened_url && (
                    <button
                      onClick={trySharpening}
                      disabled={sharpening || busy}
                      className="flex items-center gap-2 rounded-md bg-purple-700 px-3 py-2 text-xs text-white transition hover:bg-purple-600 disabled:opacity-50"
                      title="Optional: try AI sharpening on top of the native @2x retina tile. Takes 15-30 sec."
                    >
                      {sharpening ? (
                        <>
                          <div className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
                          <span>Sharpening…</span>
                        </>
                      ) : (
                        <>✨ Try AI sharpening (optional)</>
                      )}
                    </button>
                  )}
                </div>
              )}
              {imagery.status === 'unavailable' && (
                <div className="mt-3 text-xs text-rose-300">
                  All satellite providers failed. Configure MAPBOX_ACCESS_TOKEN or MAPTILER_API_KEY on the backend, or use manual measurement via blueprint upload.
                </div>
              )}
            </>
          )}
        </section>
      )}

      {/* EDITOR step */}
      {step === 'editor' && imagery?.url && runId && (
        <section className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-white/10 bg-slate-900/60 p-2 text-xs">
            <span className="text-slate-400">Tile:</span>
            <span className="font-mono text-slate-200">
              {imagery.provider} · z{imagery.zoom} · {imagery.feet_per_pixel?.toFixed(3)} ft/px
            </span>
            {(imagery.warnings || []).some(w => w.includes('sharpened')) && (
              <span className="rounded bg-emerald-500/20 px-2 py-0.5 text-emerald-300">
                ✨ AI-sharpened
              </span>
            )}
          </div>
          <div className="h-[680px]">
            <RoofFacetEditor
              imageUrl={imagery.url}
              imageWidthPx={imagery.width_px ?? 2048}
              imageHeightPx={imagery.height_px ?? 1366}
              initialFacets={facets}
              initialEdges={edges}
              onChange={onEditorChange}
              onNudge={nudgeImagery}
              nudging={nudging}
            />
          </div>
          <MeasurementsSummary
            runId={runId}
            geometryStamp={geometryStamp}
            onConfidenceChange={setConfidence}
            onForceSave={async () => { await persistGeometry(facets, edges) }}
          />
          <FacetSuggestions
            runId={runId}
            imageUrl={imagery?.url ?? ''}
            existingFacets={facets}
            onAccept={(newFacet) => {
              const merged = [...facets, newFacet]
              setFacets(merged)
              // Initialize this facet's edges as unlabeled in the editor state
              const newEdges: typeof edges = newFacet.polygon.map((_, i) => ({
                facetLabel: newFacet.label,
                vertexIndexStart: i,
                vertexIndexEnd: (i + 1) % newFacet.polygon.length,
                edgeType: 'unlabeled' as const,
                userConfirmed: false,
              }))
              const mergedEdges = [...edges, ...newEdges]
              setEdges(mergedEdges)
              void persistGeometry(merged, mergedEdges)
            }}
          />
          {facets.length > 0 && (
            <EdgeLabelSuggestions
              runId={runId}
              facets={facets}
              edges={edges}
              onAcceptEdges={(updatedEdges) => {
                setEdges(updatedEdges)
                void persistGeometry(facets, updatedEdges)
              }}
            />
          )}
          <PenetrationSuggestions runId={runId} imageUrl={imagery?.url} />
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setStep('siding')}
              className="rounded bg-slate-700 px-3 py-1.5 text-xs text-slate-100 hover:bg-slate-600"
            >Skip to siding →</button>
            <button
              onClick={() => setStep('report')}
              disabled={facets.length === 0}
              className="rounded bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-500 disabled:opacity-50"
            >Continue to report →</button>
          </div>
        </section>
      )}

      {/* SIDING step */}
      {step === 'siding' && projectId && (
        <section className="space-y-4">
          <SidingMeasurementTool projectId={projectId} />
          <button
            onClick={() => setStep('report')}
            className="rounded bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-500"
          >Continue to report →</button>
        </section>
      )}

      {/* REPORT step */}
      {step === 'report' && runId && imagery && (
        <>
          {/* EagleView-style annotated 2D */}
          <AnnotatedRoofView
            imageUrl={imagery.url ?? ''}
            imageWidthPx={imagery.width_px ?? 2048}
            imageHeightPx={imagery.height_px ?? 1366}
            facets={facets}
            edges={edges}
          />

          {/* 3D viewer */}
          <RoofViewer3D
            facets={facets}
            edges={edges}
            lat={location?.lat ?? imagery.lat ?? 30.27}
            zoom={imagery.zoom ?? 20}
            imageWidthPx={imagery.width_px ?? 2048}
            imageHeightPx={imagery.height_px ?? 1366}
          />

          <section className="rounded-lg border border-white/10 bg-slate-900/40 p-4">
            <h2 className="mb-3 text-sm font-semibold">Confirm + download</h2>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Facets" value={facets.length.toString()} />
              <Stat label="Edges labeled" value={edges.filter(e => e.edgeType !== 'unlabeled').length.toString()} />
              <Stat label="Confidence" value={`${Math.round(confidence * 100)}%`} />
              <Stat label="Imagery" value={`${Math.round((imagery?.health_score ?? 0) * 100)}%`} />
            </div>
            <p className="mt-3 text-xs text-slate-400">
              Confirming locks the measurement run and generates a contractor-grade PDF report
              with all 8 sections. You can return and edit later — a confirmed run becomes
              unconfirmed if you change facets or edges.
            </p>
            <button
              onClick={confirmAndDownload}
              disabled={busy || facets.length === 0}
              className="mt-4 rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              {busy ? 'Generating…' : 'Confirm + download PDF report'}
            </button>
          </section>

          {/* APIR — the new 12-page contractor-grade PDF (replaces the
              8-section ReportLab output above once accuracy is verified). */}
          {projectId && (
            <ReportsPanel projectId={projectId} runId={runId ?? undefined} />
          )}
        </>
      )}
    </div>
  )
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-md border border-white/10 bg-slate-900/60 p-2 text-xs">
      <div className="text-slate-500">{label}</div>
      <div className={`text-sm font-semibold ${color ?? 'text-slate-100'}`}>{value}</div>
    </div>
  )
}

function QuickCreateProject({
  userId, busy, onCreated, onError,
}: {
  userId: string | null
  busy: boolean
  onCreated: (project: Project) => void | Promise<void>
  onError: (msg: string) => void
}) {
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)

  const submit = useCallback(async () => {
    if (!userId) {
      onError('Not signed in. Refresh and try again.')
      return
    }
    const trimmed = name.trim()
    if (trimmed.length < 2) {
      onError('Project name is too short — try the property address.')
      return
    }
    setCreating(true)
    try {
      const created = await api.projects.create(
        { name: trimmed, blueprint_type: 'residential' },
        userId,
      )
      setName('')
      await onCreated(created as Project)
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not create project')
    } finally {
      setCreating(false)
    }
  }, [userId, name, onCreated, onError])

  return (
    <div className="flex flex-wrap gap-2">
      <input
        type="text"
        placeholder="e.g., 123 Main St roof, or Smith residence"
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') void submit() }}
        disabled={creating || busy}
        className="min-w-[260px] flex-1 rounded bg-slate-900/80 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-emerald-400/60 focus:outline-none disabled:opacity-50"
      />
      <button
        onClick={() => void submit()}
        disabled={creating || busy || name.trim().length < 2}
        className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
      >{creating ? 'Creating…' : '+ Create and continue →'}</button>
    </div>
  )
}
