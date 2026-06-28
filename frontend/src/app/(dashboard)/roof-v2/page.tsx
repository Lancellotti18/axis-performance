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
 * The single contractor-facing roof measurement + report workflow
 * (the legacy /aerial-report v1 was removed).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import toast from 'react-hot-toast'
import { api } from '@/lib/api'
import { getUser } from '@/lib/auth'
import LocationPicker, { type LocationSelected } from '@/components/roof-v2/LocationPicker'
import RoofFacetEditor, { type Facet, type LabeledEdge } from '@/components/roof-v2/RoofFacetEditor'
import MeasurementsSummary from '@/components/roof-v2/MeasurementsSummary'
import PenetrationSuggestions from '@/components/roof-v2/PenetrationSuggestions'
import FacetSuggestions from '@/components/roof-v2/FacetSuggestions'
import EdgeLabelSuggestions from '@/components/roof-v2/EdgeLabelSuggestions'
import FlashingPanel from '@/components/roof-v2/FlashingPanel'
import WallTransitionPanel from '@/components/roof-v2/WallTransitionPanel'
import GroundPhotoPanel from '@/components/roof-v2/GroundPhotoPanel'
import CollapsibleSection from '@/components/roof-v2/CollapsibleSection'
import PreReportChecklist from '@/components/roof-v2/PreReportChecklist'
import ScaleCheckPanel from '@/components/roof-v2/ScaleCheckPanel'
import SolarAssistPanel from '@/components/roof-v2/SolarAssistPanel'
import HousePicker from '@/components/roof-v2/HousePicker'
import AnnotatedRoofView from '@/components/roof-v2/AnnotatedRoofView'
// RoofViewer3D temporarily disabled (geometry rebuild) — re-enable in REPORT step.
// import RoofViewer3D from '@/components/roof-v2/RoofViewer3D'
import SidingMeasurementTool from '@/components/roof-v2/SidingMeasurementTool'
import PannableImage from '@/components/roof-v2/PannableImage'
import { enhanceTile } from '@/lib/imageEnhance'

// AI super-resolution (Replicate) is retired from the contractor workflow —
// it never produced visible benefit and confused users. The real client-side
// "Clarity" enhancement replaces it. Flip this flag (or set
// NEXT_PUBLIC_FF_SHARPEN=true) to re-expose the experimental AI sharpen button.
const FF_AI_SHARPEN = process.env.NEXT_PUBLIC_FF_SHARPEN === 'true'

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

