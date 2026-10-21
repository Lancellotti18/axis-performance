'use client'

/**
 * Axis Roofing Performance — Roof v2 (per-facet measurement workflow).
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
import { api, ApiError, describeReportQueue } from '@/lib/api'
import { getUser } from '@/lib/auth'
import { useRegisterChatContext } from '@/lib/chat-context'
import LocationPicker, { type LocationSelected } from '@/components/roof-v2/LocationPicker'
import RoofFacetEditor, { type Facet, type LabeledEdge, type ExcludedFacet } from '@/components/roof-v2/RoofFacetEditor'
import { edgeReviewCounts } from '@/components/roof-v2/edgeGeometry'
import MeasurementsSummary from '@/components/roof-v2/MeasurementsSummary'
import PenetrationSuggestions from '@/components/roof-v2/PenetrationSuggestions'
import EdgeLabelSuggestions from '@/components/roof-v2/EdgeLabelSuggestions'
import FlashingPanel from '@/components/roof-v2/FlashingPanel'
import WallTransitionPanel from '@/components/roof-v2/WallTransitionPanel'
import GroundPhotoPanel from '@/components/roof-v2/GroundPhotoPanel'
import CollapsibleSection from '@/components/roof-v2/CollapsibleSection'
import JobVerificationPanel from '@/components/roof-v2/JobVerificationPanel'
import ProposalPanel from '@/components/roof-v2/ProposalPanel'
import AdjusterModePanel from '@/components/roof-v2/AdjusterModePanel'
import ClientPortalPanel from '@/components/roof-v2/ClientPortalPanel'
import PreReportChecklist from '@/components/roof-v2/PreReportChecklist'
import ScaleCheckPanel from '@/components/roof-v2/ScaleCheckPanel'
import HousePicker from '@/components/roof-v2/HousePicker'
import { fracToGeo, geoToFrac } from '@/components/roof-v2/SolarAssistPanel'
import DrawStatusCard, { AddressMismatchBanner, plainNote } from '@/components/roof-v2/DrawStatusCard'
import AnnotatedRoofView from '@/components/roof-v2/AnnotatedRoofView'
// RoofViewer3D temporarily disabled (geometry rebuild) — re-enable in REPORT step.
// import RoofViewer3D from '@/components/roof-v2/RoofViewer3D'
import SidingMeasurementTool from '@/components/roof-v2/SidingMeasurementTool'
import PannableImage from '@/components/roof-v2/PannableImage'
import RoofScanSpinner from '@/components/roof-v2/RoofScanSpinner'

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

// Deferred while they are worked on. Both are fully built and their backends,
// data and report sections are untouched — this only takes them off the screen
// so the measure flow is not carrying half-finished tools. Flip to true to
// bring either back; nothing else needs changing.
const SHOW_FLASHING = false
// Also hides the whole 'On-site extras' stop — ground photos and the siding
// tool travel together, and neither is meant to be in the flow right now.
const SHOW_SIDING = false
// Xactimate line codes + RCV/ACV claim summary. Parked, not deleted — the
// endpoint, the estimator service and the report all stay wired.
const SHOW_ADJUSTER_MODE = false
// "Job verification" (enter the crew's real squares to build an accuracy stat)
// cluttered the report step and confused more than it helped (Ryan,
// 2026-10-20). Parked, not deleted; report branding stays editable in Settings.
const SHOW_JOB_VERIFICATION = false

// Saved facet/edge rows → the editor's geometry. Used by RESUME and by
// auto-measure, so both load a roof the same way (a stored auto-measurement IS
// a stored trace; there must be no second mapping to drift out of step).
function rowsToGeometry(facetRows: Record<string, unknown>[], edgeRows: Record<string, unknown>[]):
  { fcts: Facet[]; edgs: LabeledEdge[] } {
  const byId: Record<string, string> = {}
  const fcts: Facet[] = facetRows.map(f => {
    byId[f.id as string] = f.facet_label as string
    return {
      label: (f.facet_label as string) || '?',
      polygon: (f.polygon as [number, number][]) || [],
      pitch: (f.pitch as string) || '6/12',
      pitchSource: (f.pitch_source as string) || undefined,
      confidence: (f.confidence as number) ?? 0.8,
      userConfirmed: !!f.user_confirmed,
      aiSuggested: !!f.ai_suggested,
      // A measured facing survives re-saves only if it is carried back; the
      // server otherwise falls back to the longest edge's bearing.
      azimuthDeg: String(f.pitch_source || '').startsWith('solar_3d') && typeof f.orientation_deg === 'number'
        ? (f.orientation_deg as number) : undefined,
    }
  })
  const edgs: LabeledEdge[] = edgeRows.map(e => ({
    facetLabel: byId[e.facet_id as string] || '',
    vertexIndexStart: e.vertex_index_start as number,
    vertexIndexEnd: e.vertex_index_end as number,
    edgeType: (e.edge_type as LabeledEdge['edgeType']) || 'unlabeled',
    userConfirmed: !!e.user_confirmed,
    sharedWithFacetLabel: e.shared_with_facet ? (byId[e.shared_with_facet as string] || undefined) : undefined,
  })).filter(e => e.facetLabel)
  return { fcts, edgs }
}

// Two facets may never share a letter (the server keeps one row per letter).
function uniqueLetters(facets: Facet[], edges: LabeledEdge[]): { facets: Facet[]; edges: LabeledEdge[] } {
  const seen = new Set<string>()
  const dup = facets.some(f => (seen.has(f.label) ? true : (seen.add(f.label), false)))
  if (!dup) return { facets, edges }
  const used = new Set<string>()
  const all = new Set(facets.map(f => f.label))
  const next = () => {
    for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') if (!all.has(c) && !used.has(c)) return c
    for (let k = facets.length + 1; ; k++) if (!all.has(`F${k}`) && !used.has(`F${k}`)) return `F${k}`
  }
  const out = facets.map(f => {
    if (!used.has(f.label)) { used.add(f.label); return f }
    const l = next(); used.add(l)
    return { ...f, label: l }
  })
  return { facets: out, edges }
}

// Sections marked "Not roof", as the run stores them.
function rowsToExcluded(raw: unknown): ExcludedFacet[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((x: Record<string, unknown>) => {
    const label = String(x?.facet_label || '')
    const polygon = (x?.polygon as [number, number][]) || []
    if (!label || polygon.length < 3) return []
    const edges = Array.isArray(x.edges) ? (x.edges as Record<string, unknown>[]) : []
    return [{
      reason: String(x.reason || 'not_roof'),
      facet: { label, polygon, pitch: String(x.pitch || '6/12'), confidence: 0.8, userConfirmed: false },
      edges: edges.map(e => ({
        facetLabel: label,
        vertexIndexStart: Number(e.vertex_index_start) || 0,
        vertexIndexEnd: Number(e.vertex_index_end) || 0,
        edgeType: (String(e.edge_type || 'unlabeled')) as LabeledEdge['edgeType'],
        userConfirmed: false,
      })),
    }]
  })
}

type Step = 'project' | 'location' | 'imagery' | 'editor' | 'details' | 'siding' | 'report'

// Friendly stepper labels (the Step values stay the same for all the logic).
const STEP_LABELS: Record<Step, string> = {
  project: 'Project address',
  location: 'Address',
  imagery: 'Locate roof',
  editor: 'Measure roof',
  details: 'Details',
  // Everything that needs somebody standing at the property, gathered in one
  // optional stop rather than sprinkled through the desk workflow.
  siding: 'On-site extras',
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
  // `startRun` runs before persistGeometry is defined and must not re-create
  // itself every time the save closure changes — a ref keeps the wiring stable.
  const persistGeometryRef = useRef<((f: Facet[], e: LabeledEdge[], opts?: { keepalive?: boolean }) => Promise<void>) | null>(null)
  // Whether the contractor's work is actually on the server. Drawing is the
  // most expensive thing they do in this app; they should never have to guess.
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [runConfirmed, setRunConfirmed] = useState(false)   // a finalized roof shows its saved numbers without re-confirming edges
  const [facets, setFacets] = useState<Facet[]>([])
  const [edges, setEdges] = useState<LabeledEdge[]>([])
  // Sections marked "Not roof" (a tree or its shadow). Saved on the run, never
  // counted; the editor shows them greyed out with a Restore pill. The ref is
  // what a save reads, so a save started in the same tick as a change sees it.
  const [excludedFacets, setExcludedFacetsState] = useState<ExcludedFacet[]>([])
  const excludedRef = useRef<ExcludedFacet[]>([])
  const setExcludedFacets = useCallback((x: ExcludedFacet[]) => { excludedRef.current = x; setExcludedFacetsState(x) }, [])
  // The roof as of the latest change, for handlers that run before a re-render.
  const geomRef = useRef<{ facets: Facet[]; edges: LabeledEdge[] }>({ facets: [], edges: [] })
  geomRef.current = { facets, edges }
  // Counted in distinct roof LINES, not stored edge records — a shared line is
  // stored once per facet, so raw counts double it and the panel ends up asking
  // for confirmations the editor has nothing left to show.
  const edgeCounts = useMemo(() => edgeReviewCounts(facets, edges), [facets, edges])
  const [geometryStamp, setGeometryStamp] = useState(0)
  // Confirming edges kicks off a save, a recompute, a re-price and a
  // confidence recalculation. Without a visible busy state the numbers below
  // sit at their OLD values for a second or two — which reads as "nothing
  // happened", or worse, as the new values.
  const [applyingEdges, setApplyingEdges] = useState(false)
  const [editorSyncRev, setEditorSyncRev] = useState(0)   // bump to push external edits into the editor canvas
  // The contractor's confirmed "this is my house" tap. Loaded from the run on
  // resume; auto-analyze WAITS for it so we never draw the neighbor's roof.
  const [subjectPoint, setSubjectPoint] = useState<{ x: number; y: number } | null>(null)
  // That house's roof outline (fractions), drawn on the draw map so a hand
  // trace lands on the right house. From the picker, or re-fetched on reopen.
  const [houseOutline, setHouseOutline] = useState<{ x: number; y: number }[] | null>(null)
  const [savedScaleDesc, setSavedScaleDesc] = useState<string | null>(null)
  // Sub-steps inside the editor so the contractor sees ONE satellite image at a
  // time (confirm house → check scale → draw) and clicks Next, instead of
  // scrolling past several stacked tiles.
  const [editorSub, setEditorSub] = useState<'confirm' | 'scale' | 'draw'>('confirm')
  // Auto-measure from Google 3D. Offered only when the server says this account
  // has it (Ryan's rule: nobody else until 5 side-by-side comparisons pass).
  const [autoMeasureOn, setAutoMeasureOn] = useState(false)
  const [autoBusy, setAutoBusy] = useState(false)
  const [autoNote, setAutoNote] = useState<{
    ok: boolean; text: string; warnings: string[]
    // Google's 3D data was too old to trust on its own; the contractor may
    // still confirm the house is unchanged and measure anyway.
    staleDate?: string | null
  } | null>(null)
  // The roof on the map came from auto-measure in this session.
  const [measuredAuto, setMeasuredAuto] = useState(false)
  // Is the picked house the job's address? Checked the moment it is confirmed,
  // BEFORE anything is measured or drawn (Ryan, 2026-10-18).
  const [addressCheck, setAddressCheck] = useState<{ status: string; message: string | null } | null>(null)
  const [addressConfirmed, setAddressConfirmed] = useState(false)
  // The draw step's status card drives the editor, the labeler and the
  // measurements panel through these.
  const [editorCommand, setEditorCommand] = useState<{ kind: 'draw' | 'guide' | 'help'; n: number }>({ kind: 'draw', n: 0 })
  const [labelCommand, setLabelCommand] = useState<{ kind: 'suggest' | 'review' | 'confirmAll'; n: number }>({ kind: 'review', n: 0 })
  const [labelStatus, setLabelStatus] = useState<{ loading: boolean; error: string | null; aiLines: number }>({ loading: false, error: null, aiLines: 0 })
  const [reportConfirmReq, setReportConfirmReq] = useState(0)
  const [awaitingReportConfirm, setAwaitingReportConfirm] = useState(false)
  const [showingMeasurements, setShowingMeasurements] = useState(false)
  const [step, setStep] = useState<Step>('project')
  // Callbacks that chain into each other across a project being created a
  // moment earlier read these, not stale closures.
  const projectIdRef = useRef<string | null>(null)
  const openRunRef = useRef<(pid: string | null, img: ImageryPayload | null) => Promise<void>>(async () => {})
  const onLocationSelectedRef = useRef<(loc: LocationSelected, pid?: string) => Promise<void>>(async () => {})
  const [busy, setBusy] = useState(false)
  // "In line, 1 ahead of you" while the report waits for a build slot.
  const [reportQueueMsg, setReportQueueMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confidence, setConfidence] = useState<number>(0)
  // The backend caps confidence at 25% when the geometry is physically
  // impossible, and reports WHY. Showing the number without the reason leaves
  // the contractor to guess at a figure that is trying to warn them.
  const [blockingIssues, setBlockingIssues] = useState<string[]>([])
  const [partialSignals, setPartialSignals] = useState<string[]>([])

  // ── Tell AxisChat what is on this screen ──────────────────────────────────
  // The dashboard invites contractors to ask the assistant "why is this pitch
  // flagged?" and "what's missing from this report?". Neither was answerable:
  // this page published nothing, so the assistant ran with an empty context
  // and could only give a generic answer.
  //
  // Blocking issues are sent as the SAME sentence the contractor is reading on
  // screen, not the raw code — otherwise the assistant is asked to explain
  // `ridge_exceeds_perimeter` without knowing what it means either.
  const chatData = useMemo(() => ({
    address: location?.matched_address ?? project?.name ?? null,
    project_name: project?.name ?? null,
    step,
    run_id: runId,
    run_confirmed: runConfirmed,
    confidence_pct: Math.round(confidence * 100),
    // Present ⇒ confidence is capped and no report can be generated yet.
    blocking_issues: blockingIssues.map(code => ISSUE_TEXT[code] ?? code),
    partial_measurement_signals: partialSignals,
    imagery_health_pct: Math.round((imagery?.health_score ?? 0) * 100),
    facet_count: facets.length,
    // pitch_source is what makes "why is this pitch flagged?" answerable:
    // 'default' means nothing measured it and 6/12 was assumed.
    facets: facets.map(f => ({
      label: f.label,
      pitch: f.pitch,
      pitch_source: f.pitchSource ?? 'unknown',
      user_confirmed: f.userConfirmed,
      confidence_pct: Math.round((f.confidence ?? 0) * 100),
    })),
    edge_label_counts: edgeCounts,
    unlabeled_edges: edges.filter(e => e.edgeType === 'unlabeled').length,
    scale_description: savedScaleDesc,
  }), [
    location?.matched_address, project?.name, step, runId, runConfirmed, confidence,
    blockingIssues, partialSignals, imagery?.health_score, facets, edges,
    edgeCounts, savedScaleDesc,
  ])
  useRegisterChatContext('aerial-report', chatData)

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
        if (prev === id) { setProject(null); setRunId(null); setFacets([]); setEdges([]); setRunConfirmed(false) }
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

          // A roof nobody has measured yet, saved at a position from the old
          // address lookup: the Census geocoder put 1114 Willow Pond Ln on 1146,
          // 353 m away. If the address's rooftop is now somewhere else, don't
          // adopt that run at all — fall through and start on the right house
          // (the abandoned run holds no measurements). A house merely CLICKED
          // there doesn't count as work to keep: it was clicked on the wrong
          // street, and skipping those runs reopened Willow Pond 350 m off.
          const hasRoof = Array.isArray(data.facets) && (data.facets as unknown[]).length > 0
          if (!hasRoof && run.satellite_image_url) {
            const addrNow = [(p as Project).address, (p as Project).city, (p as Project).state, (p as Project).zip]
              .filter(Boolean).join(', ') || (p as Project).name || ''
            const lat0 = Number(run.satellite_lat) || 0, lng0 = Number(run.satellite_lng) || 0
            let misplaced = false
            try {
              const loc = addrNow ? await api.roofing.v2.locationValidate(addrNow) : null
              if (loc?.lat && lat0) {
                const dy = (loc.lat - lat0) * 111320
                const dx = (loc.lng - lng0) * 111320 * Math.cos((lat0 * Math.PI) / 180)
                misplaced = Math.hypot(dx, dy) > 40
              }
            } catch { /* keep the saved run */ }
            if (misplaced) {
              setRunId(null)   // never reuse a run left over from an earlier project
              throw new Error('saved position is off the address — starting on the right house')
            }
          }

          // Adopt the run BEFORE deciding what else we can restore. Everything
          // the contractor draws saves against this id, and it used to be set
          // only on the imagery branch below — so a run with no pinned tile left
          // the page with runId === null and every later save refused itself
          // with "No measurement run created yet". Nothing they drew could ever
          // be stored, on a project that already had a perfectly good run.
          setRunId(run_id)
          setRunConfirmed(!!run.confirmed)   // finalized roof → show its saved numbers on resume
          const sp = run.subject_point as { x: number; y: number } | null
          setSubjectPoint(sp && typeof sp.x === 'number' ? { x: sp.x, y: sp.y } : null)
          setHouseOutline(null)
          setSavedScaleDesc((run.scale_reference_description as string) || null)

          // Geometry doesn't depend on the tile being pinned — restore it either way.
          const { fcts, edgs } = rowsToGeometry(
            data.facets as Record<string, unknown>[], data.edges as Record<string, unknown>[])

          setFacets(fcts)
          setEdges(edgs)
          setExcludedFacets(rowsToExcluded(run.excluded_facets))
          setGeometryStamp(s => s + 1)
          setEditorSyncRev(r => r + 1)

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
            setStep('editor')
            setBusy(false)
            return
          }
          // No tile pinned: the run and its geometry are intact, but the
          // contractor has to re-pick imagery before drawing. Fall through to
          // the location step — `startRun` reuses this run rather than
          // orphaning the facets we just restored.
        }
      } catch (e) {
        // Resume is best-effort — fall through to a fresh start below. Logged
        // rather than swallowed: a silent failure here presents as "my roof
        // vanished", which is the hardest kind of bug to hear about second-hand.
        // eslint-disable-next-line no-console
        console.warn('[axis] resume failed — starting fresh', e)
      }

      // The project's name IS its address now; older projects may only have
      // the name filled in, so it is the fallback.
      const addr = [(p as Project).address, (p as Project).city, (p as Project).state, (p as Project).zip]
        .filter(Boolean).join(', ') || (p as Project).name || ''
      if (addr) {
        try {
          const loc = await api.roofing.v2.locationValidate(addr) as LocationSelected
          if (loc && loc.lat) {
            setBusy(false)
            await onLocationSelectedRef.current(loc, id)
            return
          }
          setLocation(loc)
        } catch {
          // Could not resolve it: let them pick the address by hand below.
        }
      }
      setStep('location')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load project')
    } finally {
      setBusy(false)
    }
  }, [])

  // Deep-link support: /roof-v2?project=<id> (e.g. from "Create project" in the
  // CRM) auto-selects that project and jumps into measuring — no re-picking.
  // Read from window.location to avoid the useSearchParams Suspense requirement.
  const autoPicked = useRef(false)
  useEffect(() => {
    if (autoPicked.current || typeof window === 'undefined') return
    const pid = new URLSearchParams(window.location.search).get('project')
    if (pid) { autoPicked.current = true; void pickProject(pid) }
  }, [pickProject])

  // When a location is confirmed: fetch the imagery health and surface it to
  // the user immediately. Sharpening is OPT-IN via a button — the user
  // reported it wasn't adding visible value, so we don't run it automatically.

  const onLocationSelected = useCallback(async (loc: LocationSelected, pidOverride?: string) => {
    const projectId = pidOverride ?? projectIdRef.current
    setLocation(loc)
    setStep('imagery')
    // Persist the validated address onto the project so the Permits and Report
    // tabs can resolve the county without re-asking. Best-effort — a roofing
    // project otherwise carries only a name, which blocks the permit lookup.
    // Everything the geocoder resolved goes onto the project, not just the
    // three fields the permit lookup happened to need. Dropping address, state
    // and the coordinates left the details panel blank and, because lat/lng
    // were never written, "Add to dispatch" refused every project with
    // "no location yet" despite the roof having been measured at that address.
    if (projectId && (loc.matched_address || loc.city || loc.lat)) {
      api.projects.saveLocation(projectId, {
        address: loc.matched_address || undefined,
        city: loc.city || undefined,
        state: loc.state || undefined,
        region: loc.state ? `US-${loc.state}` : undefined,
        zip_code: loc.zip || undefined,
        county: loc.county || undefined,
        // 0,0 means manual entry with no geocode — never persist that as a place.
        lat: loc.lat || undefined,
        lng: loc.lng || undefined,
      }).catch(() => {})
    }
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
      //
      // NOTE: no background auto-recenter. It called the (now-retired) building
      // auto-detect AND could swap the tile out from under a run mid-draw — so
      // the saved tile no longer matched the facets, which is exactly the
      // "outline lands in the wrong spot on resume" bug. The homeowner taps
      // their house in the confirm step instead.
      const health = await api.roofing.v2.imageryHealth(loc.lat, loc.lng, 22, 2048, 1366) as ImageryPayload
      const img = { ...health, original_url: health.url, display_mode: 'original' } as ImageryPayload
      setImagery(img)
      setBusy(false)
      // Straight to the house: the photo-stats screen with "Ready to trace" was
      // a click that decided nothing. It still shows if the photo is unusable.
      if (img.url && img.status !== 'unavailable') await openRunRef.current(projectId, img)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Imagery health check failed')
      setBusy(false)
    }
  }, [])
  onLocationSelectedRef.current = onLocationSelected

  // Create a measurement run + advance to editor. Heavily instrumented so we
  // can see EXACTLY what happens on each click and where it gets stuck if it
  // does — silent failures here have made debugging hard before.
  // Opens the measuring screen on the house. Takes the project and tile as
  // arguments (not from state) so the address box can create a project, load
  // its tile and land here in one go — state set a moment earlier is not yet
  // visible inside this callback.
  const openRun = useCallback(async (pid: string | null, img: ImageryPayload | null) => {
    const projectId = pid
    const imagery = img
    if (!projectId) {
      setError('Cannot open editor: no project selected. Enter the project address first.')
      return
    }
    if (!imagery || !imagery.url) {
      setError('Cannot open editor: the satellite photo failed to load. Try the address again.')
      return
    }

    setBusy(true)
    setError(null)
    try {
      // A run we already resumed keeps its facets — creating a second one here
      // would strand them on the old run and read to the contractor as "my
      // drawing disappeared". Re-pin the chosen tile onto the run we have.
      if (runId) {
        // eslint-disable-next-line no-console
        console.log('[axis] startRun → reusing resumed run', runId)
        await persistGeometryRef.current?.(facets, edges)
        setStep('editor')
        setBusy(false)
        return
      }
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
      setRunConfirmed(false)   // a freshly created run starts unconfirmed → gate until reviewed
      setEditorSub('confirm')
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
  }, [runId, facets, edges])
  openRunRef.current = openRun
  projectIdRef.current = projectId
  const startRun = useCallback(() => openRun(projectId, imagery), [openRun, projectId, imagery])

  // Persist facets + edges to backend whenever the editor publishes them.
  // Surfaces specific errors instead of silently failing so the contractor
  // doesn't end up staring at an empty Measurements panel wondering why.
  const persistGeometry = useCallback(async (newFacets: Facet[], newEdges: LabeledEdge[], opts?: { keepalive?: boolean }) => {
    setFacets(newFacets)
    setEdges(newEdges)
    if (!runId) {
      setSaveState('error')
      setError('No measurement run created yet — refresh the page if this persists.')
      return
    }
    if (!imagery) {
      setSaveState('error')
      setError('Satellite imagery not loaded — go back to the Imagery step.')
      return
    }
    if (!location) {
      setSaveState('error')
      setError('Address not validated — go back to the Location step. Without a lat/lng, geometry cannot be measured.')
      return
    }
    if (newFacets.length === 0) {
      // Empty editor state isn't an error — just nothing to save
      return
    }
    // One row per letter is all the server can hold. A roof that somehow has
    // two facets with the same letter is renamed here rather than refused:
    // the second one takes a free letter (its lines can't be told apart from
    // the first's, so they start unlabeled), and nothing is lost.
    const fixed = uniqueLetters(newFacets, newEdges)
    if (fixed.facets !== newFacets) {
      newFacets = fixed.facets
      setFacets(newFacets)
      setEditorSyncRev(r => r + 1)       // show the new letter on the map
    }
    setSaveState('saving')
    const lat = location.lat
    const lng = location.lng
    if (lat === 0 && lng === 0) {
      setError('Address used manual entry (no coordinates). Pick an autocomplete suggestion instead so the platform can compute real measurements.')
      return
    }
    try {
      const geometry = {
        image_width_px: imagery.width_px ?? 2048,
        image_height_px: imagery.height_px ?? 1366,
        zoom: imagery.zoom ?? 20,
        lat,
        lng,
        // Pin the exact tile these facets were drawn on so resume reloads it.
        satellite_image_url: imagery.original_url || imagery.url,
        excluded_facets: excludedRef.current.map(x => ({
          facet_label: x.facet.label,
          polygon: x.facet.polygon,
          pitch: x.facet.pitch,
          reason: x.reason,
          edges: x.edges.map(e => ({
            vertex_index_start: e.vertexIndexStart, vertex_index_end: e.vertexIndexEnd, edge_type: e.edgeType,
          })),
        })),
        facets: newFacets.map(f => ({
          facet_label: f.label,
          polygon: f.polygon,
          pitch: f.pitch,
          pitch_source: f.pitchSource,
          confidence: f.confidence,
          user_confirmed: f.userConfirmed,
          ai_suggested: !!f.aiSuggested,
          azimuth_deg: f.azimuthDeg,
        })),
        edges: newEdges.map(e => ({
          facet_label: e.facetLabel,
          vertex_index_start: e.vertexIndexStart,
          vertex_index_end: e.vertexIndexEnd,
          edge_type: e.edgeType,
          shared_with_facet_label: e.sharedWithFacetLabel,
          user_confirmed: e.userConfirmed,
        })),
      }
      try {
        await api.roofing.v2.putGeometry(runId, geometry, { keepalive: !!opts?.keepalive })
      } catch (err) {
        // Rollout guard: the page can deploy before the server that has the
        // one-request save. Until then, save the old way rather than not at all.
        if (!(err instanceof ApiError && (err.status === 404 || err.status === 405))) throw err
        const { edges: geomEdges, ...facetPayload } = geometry
        await api.roofing.v2.putFacets(runId, facetPayload)
        await api.roofing.v2.putEdges(runId, {
          image_width_px: geometry.image_width_px, image_height_px: geometry.image_height_px,
          zoom: geometry.zoom, lat: geometry.lat, edges: geomEdges,
        })
      }
      setGeometryStamp(s => s + 1)
      setSaveState('saved')
      setSavedAt(Date.now())
      setError(null)   // clear any prior visible error on success
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown save error'
      setSaveState('error')
      setError(`Save failed: ${msg}. Check browser DevTools Network tab for the failing request.`)
    }
  }, [runId, imagery, location])
  persistGeometryRef.current = persistGeometry

  // Debounced wrapper so we don't hammer the API on every vertex drag.
  const debouncedRef = useMemo(() => ({
    t: null as ReturnType<typeof setTimeout> | null,
    pending: null as { facets: Facet[]; edges: LabeledEdge[] } | null,
  }), [])

  const flushPending = useCallback(() => {
    if (debouncedRef.t) { clearTimeout(debouncedRef.t); debouncedRef.t = null }
    const p = debouncedRef.pending
    debouncedRef.pending = null
    // The tab may be closing: keepalive lets this last save finish after it goes.
    if (p) void persistGeometryRef.current?.(p.facets, p.edges, { keepalive: true })
  }, [debouncedRef])

  /** Drop a queued canvas write.
   *
   *  Anything that persists geometry from OUTSIDE the canvas — accepting edge
   *  labels, accepting AI facets, a manual save — has just written newer state
   *  than whatever the debounce is holding. Letting that queued write land
   *  afterwards overwrites the labels that were just accepted, which is why
   *  edges appeared to need re-analyzing after they had already been done. */
  const cancelPending = useCallback(() => {
    if (debouncedRef.t) { clearTimeout(debouncedRef.t); debouncedRef.t = null }
    debouncedRef.pending = null
  }, [debouncedRef])

  // Ask once whether this account gets auto-measure.
  useEffect(() => {
    api.roofing.v2.autoMeasureEnabled()
      .then(r => setAutoMeasureOn(!!r.enabled))
      .catch(() => setAutoMeasureOn(false))
  }, [])

  // Check the picked house against the job's address as soon as it is picked.
  // A confirmation is remembered for this run + point in the session, so a
  // reload does not ask again.
  // Reopened job: the picker didn't run this visit, so ask for the confirmed
  // house's outline once (Google's building at the confirmed point).
  useEffect(() => {
    if (!runId || !subjectPoint || houseOutline || !imagery?.feet_per_pixel) return
    const lat0 = imagery.lat ?? location?.lat, lng0 = imagery.lng ?? location?.lng
    if (lat0 == null || lng0 == null) return
    const w = imagery.width_px ?? 2048, h = imagery.height_px ?? 1366, fpp = imagery.feet_per_pixel
    let live = true
    api.roofing.v2.buildingAt(runId, fracToGeo(subjectPoint.x, subjectPoint.y, lat0, lng0, w, h, fpp))
      .then(b => {
        if (!live || !b?.available || !b.outline?.length) return
        setHouseOutline(b.outline.map((p: { lat: number; lng: number }) => {
          const [x, y] = geoToFrac(p.lat, p.lng, lat0, lng0, w, h, fpp)
          return { x, y }
        }))
      })
      .catch(() => { /* the pin alone still marks the house */ })
    return () => { live = false }
  }, [runId, subjectPoint, houseOutline, imagery, location])

  // Every traced plane is off the confirmed house: no plane's centre inside its
  // outline (or, with no outline, none within ~15 m of the pin) and the pin
  // inside no plane. Warns, never blocks.
  const traceOffHouse = useMemo(() => {
    if (!subjectPoint || facets.length === 0) return false
    const inside = (pt: { x: number; y: number }, poly: { x: number; y: number }[]) => {
      let c = false
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i], b = poly[j]
        if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) c = !c
      }
      return c
    }
    const polys = facets.map(f => f.polygon.map(([x, y]) => ({ x, y })))
    if (polys.some(p => p.length >= 3 && inside(subjectPoint, p))) return false
    const centres = polys.filter(p => p.length).map(p => ({
      x: p.reduce((s, q) => s + q.x, 0) / p.length, y: p.reduce((s, q) => s + q.y, 0) / p.length }))
    if (houseOutline && houseOutline.length >= 3) return !centres.some(c => inside(c, houseOutline))
    const w = imagery?.width_px ?? 2048, h = imagery?.height_px ?? 1366, fpp = imagery?.feet_per_pixel
    if (!fpp) return false
    const mPerPx = fpp / 3.28084
    return !centres.some(c => Math.hypot((c.x - subjectPoint.x) * w, (c.y - subjectPoint.y) * h) * mPerPx < 15)
  }, [subjectPoint, facets, houseOutline, imagery])

  const addressKey = runId && subjectPoint ? `axis_addr_ok:${runId}:${subjectPoint.x.toFixed(4)},${subjectPoint.y.toFixed(4)}` : null
  useEffect(() => {
    setAddressCheck(null)
    if (!runId || !subjectPoint) { setAddressConfirmed(false); return }
    let ok = false
    try { ok = !!addressKey && sessionStorage.getItem(addressKey) === '1' } catch { /* private mode */ }
    setAddressConfirmed(ok)
    let cancelled = false
    api.roofing.v2.addressCheck(runId)
      .then(r => { if (!cancelled) setAddressCheck({ status: r.status, message: r.message }) })
      .catch(() => { if (!cancelled) setAddressCheck({ status: 'unknown', message: null }) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, subjectPoint?.x, subjectPoint?.y])
  const needsAddressConfirm = addressCheck?.status === 'mismatch' && !!addressCheck.message && !addressConfirmed
  const confirmAddress = useCallback(() => {
    setAddressConfirmed(true)
    try { if (addressKey) sessionStorage.setItem(addressKey, '1') } catch { /* private mode */ }
  }, [addressKey])

  // Measure the confirmed house from Google 3D. On success the result is
  // already stored server-side exactly like a trace; load it into the editor
  // for review. On any refusal, say why and open the editor empty to trace.
  const runAutoMeasure = useCallback(async (allowOldImagery = false, addressOk?: boolean) => {
    if (!runId || !imagery) return
    setAutoBusy(true)
    setAutoNote(null)
    try {
      const r = await api.roofing.v2.autoMeasure(runId, {
        image_width_px: imagery.width_px ?? 2048,
        image_height_px: imagery.height_px ?? 1366,
        zoom: imagery.zoom ?? 20,
        lat: imagery.lat ?? location?.lat ?? 0,
        lng: imagery.lng ?? location?.lng ?? 0,
        satellite_image_url: imagery.original_url || imagery.url,
        allow_old_imagery: allowOldImagery,
        address_confirmed: addressOk ?? addressConfirmed,
      })
      if (r.available && r.facets && r.edges) {
        const { fcts, edgs } = rowsToGeometry(r.facets, r.edges)
        cancelPending()   // a queued canvas write would overwrite the measurement
        // Google's own photo, in the same frame: the outline sits on it exactly.
        // Adopted as THE photo, or the next save would pin the old tile back.
        if (r.imagery_url) {
          const url = r.imagery_url
          setImagery(prev => prev ? { ...prev, url, original_url: url, provider: 'Google 3D' } : prev)
        }
        setFacets(fcts)
        setEdges(edgs)
        setExcludedFacets([])   // the server cleared them: a fresh measurement
        setEditorSyncRev(v => v + 1)
        setGeometryStamp(v => v + 1)
        setMeasuredAuto(true)
        setAutoNote({
          ok: true,
          text: `Measured automatically from 3D roof data${r.imagery_date ? ` (aerial photo from ${monthYear(r.imagery_date)})` : ''}`
            + `${r.alignment ? ` — ${plainNote(r.alignment)}` : ''}. `
            + 'Check the outline sits on the right roof and adjust anything that looks off.',
          warnings: (r.warnings || []).map(plainNote),
        })
      } else {
        const why = r.reason || "This roof couldn't be measured automatically."
        const stale = !!r.stale_imagery
        setAutoNote({
          // An old photo is a question with a clear yes, not a failure.
          ok: false, text: plainNote(why), warnings: [],
          staleDate: stale ? (r.imagery_date ?? 'an old date') : null,
        })
      }
    } catch (e) {
      setAutoNote({ ok: false, text: `Automatic measurement didn't finish (${e instanceof Error ? e.message : 'error'}).`, warnings: [] })
    } finally {
      setAutoBusy(false)
      setEditorSub('draw')
    }
  }, [runId, imagery, location, cancelPending, addressConfirmed])

  // Wrong house: throw the outline away (nothing has been charged — a report is
  // only used when the measurements are shown) and go back to picking it.
  const startOverHouse = useCallback(async () => {
    cancelPending()
    const had = facets.length > 0
    setFacets([]); setEdges([]); setExcludedFacets([]); setAutoNote(null); setSubjectPoint(null); setHouseOutline(null)
    setMeasuredAuto(false); setAddressCheck(null); setAddressConfirmed(false)
    setEditorSyncRev(v => v + 1)
    if (had) await persistGeometryRef.current?.([], [])
    setEditorSub('confirm')
  }, [cancelPending, facets.length])

  // "Not roof (tree / shadow)" from the line review: the section and its lines
  // leave the roof; lines of other sections that pointed at it point at nothing.
  const excludeFacet = useCallback((label: string) => {
    const { facets: fs, edges: es } = geomRef.current
    const f = fs.find(x => x.label === label)
    if (!f) return
    cancelPending()
    const nextFacets = fs.filter(x => x.label !== label)
    const nextEdges = es.filter(e => e.facetLabel !== label)
      .map(e => (e.sharedWithFacetLabel === label ? { ...e, sharedWithFacetLabel: undefined } : e))
    setExcludedFacets([...excludedRef.current, { facet: f, edges: es.filter(e => e.facetLabel === label), reason: 'not_roof' }])
    geomRef.current = { facets: nextFacets, edges: nextEdges }
    setEditorSyncRev(r => r + 1)
    void persistGeometry(nextFacets, nextEdges).then(() => setGeometryStamp(s => s + 1))
  }, [cancelPending, persistGeometry, setExcludedFacets])

  const restoreFacet = useCallback((label: string) => {
    const x = excludedRef.current.find(e => e.facet.label === label)
    if (!x) return
    const { facets: fs, edges: es } = geomRef.current
    // Its letter may have been reused since; then it takes the next free one.
    const used = new Set(fs.map(f => f.label))
    let name = label
    if (used.has(name)) {
      name = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').find(c => !used.has(c)) || `${label}2`
    }
    cancelPending()
    const nextFacets = [...fs, { ...x.facet, label: name }]
    const nextEdges = [...es, ...x.edges.map(e => ({ ...e, facetLabel: name, sharedWithFacetLabel: undefined }))]
    setExcludedFacets(excludedRef.current.filter(e => e !== x))
    geomRef.current = { facets: nextFacets, edges: nextEdges }
    setEditorSyncRev(r => r + 1)
    void persistGeometry(nextFacets, nextEdges).then(() => setGeometryStamp(s => s + 1))
  }, [cancelPending, persistGeometry, setExcludedFacets])

  const onEditorChange = useCallback((newFacets: Facet[], newEdges: LabeledEdge[]) => {
    // Undo in the editor can bring a "Not roof" section straight back; then it
    // is roof again, not both.
    if (excludedRef.current.length) {
      const back = new Set(newFacets.map(f => `${f.label}|${JSON.stringify(f.polygon)}`))
      const still = excludedRef.current.filter(x => !back.has(`${x.facet.label}|${JSON.stringify(x.facet.polygon)}`))
      if (still.length !== excludedRef.current.length) setExcludedFacets(still)
    }
    setFacets(newFacets)
    setEdges(newEdges)
    debouncedRef.pending = { facets: newFacets, edges: newEdges }
    if (debouncedRef.t) clearTimeout(debouncedRef.t)
    debouncedRef.t = setTimeout(() => {
      debouncedRef.t = null
      // Write whatever is CURRENT, not what this callback closed over 800ms ago.
      // The closure could be several edits — or an accepted label set — behind.
      const p = debouncedRef.pending ?? { facets: newFacets, edges: newEdges }
      debouncedRef.pending = null
      void persistGeometry(p.facets, p.edges)
    }, 800)
  }, [persistGeometry, debouncedRef, setExcludedFacets])

  // A debounce that loses its last edit is indistinguishable from "it doesn't
  // save". Flush the pending write when the tab is hidden or the page is being
  // torn down — the two moments a contractor's last polygon used to vanish.
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') flushPending() }
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', flushPending)
    return () => {
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', flushPending)
      flushPending()
    }
  }, [flushPending])

  const confirmAndDownload = useCallback(async () => {
    if (!runId) return
    setBusy(true)
    setError(null)
    try {
      await api.roofing.v2.patchRun(runId, { confirmed: true })
      setRunConfirmed(true)
      await api.roofing.v2.downloadReport(runId, s => setReportQueueMsg(describeReportQueue(s)))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Report download failed')
    } finally {
      setBusy(false)
      setReportQueueMsg(null)
    }
  }, [runId])

  return (
    <div className="mx-auto max-w-[1400px] space-y-6 p-6 text-[#1a1a1a]">
      <header>
        <h1 className="text-2xl font-bold">Axis Roof Report (v2)</h1>
        <p className="text-sm text-[#6b7280]">
          Multi-facet measurement with edge labeling. All numbers downstream — area, squares,
          ridge cap, drip edge, materials — are computed from your polygons and pitches. Nothing
          is fabricated.
        </p>
      </header>

      {/* Stepper — sticky so it stays visible while scrolling the editor.
          Completed steps (before the current one) show a checkmark. */}
      {(() => {
        // 'siding' is the optional on-site stop (ground photos + siding). It sits
        // AFTER the report is reachable, because the whole promise of the product
        // is a finished report without going to the property — anything needing a
        // site visit is an add-on, never a step you have to pass through.
        // Address and photo happen automatically between "Project address" and
        // the house; their steps only show while something needs fixing there.
        const order: Step[] = (SHOW_SIDING
          ? ['project', 'location', 'imagery', 'editor', 'details', 'report', 'siding']
          : ['project', 'location', 'imagery', 'editor', 'details', 'report']
        ).filter(s => (s !== 'location' && s !== 'imagery') || s === step) as Step[]
        const currentIdx = order.indexOf(step)
        return (
          <nav className="sticky top-0 z-20 -mx-6 flex flex-wrap items-center gap-1.5 border-b border-[#dededc] bg-[#f8f8f7] px-6 py-2 text-xs">
            {order.map((s, i) => {
              const reached =
                (s === 'project') ||
                (s === 'location' && !!projectId) ||
                (s === 'imagery' && !!location) ||
                (s === 'editor' && !!imagery && imagery.status !== 'unavailable') ||
                (s === 'details' && !!runId && facets.length > 0) ||
                (s === 'siding' && (!!runId || !!projectId)) ||
                (s === 'report' && !!runId && facets.length > 0)
              const completed = reached && i < currentIdx
              return (
                <span key={s} className="flex items-center gap-1.5">
                  {i > 0 && <span className={`h-px w-4 ${completed || i <= currentIdx ? 'bg-blue-500/50' : 'bg-[#e4e4e2]'}`} />}
                  <button
                    onClick={() => reached && setStep(s)}
                    disabled={!reached}
                    className={`flex items-center gap-1 rounded-full px-3 py-1.5 transition ${ step === s ? 'bg-blue-600 text-white' : completed ? 'bg-emerald-900/40 text-emerald-300 hover:bg-emerald-900/60' : reached ? 'bg-[#eeeeed] text-[#1a1a1a] hover:bg-[#e4e4e2]' : 'cursor-not-allowed bg-[#f8f8f7] text-[#9ca3af]' }`}
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
        // text-rose-900 on bg-rose-50 was left over from the dark theme —
        // pale text on a near-white panel, which read as invisible. Dark ink on
        // a light rose panel, and whitespace-pre-line so a multi-line
        // validation failure keeps its bullets instead of running together.
        <div role="alert"
          className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm font-medium text-rose-900 whitespace-pre-line">
          {error}
          {/* A blocked report is a fixable state, not a crash — say what to do. */}
          {/eave|perimeter|outline/i.test(error) && (
            <div className="mt-2 text-[12px] font-normal text-rose-800">
              Go back to <strong>Edges</strong> and confirm the perimeter edges around the
              roof — every sloped roof needs at least one eave before a report can be built.
            </div>
          )}
        </div>
      )}

      {/* PROJECT step */}
      {step === 'project' && (
        <section className="space-y-4">
          {/* Quick start: create a new roofing project right here */}
          <div className="rounded-lg border border-emerald-400/30 bg-emerald-500/5 p-4">
            <h2 className="mb-2 text-sm font-semibold text-emerald-900">New project — property address</h2>
            <p className="mb-3 text-xs text-[#6b7280]">
              Type the address and pick it from the list. That becomes the project&apos;s name, and
              you go straight to the house.
            </p>
            <NewProjectByAddress
              userId={userId}
              busy={busy}
              onCreated={async (newProject, loc) => {
                setProjects(prev => [newProject, ...prev])
                setProjectId(newProject.id)
                projectIdRef.current = newProject.id
                setProject(newProject)
                setRunId(null); setFacets([]); setEdges([]); setRunConfirmed(false); setSubjectPoint(null); setHouseOutline(null)
                await onLocationSelected(loc, newProject.id)
              }}
              onError={(msg) => setError(msg)}
            />
          </div>

          {/* Existing projects */}
          <div className="rounded-lg border border-[#dededc] bg-[#f8f8f7] p-4">
            <h2 className="mb-3 text-sm font-semibold">Or pick an existing project</h2>
            {projects.length === 0 ? (
              <p className="text-xs text-[#6b7280]">
                No existing projects. Use the quick-start form above to create your first one.
              </p>
            ) : (
              <ul className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
                {projects.map(p => (
                  <li
                    key={p.id}
                    className="group relative rounded-md border border-[#dededc] bg-[#eeeeed] p-3 text-sm transition hover:border-blue-400/40 hover:bg-blue-500/10"
                  >
                    <button
                      onClick={() => void deleteProject(p.id, p.name)}
                      title="Delete project"
                      className="absolute right-2 top-2 rounded px-1.5 py-0.5 text-xs text-[#6b7280] opacity-0 transition hover:bg-rose-600/30 hover:text-rose-800 group-hover:opacity-100"
                    >✕</button>
                    <div onClick={() => void pickProject(p.id)} className="cursor-pointer pr-5">
                      <div className="font-medium">{p.name}</div>
                      {p.address && (
                        <div className="text-xs text-[#6b7280]">
                          {[p.address, p.city, p.state, p.zip].filter(Boolean).join(', ')}
                        </div>
                      )}
                      <div className="mt-1 text-[10px] text-blue-800/70">Click to open / resume →</div>
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
        <section className="rounded-lg border border-[#dededc] bg-[#f8f8f7] p-4">
          <h2 className="mb-3 text-sm font-semibold">Validate property address</h2>
          <LocationPicker
            initialQuery={project ? [project.address, project.city, project.state, project.zip].filter(Boolean).join(', ') : ''}
            onSelected={onLocationSelected}
          />
        </section>
      )}

      {/* IMAGERY step */}
      {step === 'imagery' && (
        <section className="rounded-lg border border-[#dededc] bg-[#f8f8f7] p-4">
          <h2 className="mb-3 text-sm font-semibold">
            {busy ? 'Loading satellite tile…' : 'Satellite imagery'}
          </h2>
          {busy && !imagery && (
            <div className="flex items-center gap-3 rounded bg-[#f8f8f7] p-3 text-sm text-[#2d2d2d]">
              <RoofScanSpinner size={30} className="flex-shrink-0" />
              <span>Fetching the highest-resolution satellite tile (zoom 22 @2x retina)…</span>
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
                  color={imagery.zoom != null && imagery.zoom >= 22 ? 'text-emerald-800' : imagery.zoom != null && imagery.zoom < 22 ? 'text-amber-800' : undefined}
                />
                <Stat label="Status" value={imagery.status} color={
                  imagery.status === 'ok' ? 'text-emerald-800'
                  : imagery.status === 'degraded' ? 'text-amber-800'
                  : 'text-rose-800'
                }/>
                <Stat label="Provider" value={imagery.provider ?? '—'} />
                <Stat label="Health" value={`${Math.round((imagery.health_score ?? 0) * 100)}%`} />
                <Stat
                  label="Resolution"
                  value={`${imagery.feet_per_pixel?.toFixed(3) ?? '?'} ft/px`}
                  color={(imagery.warnings || []).some(w => w.includes('sharpened')) ? 'text-emerald-800' : undefined}
                />
              </div>
              {imagery.warnings.length > 0 && (
                <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-amber-800">
                  {imagery.warnings.map((w, i) => <li key={i} className={w.includes('sharpened') ? 'text-emerald-800' : ''}>{w}</li>)}
                </ul>
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
                        <span>Opening…</span>
                      </>
                    ) : (
                      <>Continue to the house →</>
                    )}
                  </button>
                </div>
              )}
              {imagery.status === 'unavailable' && (
                <div className="mt-3 text-xs text-rose-800">
                  All satellite providers failed. Configure MAPBOX_ACCESS_TOKEN or MAPTILER_API_KEY on the backend, or use manual measurement via blueprint upload.
                </div>
              )}
            </>
          )}
        </section>
      )}

      {/* EDITOR step */}
      {/* Pop-ups centred on screen, over the map. The progress spinner and the
          old-photo question used to sit BELOW the satellite image — off the
          bottom of the screen — so the first founding contractor saw nothing
          happen after clicking, or never saw the question at all. */}
      {step === 'editor' && autoBusy && <MeasuringOverlay />}
      {step === 'editor' && autoNote && !autoBusy && !autoNote.ok && autoNote.staleDate && (
        <ScreenModal onClose={() => setAutoNote(null)}>
          <div className="text-base font-semibold text-[#1a1a1a]">Is this still the same roof?</div>
          <p className="mt-2 text-sm leading-relaxed text-[#4b5563]">{autoNote.text}</p>
          <div className="mt-5 flex flex-col gap-2">
            <button onClick={() => { void runAutoMeasure(true) }}
              className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-500">
              Yes, same roof &mdash; measure it
            </button>
            <button onClick={() => setAutoNote(null)}
              className="w-full rounded-lg px-4 py-2 text-sm font-medium text-[#4b5563] hover:bg-[#f3f4f6]">
              It&apos;s changed &mdash; I&apos;ll trace it by hand
            </button>
          </div>
        </ScreenModal>
      )}

      {step === 'editor' && imagery?.url && runId && (
        <section className="space-y-4">
          {/* Progress — one satellite image at a time (confirm → scale → draw). */}
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            {([['confirm', '1. Confirm house'], ['scale', '2. Check scale (optional)'], ['draw', '3. Draw & label roof']] as const).map(([k, label], i) => {
              const reached = k === 'confirm' || (k === 'scale' && subjectPoint != null) || k === 'draw'
              return (
                <span key={k} className="flex items-center gap-1.5">
                  {i > 0 && <span className="h-px w-4 bg-[#e4e4e2]" />}
                  <button onClick={() => reached && setEditorSub(k)} disabled={!reached}
                    className={`rounded-full px-3 py-1 transition ${editorSub === k ? 'bg-blue-600 text-white' : reached ? 'bg-[#eeeeed] text-[#2d2d2d] hover:bg-[#e4e4e2]' : 'cursor-not-allowed bg-[#f8f8f7] text-[#9ca3af]'}`}>
                    {label}
                  </button>
                </span>
              )
            })}
          </div>

          {/* Critical warning zone — above everything else, only when relevant.
              The wrong-house warning must be answered before anything can be
              measured or drawn; once confirmed it collapses to a small note. */}
          {needsAddressConfirm && addressCheck?.message && (
            <AddressMismatchBanner
              message={addressCheck.message}
              onConfirm={confirmAddress}
              onStartOver={() => { void startOverHouse() }}
            />
          )}
          {addressCheck?.status === 'mismatch' && addressConfirmed && (
            <p className="text-xs text-[#6b7280]"><span className="text-emerald-600">✓</span> Address confirmed — you&apos;ve checked this is the right house.</p>
          )}

          {/* STEP 1 — confirm the house. */}
          {editorSub === 'confirm' && imagery?.url && (
            <div className="space-y-3">
              <HousePicker
                runId={runId}
                imageUrl={imagery.url}
                lat={imagery.lat ?? location?.lat}
                lng={imagery.lng ?? location?.lng}
                imageWidthPx={imagery.width_px ?? 2048}
                imageHeightPx={imagery.height_px ?? 1366}
                feetPerPixel={imagery.feet_per_pixel ?? 0}
                address={project ? [project.address, project.city, project.state, project.zip].filter(Boolean).join(', ') : undefined}
                initialPoint={subjectPoint}
                onConfirmed={(pt, info) => {
                  // A "yes" to a building whose address did not match the job IS
                  // the address confirmation — never ask the same question twice.
                  if (info.addressAcknowledged && runId) {
                    try { sessionStorage.setItem(`axis_addr_ok:${runId}:${pt.x.toFixed(4)},${pt.y.toFixed(4)}`, '1') } catch { /* private mode */ }
                  }
                  setSubjectPoint(pt)
                  setHouseOutline(info.outline)
                  // "Yes, measure this roof" measures it — straight away.
                  if (autoMeasureOn) void runAutoMeasure(false, info.addressAcknowledged || undefined)
                  else setEditorSub('draw')
                }}
              />
              <div className="flex flex-wrap items-center justify-end gap-4 text-xs">
                <button onClick={() => setEditorSub('scale')}
                  className="font-medium text-[#4b5563] underline underline-offset-2 hover:text-[#1a1a1a]">Check scale (optional)</button>
                <button onClick={() => setEditorSub('draw')} disabled={needsAddressConfirm}
                  className="font-medium text-[#4b5563] underline underline-offset-2 hover:text-[#1a1a1a] disabled:opacity-50">Trace the roof by hand instead</button>
              </div>
            </div>
          )}

          {/* STEP 2 — confirm the scale BEFORE drawing. */}
          {editorSub === 'scale' && runId && imagery?.url && (
            <div className="space-y-3">
              <ScaleCheckPanel
                runId={runId}
                imageUrl={imagery.original_url || imagery.url}
                imageWidthPx={imagery.width_px ?? 2048}
                imageHeightPx={imagery.height_px ?? 1366}
                feetPerPixel={imagery.feet_per_pixel ?? 0}
                savedScaleDescription={savedScaleDesc}
              />
              <div className="flex justify-between">
                <button onClick={() => setEditorSub('confirm')}
                  className="rounded-md bg-[#e4e4e2] px-4 py-2 text-sm text-[#1a1a1a] hover:bg-[#d4d4d2]">&larr; Back</button>
                <button onClick={() => setEditorSub('draw')} disabled={needsAddressConfirm}
                  className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-50">Next: draw roof &rarr;</button>
              </div>
            </div>
          )}

          {editorSub === 'draw' && needsAddressConfirm && (
            <p className="rounded-lg border border-[#dededc] bg-[#f8f8f7] p-4 text-sm text-[#4b5563]">
              Confirm the address above (or start over) before measuring or drawing this roof.
            </p>
          )}

          {editorSub === 'draw' && !needsAddressConfirm && (<>
          {/* ONE status card: where the roof stands and the single next step.
              It replaced a stack of up to six competing boxes. */}
          <DrawStatusCard
            facetCount={facets.length}
            counts={edgeCounts}
            measuredAuto={measuredAuto}
            autoFailedReason={autoNote && !autoNote.ok && !autoNote.staleDate && facets.length === 0 ? autoNote.text : null}
            autoMeasureAvailable={autoMeasureOn && !!subjectPoint}
            applying={applyingEdges}
            labelBusy={labelStatus.loading}
            aiLabelAvailable={labelStatus.aiLines > 0}
            labelError={labelStatus.error}
            awaitingReportConfirm={awaitingReportConfirm}
            showingMeasurements={showingMeasurements}
            notes={[
              ...(traceOffHouse ? ['⚠ What you traced isn’t on the house you confirmed (marked “Your house”). Check you’re tracing the right roof.'] : []),
              ...(autoNote?.ok ? [autoNote.text, ...autoNote.warnings] : []),
              ...partialSignals.map(plainNote),
            ]}
            blocking={blockingIssues.map(c => ISSUE_TEXT[c] ?? c)}
            saveIndicator={<SaveIndicator state={saveState} savedAt={savedAt} onRetry={() => { cancelPending(); void persistGeometry(facets, edges) }} />}
            onAutoMeasure={() => { void runAutoMeasure() }}
            onStartDrawing={() => setEditorCommand(c => ({ kind: 'draw', n: c.n + 1 }))}
            onHelp={() => setEditorCommand(c => ({ kind: 'help', n: c.n + 1 }))}
            onWalkThrough={() => setEditorCommand(c => ({ kind: 'guide', n: c.n + 1 }))}
            onLabelAll={() => setLabelCommand(c => ({ kind: 'suggest', n: c.n + 1 }))}
            onConfirmAll={() => setLabelCommand(c => ({ kind: 'confirmAll', n: c.n + 1 }))}
            onReviewOneByOne={() => setLabelCommand(c => ({ kind: 'review', n: c.n + 1 }))}
            onShowMeasurements={() => setReportConfirmReq(n => n + 1)}
            onContinue={() => setStep('details')}
          />

          {/* The map stays the dominant visual. */}
          <div className="h-[680px] overflow-hidden">
            <RoofFacetEditor
              imageUrl={imagery.url}
              imageWidthPx={imagery.width_px ?? 2048}
              imageHeightPx={imagery.height_px ?? 1366}
              initialFacets={facets}
              initialEdges={edges}
              onChange={onEditorChange}
              syncRev={editorSyncRev}
              command={editorCommand}
              houseGuide={{ point: subjectPoint, outline: houseOutline }}
              excludedFacets={excludedFacets}
              onRestoreFacet={restoreFacet}
              onExcludeFacet={excludeFacet}
            />
          </div>

          {/* The labeler runs behind the status card: no panel of its own, only
              the one-by-one review when it opens. */}
          {facets.length > 0 && (
            <EdgeLabelSuggestions
              headless
              runId={runId}
              facets={facets}
              edges={edges}
              imageUrl={imagery?.original_url || imagery?.url}
              imageWidthPx={imagery?.width_px ?? 2048}
              imageHeightPx={imagery?.height_px ?? 1366}
              command={labelCommand}
              onStatus={setLabelStatus}
              onExcludeFacet={excludeFacet}
              onAcceptEdges={async (accepted) => {
                cancelPending()   // a queued canvas write would clobber these labels
                setApplyingEdges(true)
                try {
                  // The roof as it is NOW: a section taken out as "Not roof"
                  // during the review must not come back with these lines.
                  const cur = geomRef.current.facets
                  const live = new Set(cur.map(f => f.label))
                  const updatedEdges = accepted.filter(e => live.has(e.facetLabel))
                  setEdges(updatedEdges)
                  setEditorSyncRev(r => r + 1)   // show the labels on the editor canvas
                  // Persist FIRST, then bump geometryStamp so MeasurementsSummary
                  // refetches against the saved edges.
                  await persistGeometry(cur, updatedEdges)
                  setGeometryStamp(s => s + 1)
                } finally {
                  setApplyingEdges(false)
                }
              }}
            />
          )}

          <MeasurementsSummary
            runId={runId}
            geometryStamp={geometryStamp}
            busy={applyingEdges}
            onConfidenceChange={setConfidence}
            onIssuesChange={(b, sig) => { setBlockingIssues(b); setPartialSignals(sig) }}
            unlabeledCount={edgeCounts.needsLabel}
            unconfirmedCount={edgeCounts.needsConfirm}
            runConfirmed={runConfirmed}
            zip={project?.zip}
            city={project?.city}
            onForceSave={async () => { cancelPending(); await persistGeometry(facets, edges) }}
            onWrongHouse={startOverHouse}
            embeddedGate
            confirmRequest={reportConfirmReq}
            onAwaitingConfirmChange={setAwaitingReportConfirm}
            onShowingChange={setShowingMeasurements}
          />

          {/* Bottom actions — only once every line is labeled and confirmed and
              the numbers are on screen. Until then the status card leads. */}
          {facets.length > 0 && edgeCounts.totalLines > 0 && edgeCounts.needsLabel === 0 && edgeCounts.needsConfirm === 0 && showingMeasurements ? (
            <div className="flex flex-wrap items-center gap-3 border-t border-[#eeeeed] pt-4">
              <button onClick={() => setStep('details')} disabled={blockingIssues.length > 0}
                className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-50">
                Continue to details →
              </button>
              <button onClick={() => setStep('report')} disabled={blockingIssues.length > 0}
                className="rounded-lg border border-[#dededc] bg-white px-4 py-2.5 text-sm font-medium text-[#1a1a1a] hover:bg-[#f8f8f7] disabled:opacity-50">
                Skip to report
              </button>
              <button onClick={() => { void startOverHouse() }}
                className="ml-auto text-xs text-[#6b7280] underline underline-offset-2 hover:text-[#1a1a1a]">
                Wrong house? Start over
              </button>
            </div>
          ) : facets.length > 0 && (
            <div className="flex justify-end">
              <button onClick={() => { void startOverHouse() }}
                className="text-xs text-[#6b7280] underline underline-offset-2 hover:text-[#1a1a1a]">
                Wrong house? Start over
              </button>
            </div>
          )}
          </>)}
        </section>
      )}

      {/* DETAILS step — ground-photo intelligence, penetrations, and flashing.
          Kept out of the core measure canvas to declutter it; all of this still
          flows into the PDF report (it's read from the saved run data). */}
      {step === 'details' && runId && (
        <section className="space-y-4">
          <div className="rounded-lg border border-blue-400/20 bg-blue-500/5 p-3 text-xs text-blue-900">
            <strong>Details</strong> — fine-tune pitch from ground photos and add chimneys/skylights.
            Optional but recommended; everything here lands in your report.
          </div>

          {/* Ground-photo intelligence used to sit here, in the middle of the
              desk workflow, which implied you needed to be at the house to
              finish — the opposite of the product's promise. It now lives in
              the optional on-site section with the siding tool. */}
          {SHOW_SIDING && (
          <div className="rounded-lg border border-[#dededc] bg-[#f8f8f7] p-3 text-xs text-[#2d2d2d]">
            <strong className="text-[#1a1a1a]">Standing at the property?</strong>{' '}
            A few phone photos can read the real pitch, chimneys, skylights and materials — and you can
            measure siding while you&apos;re there. Everything on this page works without it.
            <button
              onClick={() => setStep('siding')}
              className="ml-2 underline hover:text-[#1a1a1a]"
            >Open on-site extras →</button>
          </div>
          )}

          <CollapsibleSection
            title="Penetrations"
            subtitle="Chimneys, skylights, and vents — these drive flashing and the final report."
            badge="chimneys · vents"
          >
          <PenetrationSuggestions runId={runId} imageUrl={imagery?.url} />
          </CollapsibleSection>

          {SHOW_FLASHING && (
          <CollapsibleSection
            title="Flashing"
            subtitle="Roof-to-wall transitions + chimney/skylight flashing, computed from your labeled edges."
            badge="linear ft"
            defaultOpen
          >
          <WallTransitionPanel
            runId={runId}
            facets={facets}
            edges={edges}
            imageUrl={imagery?.original_url || imagery?.url}
            imageWidthPx={imagery?.width_px ?? 2048}
            imageHeightPx={imagery?.height_px ?? 1366}
            onApplyEdges={(updated) => {
              cancelPending()   // same clobber risk as accepting labels
              setEdges(updated)
              setEditorSyncRev(r => r + 1)
              void persistGeometry(facets, updated)
            }}
          />
          <FlashingPanel runId={runId} />
          </CollapsibleSection>
          )}

          <PreReportChecklist runId={runId} facets={facets} edges={edges} />
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setStep('editor')}
              className="rounded bg-[#e4e4e2] px-4 py-2 text-sm text-[#1a1a1a] hover:bg-[#d4d4d2]"
            >← Back to measure</button>
            <button
              onClick={() => setStep('report')}
              disabled={facets.length === 0}
              className="rounded bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-50"
            >Continue to report →</button>
          </div>
        </section>
      )}

      {/* ON-SITE EXTRAS — the one place that assumes somebody is at the house.
          Kept deliberately separate from the measure → report path: the report
          is complete without any of it, and these two tools are the only things
          that need a site visit, so they belong together and nowhere else. */}
      {SHOW_SIDING && step === 'siding' && (
        <section className="space-y-4">
          <div className="rounded-lg border border-emerald-400/25 bg-emerald-500/[0.06] p-3 text-xs text-emerald-900/90">
            <span className="mr-2 rounded-full bg-emerald-600/80 px-2 py-0.5 text-[10px] font-semibold text-white">Optional — needs a site visit</span>
            Your report is already complete without this. If you happen to be at the property, these two
            tools sharpen it: ground photos confirm the <strong>real pitch</strong> and catch penetrations the
            satellite can&apos;t see, and the siding tool measures exterior wall area for
            siding, house-wrap, or paint scopes.
            <button
              onClick={() => setStep('report')}
              className="ml-2 underline hover:text-[#1a1a1a]"
            >Back to report →</button>
          </div>

          {runId && (
            <CollapsibleSection
              title="Ground-photo intelligence"
              subtitle="A few phone photos read pitch, chimneys/skylights, dormers, roof shape & materials — then apply the measured pitch to your drawn facets."
              badge="pitch + features"
              defaultOpen
            >
              <GroundPhotoPanel
                runId={runId}
                onApplyPitch={(pitch) => {
                  if (facets.length === 0) return false
                  const updated = facets.map(f => ({ ...f, pitch }))
                  cancelPending()   // ditto — a queued write holds the old pitches
                  setFacets(updated)
                  setGeometryStamp(s => s + 1)
                  setEditorSyncRev(r => r + 1)
                  void persistGeometry(updated, edges)
                  return true
                }}
                onChimneyAdded={() => setGeometryStamp(s => s + 1)}
              />
            </CollapsibleSection>
          )}

          {projectId && (
            <CollapsibleSection
              title="Siding measurement"
              subtitle="Exterior wall square footage from elevation photos — for siding replacement, house-wrap, exterior paint, or an insurance exterior scope."
              badge="wall sq ft"
            >
              <SidingMeasurementTool projectId={projectId} />
            </CollapsibleSection>
          )}

          <button
            onClick={() => setStep('report')}
            className="rounded bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-500"
          >Back to report →</button>
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

          {/* Good/Better/Best proposal — the last mile from measurement to signed job */}
          <ProposalPanel runId={runId} projectId={projectId} />

          {/* Adjuster Mode — Xactimate line codes + RCV/ACV claim summary */}
          {SHOW_ADJUSTER_MODE && <AdjusterModePanel runId={runId} />}

          {/* Homeowner portal — one link with live status, proposal, report, photos */}
          {projectId && <ClientPortalPanel projectId={projectId} />}

          {/* Accuracy flywheel + white-label branding */}
          {SHOW_JOB_VERIFICATION && userId && <JobVerificationPanel runId={runId} userId={userId} />}

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

          <section className="rounded-lg border border-[#dededc] bg-[#f8f8f7] p-4">
            <h2 className="mb-3 text-sm font-semibold">Confirm + download</h2>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Facets" value={facets.length.toString()} />
              <Stat label="Edges labeled" value={edges.filter(e => e.edgeType !== 'unlabeled').length.toString()} />
              <Stat label="Completeness"
                value={edges.some(e => e.edgeType === 'unlabeled') ? '…' : `${Math.round(confidence * 100)}%`}
                color={blockingIssues.length ? 'text-rose-800' : undefined} />
              <Stat label="Imagery" value={`${Math.round((imagery?.health_score ?? 0) * 100)}%`} />
            </div>
            {blockingIssues.length > 0 && (
              <div role="alert" className="mt-3 rounded-lg border border-rose-300 bg-rose-50 p-3 text-xs text-rose-900">
                <strong>Completeness is capped because this roof&apos;s measurements don&apos;t add up.</strong>
                <ul className="mt-1.5 list-disc space-y-1 pl-5">
                  {blockingIssues.map(c => <li key={c}>{ISSUE_TEXT[c] ?? c}</li>)}
                </ul>
                <div className="mt-1.5">A report can&apos;t be generated until this is resolved.</div>
              </div>
            )}
            {blockingIssues.length === 0 && partialSignals.length > 0 && (
              <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
                <strong>This looks like part of a roof rather than all of one.</strong>
                <ul className="mt-1.5 list-disc space-y-1 pl-5">
                  {partialSignals.map((t, i) => <li key={i}>{t}</li>)}
                </ul>
              </div>
            )}
            <p className="mt-3 text-xs text-[#6b7280]">
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
              {busy ? (reportQueueMsg ?? 'Generating…') : 'Confirm + download PDF report'}
            </button>
          </section>
        </>
      )}
    </div>
  )
}

// The validator codes, said the way a roofer would say them.
const ISSUE_TEXT: Record<string, string> = {
  ridge_exceeds_perimeter:
    'Ridge and hip run longer than the traced perimeter, which no roof can do. Usually some edges labelled ridge are really rakes or hips — or the outer edge of the roof is not traced yet.',
  no_eaves:
    'No eaves are labelled, so the outline has not been closed. Drip edge, gutter and ice-and-water depend on them.',
  squares_area_mismatch:
    'Squares and roof area disagree by more than 2%.',
  negative_length:
    'An edge has a negative length.',
  missing_pitch:
    'No pitch is set on any facet. Pitch drives area and every material quantity.',
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-md border border-[#dededc] bg-[#f8f8f7] p-2 text-xs">
      <div className="text-[#6b7280]">{label}</div>
      <div className={`text-sm font-semibold ${color ?? 'text-[#1a1a1a]'}`}>{value}</div>
    </div>
  )
}

/**
 * A new project starts from its address, and the address IS its name. Two
 * fields for the same thing (Ryan, 2026-10-01: "most of the time the user will
 * name the project the same as the address") only gave people a chance to
 * type it twice, differently.
 */
function NewProjectByAddress({
  userId, busy, onCreated, onError,
}: {
  userId: string | null
  busy: boolean
  onCreated: (project: Project, loc: LocationSelected) => void | Promise<void>
  onError: (msg: string) => void
}) {
  const [creating, setCreating] = useState(false)
  const [pickerKey, setPickerKey] = useState(0)

  const create = useCallback(async (loc: LocationSelected) => {
    if (!userId) {
      onError('Not signed in. Refresh and try again.')
      return
    }
    setCreating(true)
    try {
      const created = await api.projects.create({
        name: loc.matched_address,
        blueprint_type: 'residential',
        address: loc.matched_address || undefined,
        city: loc.city || undefined,
        state: loc.state || undefined,
        region: loc.state ? `US-${loc.state}` : undefined,
        zip_code: loc.zip || undefined,
        county: loc.county || undefined,
        lat: loc.lat || undefined,
        lng: loc.lng || undefined,
      }, userId)
      await onCreated(created as Project, loc)
      setPickerKey(k => k + 1)          // a fresh, empty box for the next job
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not create project')
    } finally {
      setCreating(false)
    }
  }, [userId, onCreated, onError])

  return (
    <div className={creating || busy ? 'pointer-events-none opacity-60' : ''}>
      <LocationPicker key={pickerKey} onSelected={(loc) => { void create(loc) }} />
      {creating && <p className="mt-2 text-xs text-[#6b7280]">Creating the project and loading the house…</p>}
    </div>
  )
}

/**
 * Whether the traced roof is on the server. Deliberately quiet when everything
 * is fine and loud when it isn't: a failed save used to surface only as an
 * error string far up the page, which is how "my facets don't save" went
 * unnoticed long enough to become a habit.
 */
function SaveIndicator({
  state, savedAt, onRetry,
}: {
  state: 'idle' | 'saving' | 'saved' | 'error'
  savedAt: number | null
  onRetry: () => void
}) {
  if (state === 'idle') return null
  if (state === 'error') {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2">
        <span className="text-xs font-semibold text-rose-900">⚠ Your roof isn&apos;t saved</span>
        <span className="text-[11px] text-rose-900/70">The last change didn&apos;t reach the server.</span>
        <button
          onClick={onRetry}
          className="ml-auto rounded bg-rose-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-rose-500"
        >Retry save</button>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2 px-1 text-[11px] text-[#6b7280]">
      {state === 'saving' ? (
        <>
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
          Saving…
        </>
      ) : (
        <>
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          Saved{savedAt ? ` at ${new Date(savedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}
        </>
      )}
    </div>
  )
}


/** A card centred over the page. Clicking the backdrop or pressing Esc closes it. */
function ScreenModal({ children, onClose }: { children: React.ReactNode; onClose?: () => void }) {
  useEffect(() => {
    if (!onClose) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose} role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
        {children}
      </div>
    </div>
  )
}

const MEASURE_STEPS = [
  'Getting Google\u2019s 3D model of this roof\u2026',
  'Finding every roof plane\u2026',
  'Measuring ridges, hips, valleys, eaves and rakes\u2026',
  'Almost done \u2014 putting the outline on the map\u2026',
]

/** Shown for the whole length of an auto-measure, so the click visibly did something. */
function MeasuringOverlay() {
  const [i, setI] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setI(v => Math.min(v + 1, MEASURE_STEPS.length - 1)), 6000)
    return () => clearInterval(t)
  }, [])
  return (
    <ScreenModal>
      <div className="flex items-center gap-4">
        <span className="h-8 w-8 shrink-0 animate-spin rounded-full border-[3px] border-blue-200 border-t-blue-600" />
        <div>
          <div className="text-base font-semibold text-[#1a1a1a]">Measuring your roof</div>
          <p className="mt-1 text-sm text-[#4b5563]">{MEASURE_STEPS[i]}</p>
        </div>
      </div>
      <p className="mt-4 text-xs text-[#6b7280]">Usually under 30 seconds. Keep this tab open.</p>
    </ScreenModal>
  )
}

/** "2021-09-03" -> "September 2021"; anything unparseable is returned as-is. */
function monthYear(iso: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(iso)
  if (!m) return iso
  return new Date(Number(m[1]), Number(m[2]) - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}
