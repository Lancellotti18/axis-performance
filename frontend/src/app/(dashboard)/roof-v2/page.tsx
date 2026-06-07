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
import AnnotatedRoofView from '@/components/roof-v2/AnnotatedRoofView'
import RoofViewer3D from '@/components/roof-v2/RoofViewer3D'
import SidingMeasurementTool from '@/components/roof-v2/SidingMeasurementTool'

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
}

type Step = 'project' | 'location' | 'imagery' | 'editor' | 'siding' | 'report'

export default function RoofV2Page() {
  const router = useRouter()
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
        const res = await api.projects.list(u.id)
        if (!cancelled) setProjects(res as Project[])
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load projects')
      }
    })()
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

  // When a location is confirmed
  const onLocationSelected = useCallback(async (loc: LocationSelected) => {
    setLocation(loc)
    setStep('imagery')
    if (loc.lat === 0 && loc.lng === 0) {
      // Manual entry — no imagery possible without coords
      setImagery({ status: 'unavailable', providers_tried: [], warnings: ['Manual address entry — no coordinates available for imagery.'], health_score: 0 })
      return
    }
    setBusy(true)
    setError(null)
    try {
      const health = await api.roofing.v2.imageryHealth(loc.lat, loc.lng) as ImageryPayload
      setImagery(health)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Imagery health check failed')
    } finally {
      setBusy(false)
    }
  }, [])

  // Create a measurement run + advance to editor
  const startRun = useCallback(async () => {
    if (!projectId || !location || !imagery || !imagery.url) {
      setError('Missing project, location, or imagery.')
      return
    }
    setBusy(true)
    setError(null)
    try {
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
      setRunId(run.id)
      setStep('editor')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start measurement run')
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
      {step === 'imagery' && imagery && (
        <section className="rounded-lg border border-white/10 bg-slate-900/40 p-4">
          <h2 className="mb-3 text-sm font-semibold">Satellite imagery health</h2>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Status" value={imagery.status} color={
              imagery.status === 'ok' ? 'text-emerald-300'
              : imagery.status === 'degraded' ? 'text-amber-300'
              : 'text-rose-300'
            }/>
            <Stat label="Provider" value={imagery.provider ?? '—'} />
            <Stat label="Health" value={`${Math.round((imagery.health_score ?? 0) * 100)}%`} />
            <Stat label="Resolution" value={`${imagery.feet_per_pixel?.toFixed(2) ?? '?'} ft/px`} />
          </div>
          {imagery.warnings.length > 0 && (
            <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-amber-300">
              {imagery.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}
          {imagery.url && imagery.status !== 'unavailable' && (
            <div className="mt-3">
              <button
                onClick={startRun}
                disabled={busy}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-500 disabled:opacity-50"
              >Open facet editor →</button>
            </div>
          )}
          {imagery.status === 'unavailable' && (
            <div className="mt-3 text-xs text-rose-300">
              All satellite providers failed. Configure MAPBOX_ACCESS_TOKEN or MAPTILER_API_KEY on the backend, or use manual measurement via blueprint upload.
            </div>
          )}
        </section>
      )}

      {/* EDITOR step */}
      {step === 'editor' && imagery?.url && runId && (
        <section className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-white/10 bg-slate-900/60 p-2 text-xs">
            <span className="text-slate-400">Tile:</span>
            <span className="font-mono text-slate-200">
              {imagery.provider} · z{imagery.zoom} · {imagery.feet_per_pixel?.toFixed(2)} ft/px
            </span>
            <button
              onClick={async () => {
                if (!imagery.url || busy) return
                setBusy(true)
                setError(null)
                try {
                  const res = await api.roofing.v2.upscaleImagery(imagery.url, 4) as {
                    status: string
                    upscaled_url?: string
                    error?: string
                  }
                  if (res.status === 'completed' && res.upscaled_url) {
                    setImagery({ ...imagery, url: res.upscaled_url, feet_per_pixel: (imagery.feet_per_pixel ?? 0) / 4 })
                  } else if (res.status === 'disabled') {
                    setError(res.error || 'Sharpener disabled. Set REPLICATE_API_KEY on the backend.')
                  } else {
                    setError(res.error || 'Sharpen failed.')
                  }
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'Sharpen failed')
                } finally {
                  setBusy(false)
                }
              }}
              disabled={busy}
              className="ml-auto rounded bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-500 disabled:opacity-50"
              title="AI 4x super-resolution via Replicate Real-ESRGAN"
            >{busy ? 'Sharpening…' : 'Sharpen tile (AI 4x)'}</button>
          </div>
          <div className="h-[680px]">
            <RoofFacetEditor
              imageUrl={imagery.url}
              imageWidthPx={imagery.width_px ?? 2048}
              imageHeightPx={imagery.height_px ?? 1366}
              initialFacets={facets}
              initialEdges={edges}
              onChange={onEditorChange}
            />
          </div>
          <MeasurementsSummary
            runId={runId}
            geometryStamp={geometryStamp}
            onConfidenceChange={setConfidence}
          />
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