// Friendly stepper labels (the Step values stay the same for all the logic).
const STEP_LABELS: Record<Step, string> = {
  project: 'Project',
  location: 'Address',
  imagery: 'Locate roof',
  editor: 'Measure roof',
  siding: 'Siding',
  report: 'Report',
}

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
  const [editorSyncRev, setEditorSyncRev] = useState(0)   // bump to push external edits into the editor canvas
  const [autoLabelTrigger, setAutoLabelTrigger] = useState(0)   // editor toolbar → run edge auto-label
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
  const deleteProject = useCallback(async (id: string, name: string) => {
    if (!window.confirm(`Delete "${name}"? This permanently removes the project and its roof measurements.`)) return
    try {
      await api.projects.delete(id)
      setProjects(prev => prev.filter(p => p.id !== id))
      setProjectId(prev => {
        if (prev === id) { setProject(null); setRunId(null); setFacets([]); setEdges([]) }
        return prev === id ? null : prev
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete project')
    }
  }, [])

  const pickProject = useCallback(async (id: string) => {
    setProjectId(id)
    setError(null)
    setBusy(true)
    try {
      const p = await api.projects.get(id)
      setProject(p as Project)

      // RESUME: if this project already has a saved run, reload the roof
      // (facets/edges + imagery) and jump straight to the editor.
      try {
        const { run_id } = await api.roofing.v2.latestRun(id)
        if (run_id) {
          const data = await api.roofing.v2.getRun(run_id)
          const run = data.run as Record<string, unknown>
          const url = (run.satellite_image_url as string) || ''
          if (url) {
            const lat = Number(run.satellite_lat) || 0
            const lng = Number(run.satellite_lng) || 0
            const zoom = Number(run.satellite_zoom) || 20
            const mpp = 156543.03392 * Math.cos((lat * Math.PI) / 180) / Math.pow(2, zoom)
            setImagery({
              status: 'ok', health_score: 1, warnings: [], providers_tried: [],
              url, original_url: url, width_px: 2048, height_px: 1366,
              lat, lng, zoom, feet_per_pixel: mpp * 3.28084, display_mode: 'original',
            } as ImageryPayload)
            setLocation({ lat, lng } as LocationSelected)

            const byId: Record<string, string> = {}
            const fcts: Facet[] = (data.facets as Record<string, unknown>[]).map(f => {
              byId[f.id as string] = f.facet_label as string
              return {
                label: (f.facet_label as string) || '?',
                polygon: (f.polygon as [number, number][]) || [],
                pitch: (f.pitch as string) || '6/12',
                confidence: (f.confidence as number) ?? 0.8,
                userConfirmed: !!f.user_confirmed,
                aiSuggested: !!f.ai_suggested,
              }
            })
            const edgs: LabeledEdge[] = (data.edges as Record<string, unknown>[]).map(e => ({
              facetLabel: byId[e.facet_id as string] || '',
              vertexIndexStart: e.vertex_index_start as number,
              vertexIndexEnd: e.vertex_index_end as number,
              edgeType: (e.edge_type as LabeledEdge['edgeType']) || 'unlabeled',
              userConfirmed: !!e.user_confirmed,
              sharedWithFacetLabel: e.shared_with_facet ? (byId[e.shared_with_facet as string] || undefined) : undefined,
            })).filter(e => e.facetLabel)

            setRunId(run_id)
            setFacets(fcts)
            setEdges(edgs)
            setGeometryStamp(s => s + 1)
            setEditorSyncRev(r => r + 1)
            setStep('editor')
            setBusy(false)
            return
          }
        }
      } catch {
        // Resume is best-effort — fall through to a fresh start below.
      }

      const addr = [(p as Project).address, (p as Project).city, (p as Project).state, (p as Project).zip].filter(Boolean).join(', ')
      if (addr) {
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

  // ── Clarity enhancement (client-side, instant, no hallucination) ──────────
  // Replaces AI sharpen. Boosts local contrast + sharpens edges so roof planes
  // and ridge/valley lines are easier to see and trace. ON by default.
  const [clarityOn, setClarityOn] = useState(true)
  const [enhancing, setEnhancing] = useState(false)
  const [enhanceError, setEnhanceError] = useState<string | null>(null)
  const enhancedRevokeRef = useRef<null | (() => void)>(null)

  // Re-run enhancement whenever the source tile changes or the toggle flips.
  // Keyed on original_url (NOT url) so our own setImagery(url=...) doesn't loop.
  useEffect(() => {
    const sourceUrl = imagery?.original_url
    if (!sourceUrl || imagery?.status === 'unavailable') return

    // Off → show the original, drop any enhanced blob.
    if (!clarityOn) {
      enhancedRevokeRef.current?.()
      enhancedRevokeRef.current = null
      setEnhanceError(null)
      setImagery(prev => (prev && prev.url !== prev.original_url
        ? { ...prev, url: prev.original_url, display_mode: 'original' }
        : prev))
      return
    }

    let cancelled = false
    setEnhancing(true)
    setEnhanceError(null)
    // Strong settings so the difference is OBVIOUS — local-contrast clarity +
    // detail sharpen + a contrast stretch. This makes plane boundaries and
    // ridge/valley lines pop on hazy tiles (it can't add detail that wasn't
    // captured, but it surfaces what IS there).
    enhanceTile(sourceUrl, {
      clarity: 1.0,
      sharpness: 0.7,
      contrastStretch: 0.015,
      edgeOverlay: false,
    })
      .then(res => {
        if (cancelled) { res.revoke(); return }
        enhancedRevokeRef.current?.()
        enhancedRevokeRef.current = res.revoke
        setImagery(prev => (prev ? { ...prev, url: res.url, display_mode: 'sharpened' } : prev))
      })
      .catch(err => {
        // Surface the failure instead of silently doing nothing — otherwise
        // the toggle looks broken.
        console.warn('[axis] clarity enhancement failed, using original tile:', err)
        if (!cancelled) {
          setEnhanceError('Could not enhance this tile (the image could not be read). Showing the original.')
          setImagery(prev => (prev ? { ...prev, url: prev.original_url, display_mode: 'original' } : prev))
        }
      })
      .finally(() => { if (!cancelled) setEnhancing(false) })

    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imagery?.original_url, clarityOn])

  // Revoke any outstanding blob URL on unmount.
  useEffect(() => () => { enhancedRevokeRef.current?.() }, [])

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

  // Auto-center: ask Gemini for the subject building's bbox, then re-fetch the
  // tile centered + zoomed on the roof. One-shot, best-effort — failures just
  // leave the geocoded framing in place. Also exposed as a manual "Center on
  // house" button for when the contractor wants to re-run it.
  const [, setAutoCentering] = useState(false)   // kept for background auto-frame; manual button removed
  const autoCenterAttempted = useRef(false)
  const autoCenterOnHouse = useCallback(async (loc: LocationSelected, manual = false) => {
    if (!loc || (loc.lat === 0 && loc.lng === 0)) return
    setAutoCentering(true)
    try {
      // Detect at a WIDE zoom (20) so the whole building + surroundings are in
      // frame — at z22 the roof fills the tile and there's nothing to locate
      // against, so detection silently no-op'd ("button does nothing").
      const det = await api.roofing.v2.detectBuilding(loc.lat, loc.lng, 20, 2048, 1366)
      if (det.found && det.recenter) {
        const newLoc: LocationSelected = { ...loc, lat: det.recenter.lat, lng: det.recenter.lng }
        setLocation(newLoc)
        const zoom = det.suggested_zoom ?? 21
        const health = await api.roofing.v2.imageryHealth(newLoc.lat, newLoc.lng, zoom, 2048, 1366) as ImageryPayload
        setImagery({ ...health, original_url: health.url, url: health.url, display_mode: 'original' })
        if (manual) toast.success('Centered + zoomed on the house')
      } else if (manual) {
        toast('Couldn’t find the building automatically — keeping the current view.', { icon: '🛈' })
      }
    } catch (err) {
      console.warn('[axis] auto-center failed (keeping geocoded framing):', err)
      if (manual) toast.error('Auto-center failed — keeping the current view.')
    } finally {
      setAutoCentering(false)
    }
  }, [])

  const onLocationSelected = useCallback(async (loc: LocationSelected) => {
    setLocation(loc)
    setStep('imagery')
    autoCenterAttempted.current = false
    if (loc.lat === 0 && loc.lng === 0) {
      setImagery({ status: 'unavailable', providers_tried: [], warnings: ['Manual address entry — no coordinates available for imagery.'], health_score: 0 })
      return
    }
    setBusy(true)
    setError(null)
    try {
      // Zoom 22 + 2048x1366 request → MapTiler @2x retina returns 4096x2732
      // native pixels at the same ~38m x 25m ground area — real native
      // resolution, not AI hallucination. Backend falls back z22→z21→z20 if
      // the provider lacks coverage at that location.
      const health = await api.roofing.v2.imageryHealth(loc.lat, loc.lng, 22, 2048, 1366) as ImageryPayload
      setImagery({ ...health, original_url: health.url, display_mode: 'original' })
      setBusy(false)
      // Auto-center on the roof once, in the background, after first paint.
      if (!autoCenterAttempted.current && health.status !== 'unavailable') {
        autoCenterAttempted.current = true
        void autoCenterOnHouse(loc)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Imagery health check failed')
      setBusy(false)
    }
  }, [autoCenterOnHouse])

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
        // Persist the ORIGINAL provider URL, never the client-side enhanced
        // blob: URL (blob URLs are session-only and useless server-side for
        // the report hero image + vision calls). Display uses the enhanced
        // version; storage + measurement scale use the original.
        satellite_image_url: imagery.original_url || imagery.url,
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
          ai_suggested: !!f.aiSuggested,
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

      {/* Stepper — sticky so it stays visible while scrolling the editor.
          Completed steps (before the current one) show a checkmark. */}
      {(() => {
        const order: Step[] = ['project', 'location', 'imagery', 'editor', 'siding', 'report']
        const currentIdx = order.indexOf(step)
        return (
          <nav className="sticky top-0 z-20 -mx-6 flex flex-wrap items-center gap-1.5 border-b border-white/10 bg-slate-950/85 px-6 py-2 text-xs backdrop-blur">
            {order.map((s, i) => {
              const reached =
                (s === 'project') ||
                (s === 'location' && !!projectId) ||
                (s === 'imagery' && !!location) ||
                (s === 'editor' && !!imagery && imagery.status !== 'unavailable') ||
                (s === 'siding' && !!runId) ||
                (s === 'report' && !!runId && facets.length > 0)
              const completed = reached && i < currentIdx
              return (
                <span key={s} className="flex items-center gap-1.5">
                  {i > 0 && <span className={`h-px w-4 ${completed || i <= currentIdx ? 'bg-blue-500/50' : 'bg-slate-700'}`} />}
                  <button
                    onClick={() => reached && setStep(s)}
                    disabled={!reached}
                    className={`flex items-center gap-1 rounded-full px-3 py-1.5 transition ${
                      step === s ? 'bg-blue-600 text-white'
                        : completed ? 'bg-emerald-900/40 text-emerald-300 hover:bg-emerald-900/60'
                        : reached ? 'bg-slate-800 text-slate-200 hover:bg-slate-700'
                        : 'cursor-not-allowed bg-slate-900 text-slate-600'
                    }`}
                  >
                    <span>{completed ? '✓' : i + 1}.</span>
                    <span>{STEP_LABELS[s]}</span>
                  </button>
                </span>
              )
            })}
          </nav>
        )
      })()}

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
                    className="group relative rounded-md border border-white/10 bg-slate-800/40 p-3 text-sm transition hover:border-blue-400/40 hover:bg-blue-500/10"
                  >
                    <button
                      onClick={() => void deleteProject(p.id, p.name)}
                      title="Delete project"
                      className="absolute right-2 top-2 rounded px-1.5 py-0.5 text-xs text-slate-500 opacity-0 transition hover:bg-rose-600/30 hover:text-rose-300 group-hover:opacity-100"
                    >✕</button>
                    <div onClick={() => void pickProject(p.id)} className="cursor-pointer pr-5">
                      <div className="font-medium">{p.name}</div>
                      {p.address && (
                        <div className="text-xs text-slate-400">
                          {[p.address, p.city, p.state, p.zip].filter(Boolean).join(', ')}
                        </div>
                      )}
                      <div className="mt-1 text-[10px] text-blue-300/70">Click to open / resume →</div>
                    </div>
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
            {busy ? 'Loading satellite tile…' : 'Satellite imagery'}
          </h2>
          {busy && !imagery && (
            <div className="flex items-center gap-3 rounded bg-slate-900/60 p-3 text-sm text-slate-300">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-blue-400 border-t-transparent" />
              <span>Fetching highest-resolution tile (zoom 22 @2x retina)…</span>
            </div>
          )}
          {imagery && (
            <>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Stat
                  label="Zoom level"
                  value={imagery.zoom != null
                    ? (imagery.zoom >= 22 ? `z${imagery.zoom}` : `z${imagery.zoom} (max here)`)
                    : '—'}
                  color={imagery.zoom != null && imagery.zoom >= 22 ? 'text-emerald-300' : imagery.zoom != null && imagery.zoom < 22 ? 'text-amber-300' : undefined}
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

              {/* Clarity toggle — client-side local-contrast + sharpen so roof
                  plane boundaries are easier to see. Toggle off to A/B compare. */}
              {imagery.url && imagery.status !== 'unavailable' && (
                <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-white/10 bg-slate-900/60 p-3">
                  <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-slate-200">
                    <input
                      type="checkbox"
                      checked={clarityOn}
                      onChange={e => setClarityOn(e.target.checked)}
                      className="h-4 w-4 rounded border-slate-600 bg-slate-800"
                    />
                    Sharpen image
                    <span className="font-normal text-slate-500">(toggle off to compare)</span>
                  </label>
                  {enhancing && (
                    <span className="flex items-center gap-1.5 text-xs text-blue-300">
                      <div className="h-3 w-3 animate-spin rounded-full border-2 border-blue-400 border-t-transparent" />
                      sharpening…
                    </span>
                  )}
                  {!enhancing && clarityOn && imagery.display_mode === 'sharpened' && (
                    <span className="rounded bg-emerald-500/20 px-2 py-0.5 text-[10px] text-emerald-300">applied ✓</span>
                  )}
                  {enhanceError && (
                    <span className="text-[10px] text-amber-400">{enhanceError}</span>
                  )}
                  <span className="ml-auto text-[10px] text-slate-500">
                    Visual only — measurements use the original tile
                  </span>
                </div>
              )}

              {/* Instant pan/zoom preview — drag, scroll, arrows/WASD. You pick
                  the exact roof with "Tap your house" in the next step. */}
              {imagery.url && imagery.status !== 'unavailable' && (
                <div className="mt-3">
                  <PannableImage src={imagery.url} alt="satellite tile preview" />
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
                  {/* AI sharpen retired from the workflow — gated behind a flag
                      for experimentation only. Real clarity enhancement above
                      replaced it. */}
                  {FF_AI_SHARPEN && !imagery.sharpened_url && (
                    <button
                      onClick={trySharpening}
                      disabled={sharpening || busy}
                      className="flex items-center gap-2 rounded-md bg-purple-700 px-3 py-2 text-xs text-white transition hover:bg-purple-600 disabled:opacity-50"
                      title="Experimental: AI super-resolution via Replicate. Takes 15-30 sec."
                    >
                      {sharpening ? (
                        <>
                          <div className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
                          <span>Sharpening…</span>
                        </>
                      ) : (
                        <>✨ AI sharpen (experimental)</>
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
          <div className="h-[680px] overflow-hidden">
            <RoofFacetEditor
              imageUrl={imagery.url}
              imageWidthPx={imagery.width_px ?? 2048}
              imageHeightPx={imagery.height_px ?? 1366}
              initialFacets={facets}
              initialEdges={edges}
              onChange={onEditorChange}
              syncRev={editorSyncRev}
              onAutoLabelEdges={() => {
                setAutoLabelTrigger(t => t + 1)
                setTimeout(() => document.getElementById('edge-label-panel')
                  ?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50)
              }}
            />
          </div>
          <MeasurementsSummary
            runId={runId}
            geometryStamp={geometryStamp}
            onConfidenceChange={setConfidence}
            onForceSave={async () => { await persistGeometry(facets, edges) }}
          />

          {/* Auto-label edges sits right after the outline: draw your facets, then
              one click labels every edge (eave/rake/ridge/hip/valley) — review and
              accept, or label by hand in the editor above. */}
          {facets.length > 0 && (
            <div id="edge-label-panel" className="scroll-mt-16">
              <EdgeLabelSuggestions
                runId={runId}
                facets={facets}
                edges={edges}
                imageUrl={imagery?.original_url || imagery?.url}
                imageWidthPx={imagery?.width_px ?? 2048}
                imageHeightPx={imagery?.height_px ?? 1366}
                trigger={autoLabelTrigger}
                onAcceptEdges={async (updatedEdges) => {
                  setEdges(updatedEdges)
                  setEditorSyncRev(r => r + 1)   // show the labels on the editor canvas
                  // Persist FIRST, then bump geometryStamp so MeasurementsSummary
                  // refetches against the saved edges — otherwise accepting labels
                  // left the measurements + material order stale (only the
                  // previously-saved ridges showed).
                  await persistGeometry(facets, updatedEdges)
                  setGeometryStamp(s => s + 1)
                }}
              />
            </div>
          )}

          {/* Tap your house FIRST so auto-detect locks onto the right building. */}
          {imagery?.url && (
            <HousePicker
              runId={runId}
              imageUrl={imagery.url}
              lat={imagery.lat ?? location?.lat}
              lng={imagery.lng ?? location?.lng}
              address={project ? [project.address, project.city, project.state, project.zip].filter(Boolean).join(', ') : undefined}
            />
          )}

          {/* Guided workflow — recommended top-to-bottom order. The editor above
              is always your manual canvas; reject any AI suggestion and draw by hand. */}
          <div className="rounded-lg border border-blue-400/20 bg-blue-500/5 p-3 text-xs text-blue-200">
            <strong>Guided steps</strong> — work top to bottom for the best accuracy. The{' '}
            <strong>editor above is always your manual fallback</strong>: reject any AI suggestion
            and draw the facet by hand with all the same measurements.
          </div>

          <CollapsibleSection
            title="① Ground photos — start here"
            subtitle="Reads pitch, chimneys/skylights, dormers, roof shape & materials. Feeds pitch + a count check into auto-detect below — so do this first."
            badge="step 1"
            defaultOpen
          >
          {runId && (
            <GroundPhotoPanel
              runId={runId}
              onApplyPitch={(pitch) => {
                if (facets.length === 0) return false
                const updated = facets.map(f => ({ ...f, pitch }))
                setFacets(updated)
                setGeometryStamp(s => s + 1)   // force MeasurementsSummary to recompute
                setEditorSyncRev(r => r + 1)
                void persistGeometry(updated, edges)
                return true
              }}
              onChimneyAdded={() => setGeometryStamp(s => s + 1)}
            />
          )}
          </CollapsibleSection>

          <CollapsibleSection
            title="② Auto-detect the roof"
            subtitle="Google Solar (measured pitch) + AI tracing propose facets. Accept the good ones; reject the rest and draw them by hand in the editor above. The scale check confirms the measurements are trustworthy."
            badge="step 2"
            defaultOpen
          >
          {runId && imagery?.lat != null && imagery?.lng != null && (
            <SolarAssistPanel
              runId={runId}
              centerLat={imagery.lat}
              centerLng={imagery.lng}
              imageWidthPx={imagery.width_px ?? 2048}
              imageHeightPx={imagery.height_px ?? 1366}
              feetPerPixel={imagery.feet_per_pixel ?? 0}
              existingFacetCount={facets.length}
              onAddFacets={(newFacets) => {
                const merged = [...facets, ...newFacets]
                setFacets(merged)
                const newEdges: typeof edges = newFacets.flatMap(nf =>
                  nf.polygon.map((_, i) => ({
                    facetLabel: nf.label,
                    vertexIndexStart: i,
                    vertexIndexEnd: (i + 1) % nf.polygon.length,
                    edgeType: 'unlabeled' as const,
                    userConfirmed: false,
                  })),
                )
                const mergedEdges = [...edges, ...newEdges]
                setEdges(mergedEdges)
                setEditorSyncRev(r => r + 1)
                void persistGeometry(merged, mergedEdges)
              }}
            />
          )}
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
              setEditorSyncRev(r => r + 1)
              void persistGeometry(merged, mergedEdges)
            }}
          />
          {runId && imagery?.url && (
            <ScaleCheckPanel
              runId={runId}
              imageUrl={imagery.original_url || imagery.url}
              imageWidthPx={imagery.width_px ?? 2048}
              imageHeightPx={imagery.height_px ?? 1366}
              feetPerPixel={imagery.feet_per_pixel ?? 0}
            />
          )}
          </CollapsibleSection>

          <CollapsibleSection
            title="③ Penetrations"
            subtitle="Add chimneys, skylights, and vents — these drive flashing and the final report. (Edge labels are handled right under the outline above.)"
            badge="step 3"
          >
          <PenetrationSuggestions runId={runId} imageUrl={imagery?.url} />
          </CollapsibleSection>

          <CollapsibleSection
            title="④ Flashing"
            subtitle="Roof-to-wall transitions (corroborated by your ground photos) + chimney/skylight flashing, computed from the labeled edges above."
            badge="step 4"
          >
          {runId && (
            <WallTransitionPanel
              runId={runId}
              facets={facets}
              edges={edges}
              imageUrl={imagery?.original_url || imagery?.url}
              imageWidthPx={imagery?.width_px ?? 2048}
              imageHeightPx={imagery?.height_px ?? 1366}
              onApplyEdges={(updated) => {
                setEdges(updated)
                setEditorSyncRev(r => r + 1)
                void persistGeometry(facets, updated)
              }}
            />
          )}
          {runId && <FlashingPanel runId={runId} />}
          </CollapsibleSection>
          {runId && <PreReportChecklist runId={runId} facets={facets} edges={edges} />}
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
          <div className="rounded-lg border border-white/10 bg-slate-900/50 p-3 text-xs text-slate-300">
            <span className="mr-2 rounded-full bg-slate-700 px-2 py-0.5 text-[10px] font-semibold text-slate-200">Optional</span>
            <strong>Siding</strong> measures exterior wall square footage from elevation photos — for
            quoting <strong>siding replacement, house-wrap, or exterior paint</strong>, or insurance/exterior
            scopes. Skip it if this job is roof-only.
            <button
              onClick={() => setStep('report')}
              className="ml-2 underline hover:text-white"
            >Skip to report →</button>
          </div>
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
          {/* EagleView-style annotated 2D — use the full-res original tile */}
          <AnnotatedRoofView
            imageUrl={imagery.original_url || imagery.url || ''}
            imageWidthPx={imagery.width_px ?? 2048}
            imageHeightPx={imagery.height_px ?? 1366}
            facets={facets}
            edges={edges}
          />

          {/* 3D viewer — temporarily hidden (geometry rebuild in progress).
              Component kept; re-enable when the connected-mesh version is ready.
          <RoofViewer3D
            facets={facets}
            edges={edges}
            lat={location?.lat ?? imagery.lat ?? 30.27}
            zoom={imagery.zoom ?? 20}
            imageWidthPx={imagery.width_px ?? 2048}
            imageHeightPx={imagery.height_px ?? 1366}
          /> */}

          <section className="rounded-lg border border-white/10 bg-slate-900/40 p-4">
            <h2 className="mb-3 text-sm font-semibold">Confirm + download</h2>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Facets" value={facets.length.toString()} />
              <Stat label="Edges labeled" value={edges.filter(e => e.edgeType !== 'unlabeled').length.toString()} />
              <Stat label="Confidence" value={`${Math.round(confidence * 100)}%`} />
              <Stat label="Imagery" value={`${Math.round((imagery?.health_score ?? 0) * 100)}%`} />
            </div>
            <p className="mt-3 text-xs text-slate-400">
              Generates the contractor-grade PDF — cover, <strong>to-scale roof diagram</strong>, roof
              summary &amp; per-facet table, roof-line lengths, flashing &amp; penetrations, materials
              takeoff, waste calculator, siding (if measured), and methodology. Every number is pulled
              from your traced roof — nothing estimated or fabricated. You can return and edit later.
            </p>
            <button
              onClick={confirmAndDownload}
              disabled={busy || facets.length === 0}
              className="mt-4 rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              {busy ? 'Generating…' : 'Confirm + download PDF report'}
            </button>
          </section>
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
