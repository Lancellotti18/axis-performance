'use client'

/**
 * Axis Performance — Multi-facet roof editor.
 *
 * The contractor draws ONE polygon per roof plane (facet) over a satellite
 * tile, sets each facet's pitch, and labels each polygon edge as one of
 * eave / rake / ridge / hip / valley / wall_intersection.
 *
 * Everything downstream — area, perimeter, ridge cap, drip edge, materials —
 * is computed deterministically from these inputs by the backend. No AI
 * guesses end up in the material order.
 *
 * Modes:
 *   - draw    : click to add vertices; double-click (or Enter) closes the facet
 *   - select  : click a vertex to drag; click an edge to open its label menu
 *   - label   : click each edge in sequence; rotates through the edge-type chips
 *
 * Edge types are color-coded:
 *   eave    — orange
 *   rake    — blue
 *   ridge   — purple
 *   hip     — green
 *   valley  — red
 *   wall_intersection — gray
 *   unlabeled — translucent white
 *
 * Coords: image-fraction (0..1, origin top-left). Compatible with the
 * existing RoofOutlineEditor convention.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { buildEdgeMap, clearEdgeCache, snapToNearestEdge } from '@/lib/edgeSnap'

export type EdgeType =
  | 'eave' | 'rake' | 'ridge' | 'hip' | 'valley'
  | 'gable_end' | 'wall_intersection' | 'unlabeled'

export type Pt = [number, number]

export interface Facet {
  label: string                  // 'A', 'B', etc.
  polygon: Pt[]                   // closed ring, do NOT repeat first vertex
  pitch: string                   // 'X/12'
  confidence: number              // 0..1
  userConfirmed: boolean
  aiSuggested?: boolean           // true if it originated from AI (training provenance)
}

export interface LabeledEdge {
  facetLabel: string
  vertexIndexStart: number
  vertexIndexEnd: number
  edgeType: EdgeType
  sharedWithFacetLabel?: string
  userConfirmed: boolean
}

interface Props {
  imageUrl: string
  imageWidthPx: number
  imageHeightPx: number
  initialFacets?: Facet[]
  initialEdges?: LabeledEdge[]
  onChange: (facets: Facet[], edges: LabeledEdge[]) => void
  // Bump this from the parent to pull EXTERNAL facet/edge changes (e.g. an
  // accepted auto-label suggestion) into the editor so they show on the canvas.
  syncRev?: number
  // Toolbar "Auto-label edges" button — runs the AI edge-label suggestion flow.
  onAutoLabelEdges?: () => void
}

const PITCH_OPTIONS = ['2/12', '3/12', '4/12', '5/12', '6/12', '7/12', '8/12', '9/12', '10/12', '12/12']

const EDGE_COLORS: Record<EdgeType, string> = {
  eave: '#fb923c',
  rake: '#60a5fa',
  ridge: '#a78bfa',
  hip: '#34d399',
  valley: '#f87171',
  gable_end: '#fde68a',
  wall_intersection: '#9ca3af',
  unlabeled: 'rgba(255,255,255,0.55)',
}

const FACET_LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

type Mode = 'draw' | 'select' | 'label'

const SHARED_TOL = 0.005   // image-fraction tolerance for "same edge"

function pointsClose(a: Pt, b: Pt, tol = SHARED_TOL): boolean {
  return Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol
}

function segmentsOverlap(a1: Pt, a2: Pt, b1: Pt, b2: Pt): boolean {
  return (pointsClose(a1, b1) && pointsClose(a2, b2)) || (pointsClose(a1, b2) && pointsClose(a2, b1))
}

function findSharedFacet(
  edgeFrom: Facet, edgeIdxStart: number,
  allFacets: Facet[],
): string | undefined {
  const p1 = edgeFrom.polygon[edgeIdxStart]
  const p2 = edgeFrom.polygon[(edgeIdxStart + 1) % edgeFrom.polygon.length]
  for (const other of allFacets) {
    if (other.label === edgeFrom.label) continue
    const n = other.polygon.length
    for (let i = 0; i < n; i++) {
      const q1 = other.polygon[i]
      const q2 = other.polygon[(i + 1) % n]
      if (segmentsOverlap(p1, p2, q1, q2)) return other.label
    }
  }
  return undefined
}

function clampFrac(v: number): number {
  return Math.max(0, Math.min(1, v))
}

// Magnetic vertex-snap radius in image fractions (~12px on a 1000px display).
// When the cursor is within this of an existing vertex, the new vertex locks
// onto it exactly — so adjacent facets share a ridge/valley vertex precisely.
const VERTEX_SNAP_FRAC = 0.012

/**
 * Constrain the candidate vertex `to` so that the segment from `from` is at
 * the nearest multiple of 45° (0/45/90/135/180/225/270/315). Works in pixel
 * space (using imageW/imageH to convert to/from fractional coords).
 * Preserves the distance of the original cursor from the anchor.
 */
function constrainTo45(from: Pt, to: Pt, imageW: number, imageH: number): Pt {
  const fromX = from[0] * imageW
  const fromY = from[1] * imageH
  const toX = to[0] * imageW
  const toY = to[1] * imageH
  const dx = toX - fromX
  const dy = toY - fromY
  const dist = Math.hypot(dx, dy)
  if (dist === 0) return to
  const angle = Math.atan2(dy, dx)
  // Round to nearest 45° (π/4 radians)
  const stepped = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4)
  const snappedX = fromX + Math.cos(stepped) * dist
  const snappedY = fromY + Math.sin(stepped) * dist
  return [clampFrac(snappedX / imageW), clampFrac(snappedY / imageH)]
}

export function RoofFacetEditor({
  imageUrl, imageWidthPx, imageHeightPx,
  initialFacets = [], initialEdges = [], onChange, syncRev, onAutoLabelEdges,
}: Props) {
  const [facets, setFacets] = useState<Facet[]>(initialFacets)
  const [edges, setEdges] = useState<LabeledEdge[]>(initialEdges)

  // Pull EXTERNAL facet/edge changes onto the canvas when the parent bumps
  // syncRev (e.g. after accepting an auto-labeled edge or AI facet). Skips the
  // first render so it doesn't clobber the editor's own in-progress work.
  const firstSync = useRef(true)
  useEffect(() => {
    if (firstSync.current) { firstSync.current = false; return }
    setFacets(initialFacets)
    setEdges(initialEdges)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncRev])

  const [mode, setMode] = useState<Mode>('draw')
  const [activeFacetIdx, setActiveFacetIdx] = useState<number | null>(null)
  const [drawingPoly, setDrawingPoly] = useState<Pt[]>([])
  const [dragVertex, setDragVertex] = useState<{ facetIdx: number; vertexIdx: number } | null>(null)
  const [selectedEdge, setSelectedEdge] = useState<{ facetIdx: number; edgeIdx: number } | null>(null)
  const [imageDims, setImageDims] = useState({ w: imageWidthPx, h: imageHeightPx })
  // Live cursor position (image fractions) while drawing — drives the
  // rubber-band preview line + the "where will this click land" preview dot.
  const [hoverPt, setHoverPt] = useState<Pt | null>(null)
  const [hoverSnappedVertex, setHoverSnappedVertex] = useState(false)

  // First-use coachmark (shown once, dismissed to localStorage).
  const [showCoach, setShowCoach] = useState(false)
  useEffect(() => {
    try {
      if (!localStorage.getItem('axis_editor_coach_v1')) setShowCoach(true)
    } catch { /* private mode — just skip */ }
  }, [])
  const dismissCoach = useCallback(() => {
    setShowCoach(false)
    try { localStorage.setItem('axis_editor_coach_v1', '1') } catch { /* ignore */ }
  }, [])

  // Snap-to-edge: when on, vertex placements snap to the nearest high-gradient
  // pixel within a small radius. Massively improves tracing on blurry imagery.
  const [snapEnabled, setSnapEnabled] = useState(true)
  const [snapReady, setSnapReady] = useState(false)

  // Orthogonality snap: when Shift is held during a click, the new vertex is
  // constrained to a multiple of 45° from the previous one (typical for
  // residential roofs that are mostly right-angled).
  const [shiftHeld, setShiftHeld] = useState(false)

  // Build the edge gradient map whenever the imagery changes. Runs once per
  // tile load (~80–150ms on a 2K tile).
  useEffect(() => {
    if (!imageUrl) {
      setSnapReady(false)
      clearEdgeCache()
      return
    }
    let cancelled = false
    setSnapReady(false)
    buildEdgeMap(imageUrl)
      .then(() => { if (!cancelled) setSnapReady(true) })
      .catch(err => { console.warn('edge map build failed:', err); if (!cancelled) setSnapReady(false) })
    return () => { cancelled = true; clearEdgeCache() }
  }, [imageUrl])

  // Track Shift for orthogonality constraint
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => { if (e.key === 'Shift') setShiftHeld(true) }
    const onUp = (e: KeyboardEvent) => { if (e.key === 'Shift') setShiftHeld(false) }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
    }
  }, [])
  // Pan + zoom for the canvas. Pure CSS transform on the inner stage — the
  // SVG's getBoundingClientRect() reports the transformed rect so vertex
  // click math (eventToFrac) keeps producing correct image fractions.
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 })
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [panning, setPanning] = useState<{
    startClientX: number; startClientY: number; origX: number; origY: number
  } | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const lastOnChangeRef = useRef<string>('')

  // Notify parent whenever facets or edges change — JSON-compare to avoid loops.
  useEffect(() => {
    const snap = JSON.stringify({ facets, edges })
    if (snap === lastOnChangeRef.current) return
    lastOnChangeRef.current = snap
    onChange(facets, edges)
  }, [facets, edges, onChange])

  // ---- Undo / redo ----
  // Snapshots every facets/edges mutation automatically (draw, delete, drag,
  // relabel — all of them). A "time-travel" flag prevents undo/redo restores
  // from being recorded as new history entries.
  const historyRef = useRef<{ past: string[]; future: string[] }>({ past: [], future: [] })
  const lastHistSnapRef = useRef<string>('')
  const timeTravelRef = useRef(false)
  const [histVersion, setHistVersion] = useState(0)   // forces toolbar re-render

  useEffect(() => {
    const snap = JSON.stringify({ facets, edges })
    if (snap === lastHistSnapRef.current) return
    if (timeTravelRef.current) {
      timeTravelRef.current = false
      lastHistSnapRef.current = snap
      return
    }
    if (lastHistSnapRef.current) historyRef.current.past.push(lastHistSnapRef.current)
    if (historyRef.current.past.length > 100) historyRef.current.past.shift()
    historyRef.current.future = []
    lastHistSnapRef.current = snap
    setHistVersion(v => v + 1)
  }, [facets, edges])

  const restoreSnapshot = useCallback((raw: string) => {
    try {
      const parsed = JSON.parse(raw) as { facets: Facet[]; edges: LabeledEdge[] }
      timeTravelRef.current = true
      lastHistSnapRef.current = raw
      setFacets(parsed.facets)
      setEdges(parsed.edges)
      setDrawingPoly([])
    } catch { /* ignore corrupt snapshot */ }
  }, [])

  const undo = useCallback(() => {
    const h = historyRef.current
    if (!h.past.length) return
    h.future.push(lastHistSnapRef.current)
    restoreSnapshot(h.past.pop() as string)
    setHistVersion(v => v + 1)
  }, [restoreSnapshot])

  const redo = useCallback(() => {
    const h = historyRef.current
    if (!h.future.length) return
    h.past.push(lastHistSnapRef.current)
    restoreSnapshot(h.future.pop() as string)
    setHistVersion(v => v + 1)
  }, [restoreSnapshot])

  const canUndo = historyRef.current.past.length > 0
  const canRedo = historyRef.current.future.length > 0
  void histVersion   // referenced so the linter keeps the re-render trigger

  // Cmd/Ctrl+Z = undo, Cmd/Ctrl+Shift+Z or Ctrl+Y = redo. Global, but ignores
  // keystrokes while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (!(e.metaKey || e.ctrlKey)) return
      const k = e.key.toLowerCase()
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo() }
      else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo])

  // ---- Coordinate helpers ----
  const eventToFrac = useCallback((ev: React.PointerEvent | PointerEvent): Pt => {
    const svg = svgRef.current
    if (!svg) return [0, 0]
    const rect = svg.getBoundingClientRect()
    const x = (ev.clientX - rect.left) / rect.width
    const y = (ev.clientY - rect.top) / rect.height
    return [clampFrac(x), clampFrac(y)]
  }, [])

  // ---- Pan + zoom (CSS transform on the stage) ----
  const MIN_SCALE = 1
  const MAX_SCALE = 12

  const setViewClamped = useCallback((nextScale: number, anchorX: number, anchorY: number) => {
    // Anchor zoom at the cursor — the world point under (anchorX, anchorY) in
    // container-local pixels stays under the cursor after scaling.
    setView(prev => {
      const clamped = Math.max(MIN_SCALE, Math.min(MAX_SCALE, nextScale))
      const worldX = (anchorX - prev.x) / prev.scale
      const worldY = (anchorY - prev.y) / prev.scale
      let nx = anchorX - worldX * clamped
      let ny = anchorY - worldY * clamped
      // When fully zoomed out we reset the offset so the image always fits.
      if (clamped <= 1) { nx = 0; ny = 0 }
      return { scale: clamped, x: nx, y: ny }
    })
  }, [])

  const onWheel = useCallback((ev: React.WheelEvent<HTMLDivElement>) => {
    ev.preventDefault()
    const container = containerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    const cx = ev.clientX - rect.left
    const cy = ev.clientY - rect.top
    const factor = ev.deltaY < 0 ? 1.18 : 1 / 1.18
    setViewClamped(view.scale * factor, cx, cy)
  }, [view.scale, setViewClamped])

  const zoomIn = useCallback(() => {
    const c = containerRef.current
    if (!c) return
    const r = c.getBoundingClientRect()
    setViewClamped(view.scale * 1.4, r.width / 2, r.height / 2)
  }, [view.scale, setViewClamped])

  const zoomOut = useCallback(() => {
    const c = containerRef.current
    if (!c) return
    const r = c.getBoundingClientRect()
    setViewClamped(view.scale / 1.4, r.width / 2, r.height / 2)
  }, [view.scale, setViewClamped])

  const resetView = useCallback(() => setView({ scale: 1, x: 0, y: 0 }), [])

  // Instant pan by pixels (used by the keypad + continuous keyboard pan).
  // Panning the CSS view never refetches and never misaligns facets — facets
  // are stored in image-fraction coords tied to THIS tile, so a refetch (the
  // old keypad behavior) would shift them. CSS pan just moves the camera.
  const panView = useCallback((dx: number, dy: number) => {
    setView(prev => (prev.scale <= MIN_SCALE ? prev : { ...prev, x: prev.x + dx, y: prev.y + dy }))
  }, [])

  // Continuous arrow / WASD pan while held, with acceleration. Skipped while
  // typing in an input and while a facet is being drawn (arrows free, but we
  // guard inputs). Only active in select/label modes-agnostic — panning is
  // always allowed; drawing uses clicks, not arrows.
  const heldPanKeys = useRef<Set<string>>(new Set())
  const panHoldStart = useRef<number>(0)
  const panRaf = useRef<number | null>(null)
  useEffect(() => {
    const DIRS: Record<string, [number, number]> = {
      ArrowUp: [0, 1], ArrowDown: [0, -1], ArrowLeft: [1, 0], ArrowRight: [-1, 0],
      w: [0, 1], s: [0, -1], a: [1, 0], d: [-1, 0],
    }
    const typing = (t: EventTarget | null) => {
      const tag = (t as HTMLElement | null)?.tagName
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
    }
    const tick = () => {
      if (heldPanKeys.current.size === 0) { panRaf.current = null; return }
      const ms = performance.now() - panHoldStart.current
      const speed = Math.min(26, 7 + ms / 45)
      let dx = 0, dy = 0
      for (const k of heldPanKeys.current) {
        const v = DIRS[k]; if (v) { dx += v[0]; dy += v[1] }
      }
      if (dx || dy) panView(dx * speed, dy * speed)
      panRaf.current = requestAnimationFrame(tick)
    }
    const onDown = (e: KeyboardEvent) => {
      if (typing(e.target)) return
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key
      if (!(k in DIRS)) return
      e.preventDefault()
      if (heldPanKeys.current.size === 0) panHoldStart.current = performance.now()
      heldPanKeys.current.add(k)
      if (panRaf.current == null) panRaf.current = requestAnimationFrame(tick)
    }
    const onUp = (e: KeyboardEvent) => {
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key
      heldPanKeys.current.delete(k)
    }
    const onBlur = () => heldPanKeys.current.clear()
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      window.removeEventListener('blur', onBlur)
      if (panRaf.current != null) cancelAnimationFrame(panRaf.current)
      panRaf.current = null
      heldPanKeys.current.clear()
    }
  }, [panView])

  // Spacebar = pan modifier. Don't grab it when the user is typing in an input.
  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      const tag = (ev.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (ev.code === 'Space') {
        ev.preventDefault()
        setSpaceHeld(true)
      }
    }
    const onKeyUp = (ev: KeyboardEvent) => {
      if (ev.code === 'Space') setSpaceHeld(false)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  // Pan with middle-mouse or space+left-mouse. Runs at the container level so
  // it works regardless of which child the pointer is over.
  const onContainerPointerDown = useCallback((ev: React.PointerEvent<HTMLDivElement>) => {
    const wantsPan = ev.button === 1 || (ev.button === 0 && spaceHeld)
    if (!wantsPan) return
    ev.preventDefault()
    setPanning({
      startClientX: ev.clientX, startClientY: ev.clientY,
      origX: view.x, origY: view.y,
    })
  }, [spaceHeld, view.x, view.y])

  useEffect(() => {
    if (!panning) return
    const onMove = (ev: PointerEvent) => {
      setView(prev => ({
        scale: prev.scale,
        x: panning.origX + (ev.clientX - panning.startClientX),
        y: panning.origY + (ev.clientY - panning.startClientY),
      }))
    }
    const onUp = () => setPanning(null)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [panning])

  // ---- Drawing flow ----
  // Resolve a raw cursor point into the final vertex position, applying (in
  // order): orthogonality constraint (Shift), magnetic vertex snap (to any
  // existing facet vertex — makes shared ridges/valleys trace ONCE and align
  // perfectly), then edge snap (to the strongest nearby image gradient).
  // Returns the resolved point + whether it locked onto an existing vertex.
  const resolvePoint = useCallback((raw: Pt): { pt: Pt; onVertex: boolean } => {
    let pt = raw

    // 1. Orthogonality (Shift)
    if (shiftHeld && drawingPoly.length > 0) {
      pt = constrainTo45(drawingPoly[drawingPoly.length - 1], pt, imageDims.w, imageDims.h)
    }

    // 2. Magnetic vertex snap — strongest assist for topology correctness.
    //    Scale the radius INVERSELY with zoom: when the contractor zooms in to
    //    work in a tight space, the fraction-space threshold shrinks so it
    //    stops fighting precise placement near existing vertices.
    const snapRadius = VERTEX_SNAP_FRAC / Math.max(1, view.scale)
    let best: Pt | null = null
    let bestD = snapRadius
    for (const f of facets) {
      for (const v of f.polygon) {
        const d = Math.hypot(v[0] - pt[0], v[1] - pt[1])
        if (d < bestD) { bestD = d; best = v }
      }
    }
    if (best) return { pt: [best[0], best[1]], onVertex: true }

    // 3. Edge snap (gradient) — radius also tightens with zoom.
    if (snapEnabled && snapReady) {
      const edgeRadius = Math.max(5, Math.round(14 / Math.max(1, view.scale * 0.6)))
      const snapped = snapToNearestEdge(pt[0] * imageDims.w, pt[1] * imageDims.h, edgeRadius)
      if (snapped.snapped) pt = [snapped.x / imageDims.w, snapped.y / imageDims.h]
    }
    return { pt, onVertex: false }
  }, [shiftHeld, drawingPoly, facets, snapEnabled, snapReady, imageDims, view.scale])

  const onSvgPointerDown = useCallback((ev: React.PointerEvent<SVGSVGElement>) => {
    if (mode !== 'draw') return
    if (ev.button !== 0) return
    const { pt } = resolvePoint(eventToFrac(ev))

    // Close polygon if the resolved point is near the first vertex. Threshold
    // shrinks with zoom so it doesn't auto-close prematurely in tight spaces.
    if (drawingPoly.length >= 3) {
      const [fx, fy] = drawingPoly[0]
      const cx = 0.012 / Math.max(1, view.scale)
      const cy = 0.018 / Math.max(1, view.scale)
      if (Math.abs(pt[0] - fx) < cx && Math.abs(pt[1] - fy) < cy) {
        finalizeDrawingPoly()
        return
      }
    }
    setDrawingPoly(prev => [...prev, pt])
  }, [mode, drawingPoly, eventToFrac, resolvePoint, view.scale])

  // Rubber-band: track the cursor while drawing so we can show the line that
  // WOULD be drawn + a preview dot that magnetizes to edges/vertices.
  const onSvgPointerMove = useCallback((ev: React.PointerEvent<SVGSVGElement>) => {
    if (mode !== 'draw') { if (hoverPt) setHoverPt(null); return }
    const { pt, onVertex } = resolvePoint(eventToFrac(ev))
    setHoverPt(pt)
    setHoverSnappedVertex(onVertex)
  }, [mode, resolvePoint, eventToFrac, hoverPt])

  const onSvgPointerLeave = useCallback(() => setHoverPt(null), [])

  const finalizeDrawingPoly = useCallback(() => {
    if (drawingPoly.length < 3) {
      setDrawingPoly([])
      return
    }
    const label = FACET_LABELS[facets.length] || `F${facets.length + 1}`
    const newFacet: Facet = {
      label,
      polygon: drawingPoly,
      pitch: '6/12',
      confidence: 0.8,
      userConfirmed: true,
    }
    const newFacets = [...facets, newFacet]
    setFacets(newFacets)
    setDrawingPoly([])
    // Initialize edges for this new facet as unlabeled
    const newEdges: LabeledEdge[] = []
    for (let i = 0; i < drawingPoly.length; i++) {
      const shared = findSharedFacet({ ...newFacet, polygon: drawingPoly }, i, facets)
      newEdges.push({
        facetLabel: label,
        vertexIndexStart: i,
        vertexIndexEnd: (i + 1) % drawingPoly.length,
        edgeType: shared ? 'ridge' : 'unlabeled',
        sharedWithFacetLabel: shared,
        userConfirmed: false,
      })
    }
    setEdges(prev => [...prev, ...newEdges])
    setActiveFacetIdx(newFacets.length - 1)
    setMode('label')   // jump straight into edge labeling
  }, [drawingPoly, facets])

  // ---- Vertex dragging ----
  const onVertexPointerDown = useCallback((
    ev: React.PointerEvent, facetIdx: number, vertexIdx: number,
  ) => {
    if (mode !== 'select') return
    ev.stopPropagation()
    ev.preventDefault()
    setDragVertex({ facetIdx, vertexIdx })
  }, [mode])

  useEffect(() => {
    if (!dragVertex) return
    const onMove = (ev: PointerEvent) => {
      const pt = eventToFrac(ev as unknown as React.PointerEvent)
      setFacets(prev => prev.map((f, i) => {
        if (i !== dragVertex.facetIdx) return f
        const poly = f.polygon.map((p, j) => (j === dragVertex.vertexIdx ? pt : p))
        return { ...f, polygon: poly }
      }))
    }
    const onUp = () => {
      // Recompute edge plan lengths is server-side; client just persists vertex moves.
      // Re-evaluate shared_with for this facet's edges since vertices moved.
      setEdges(prev => prev.map(e => {
        if (e.facetLabel !== facets[dragVertex.facetIdx]?.label) return e
        const facet = facets[dragVertex.facetIdx]
        if (!facet) return e
        const shared = findSharedFacet(facet, e.vertexIndexStart, facets)
        return { ...e, sharedWithFacetLabel: shared }
      }))
      setDragVertex(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [dragVertex, eventToFrac, facets])

  // ---- Edge labeling ----
  const cycleEdgeLabel = useCallback((facetIdx: number, edgeIdx: number) => {
    const facet = facets[facetIdx]
    if (!facet) return
    const order: EdgeType[] = ['unlabeled', 'eave', 'rake', 'ridge', 'hip', 'valley', 'wall_intersection']
    setEdges(prev => prev.map((e) => {
      if (e.facetLabel !== facet.label || e.vertexIndexStart !== edgeIdx) return e
      const idx = order.indexOf(e.edgeType)
      const next = order[(idx + 1) % order.length]
      return { ...e, edgeType: next, userConfirmed: true }
    }))
  }, [facets])

  const setEdgeLabel = useCallback((facetIdx: number, edgeIdx: number, type: EdgeType) => {
    const facet = facets[facetIdx]
    if (!facet) return
    setEdges(prev => prev.map((e) => {
      if (e.facetLabel !== facet.label || e.vertexIndexStart !== edgeIdx) return e
      return { ...e, edgeType: type, userConfirmed: true }
    }))
  }, [facets])

  // ---- Facet pitch / delete ----
  const setFacetPitch = useCallback((facetIdx: number, pitch: string) => {
    setFacets(prev => prev.map((f, i) => (i === facetIdx ? { ...f, pitch } : f)))
  }, [])

  const deleteFacet = useCallback((facetIdx: number) => {
    const facet = facets[facetIdx]
    if (!facet) return
    setFacets(prev => prev.filter((_, i) => i !== facetIdx))
    setEdges(prev => prev.filter(e => e.facetLabel !== facet.label))
    if (activeFacetIdx === facetIdx) setActiveFacetIdx(null)
  }, [facets, activeFacetIdx])

  // ---- Image load handler — capture intrinsic dims so SVG scales correctly ----
  const onImageLoad = useCallback((ev: React.SyntheticEvent<HTMLImageElement>) => {
    const img = ev.currentTarget
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      setImageDims({ w: img.naturalWidth, h: img.naturalHeight })
    }
  }, [])

  // ---- Derived geometry for live display (rough — server is source of truth) ----
  const liveStats = useMemo(() => {
    if (facets.length === 0) return { planSqft: 0, perimeterFt: 0 }
    // Without lat/zoom on the client we can't do real ft; show ratio-based estimates
    // by scaling shoelace areas to image dimensions. The right number comes from
    // the server `recompute` call after the editor publishes. We render this just
    // as a "non-zero, your polygon has some area" feedback.
    let totalFracArea = 0
    for (const f of facets) {
      const n = f.polygon.length
      let s = 0
      for (let i = 0; i < n; i++) {
        const [x1, y1] = f.polygon[i]
        const [x2, y2] = f.polygon[(i + 1) % n]
        s += x1 * y2 - x2 * y1
      }
      totalFracArea += Math.abs(s) / 2
    }
    return { fracArea: totalFracArea, facetCount: facets.length }
  }, [facets])

  // ---- SVG rendering ----
  const renderFacetPolygon = (f: Facet, idx: number) => {
    const points = f.polygon.map(([x, y]) => `${x * imageDims.w},${y * imageDims.h}`).join(' ')
    const isActive = activeFacetIdx === idx
    return (
      <g key={f.label}>
        <polygon
          points={points}
          fill={isActive ? 'rgba(96,165,250,0.18)' : 'rgba(96,165,250,0.08)'}
          stroke="rgba(0,0,0,0.0)"
          strokeWidth={0}
        />
        {/* Edge segments, color-coded by label */}
        {f.polygon.map((p1, i) => {
          const p2 = f.polygon[(i + 1) % f.polygon.length]
          const edgeRec = edges.find(
            e => e.facetLabel === f.label && e.vertexIndexStart === i,
          )
          const color = edgeRec ? EDGE_COLORS[edgeRec.edgeType] : EDGE_COLORS.unlabeled
          const isSel = selectedEdge?.facetIdx === idx && selectedEdge.edgeIdx === i
          return (
            <g key={i}>
              {/* Pulsing white halo so the SELECTED edge is unmistakable —
                  driven by clicking or hovering its row in the edge list. */}
              {isSel && (
                <line
                  x1={p1[0] * imageDims.w} y1={p1[1] * imageDims.h}
                  x2={p2[0] * imageDims.w} y2={p2[1] * imageDims.h}
                  stroke="#ffffff" strokeWidth={12 / view.scale} strokeLinecap="round"
                  pointerEvents="none"
                >
                  <animate attributeName="opacity" values="0.25;0.75;0.25" dur="1.1s" repeatCount="indefinite" />
                </line>
              )}
              <line
                x1={p1[0] * imageDims.w} y1={p1[1] * imageDims.h}
                x2={p2[0] * imageDims.w} y2={p2[1] * imageDims.h}
                stroke={color}
                strokeWidth={(isSel ? 7 : 4) / view.scale}
                strokeLinecap="round"
                style={{ cursor: mode === 'label' || mode === 'select' ? 'pointer' : 'default' }}
                onClick={(ev) => {
                  if (mode === 'label') {
                    ev.stopPropagation()
                    cycleEdgeLabel(idx, i)
                    setSelectedEdge({ facetIdx: idx, edgeIdx: i })
                  } else if (mode === 'select') {
                    ev.stopPropagation()
                    setSelectedEdge({ facetIdx: idx, edgeIdx: i })
                    setActiveFacetIdx(idx)
                  }
                }}
              />
            </g>
          )
        })}
        {/* Vertices */}
        {f.polygon.map(([x, y], i) => (
          <circle
            key={i}
            cx={x * imageDims.w} cy={y * imageDims.h} r={8 / view.scale}
            fill="white"
            stroke={isActive ? '#3b82f6' : '#475569'}
            strokeWidth={2 / view.scale}
            style={{ cursor: mode === 'select' ? 'grab' : 'default' }}
            onPointerDown={(ev) => onVertexPointerDown(ev, idx, i)}
          />
        ))}
        {/* Label */}
        {f.polygon.length > 0 && (() => {
          const cx = f.polygon.reduce((s, p) => s + p[0], 0) / f.polygon.length
          const cy = f.polygon.reduce((s, p) => s + p[1], 0) / f.polygon.length
          return (
            <g
              transform={`translate(${cx * imageDims.w}, ${cy * imageDims.h}) scale(${1 / view.scale})`}
              style={{ cursor: 'pointer' }}
              onClick={(ev) => { ev.stopPropagation(); setActiveFacetIdx(idx) }}
            >
              <circle r={18} fill={isActive ? '#1e40af' : '#1f2937'} fillOpacity={0.85} />
              <text
                textAnchor="middle" dominantBaseline="central"
                fill="white" fontSize={18} fontWeight={700}
              >{f.label}</text>
            </g>
          )
        })()}
      </g>
    )
  }

  return (
    <div className="flex h-full w-full flex-col gap-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-white/10 bg-slate-900/60 p-2 text-sm text-slate-200">
        <span className="font-semibold text-slate-300">Mode:</span>
        {(['draw', 'select', 'label'] as Mode[]).map(m => (
          <button
            key={m}
            onClick={() => { setMode(m); setSelectedEdge(null) }}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
              mode === m
                ? 'bg-blue-600 text-white'
                : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
            }`}
          >
            {m === 'draw' ? '+ Draw facet' : m === 'select' ? 'Edit vertices' : 'Label edges'}
          </button>
        ))}
        {onAutoLabelEdges && (
          <button
            onClick={onAutoLabelEdges}
            disabled={facets.length === 0}
            title="Let AI label every edge (eave/rake/ridge/hip/valley), then review — or label by hand"
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-40"
          >✨ Auto-label edges</button>
        )}
        <div className="mx-2 h-5 w-px bg-white/10" />
        {/* Undo / redo */}
        <button
          onClick={undo}
          disabled={!canUndo}
          title="Undo (⌘Z / Ctrl+Z)"
          className="rounded-md bg-slate-800 px-2 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700 disabled:opacity-30"
        >↶ Undo</button>
        <button
          onClick={redo}
          disabled={!canRedo}
          title="Redo (⌘⇧Z / Ctrl+Y)"
          className="rounded-md bg-slate-800 px-2 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700 disabled:opacity-30"
        >↷ Redo</button>
        <div className="mx-2 h-5 w-px bg-white/10" />
        <span className="text-xs text-slate-400">
          {facets.length} facet{facets.length === 1 ? '' : 's'}
        </span>
        {/* Snap-to-edge + orthogonality controls (only matter in draw mode) */}
        {mode === 'draw' && (
          <>
            <div className="mx-2 h-5 w-px bg-white/10" />
            <label className="flex items-center gap-1.5 text-xs text-slate-300">
              <input
                type="checkbox"
                checked={snapEnabled}
                onChange={e => setSnapEnabled(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-slate-600 bg-slate-800"
              />
              Snap to edge
              {snapEnabled && (
                <span className={snapReady ? 'text-emerald-400' : 'text-amber-400'}>
                  {snapReady ? '●' : '◐'}
                </span>
              )}
            </label>
            <span
              className={`rounded px-2 py-0.5 text-[10px] ${
                shiftHeld ? 'bg-blue-500/30 text-blue-200' : 'bg-slate-800 text-slate-500'
              }`}
              title="Hold Shift while clicking to constrain new vertex to 45° angles from the previous one"
            >
              ⇧ {shiftHeld ? 'ortho ON' : 'ortho (hold ⇧)'}
            </span>
          </>
        )}
        {mode === 'draw' && drawingPoly.length > 0 && (
          <span className="rounded bg-amber-500/20 px-2 py-1 text-xs text-amber-200">
            Drawing — {drawingPoly.length} vertex{drawingPoly.length === 1 ? '' : 'es'}. Click first dot or press Enter to close.
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {mode === 'draw' && drawingPoly.length >= 3 && (
            <button
              onClick={finalizeDrawingPoly}
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500"
            >Close facet</button>
          )}
          {mode === 'draw' && drawingPoly.length > 0 && (
            <button
              onClick={() => setDrawingPoly([])}
              className="rounded-md bg-slate-700 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-600"
            >Cancel</button>
          )}
        </div>
      </div>

      <div className="flex flex-1 gap-3">
        {/* Canvas */}
        <div
          ref={containerRef}
          className="relative flex-1 overflow-hidden rounded-lg border border-white/10 bg-black"
          onKeyDown={(ev) => {
            if (ev.key === 'Enter' && mode === 'draw' && drawingPoly.length >= 3) {
              finalizeDrawingPoly()
            }
            if (ev.key === 'Escape' && mode === 'draw') {
              setDrawingPoly([])
            }
            if (ev.key === '+' || ev.key === '=') zoomIn()
            if (ev.key === '-' || ev.key === '_') zoomOut()
            if (ev.key === '0') resetView()
          }}
          onWheel={onWheel}
          onPointerDown={onContainerPointerDown}
          tabIndex={0}
          style={{
            cursor: panning ? 'grabbing' : spaceHeld ? 'grab' : undefined,
          }}
        >
          {/* Transformed stage — image + svg move/scale together */}
          <div
            ref={stageRef}
            className="absolute inset-0"
            style={{
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
              transformOrigin: '0 0',
              willChange: 'transform',
            }}
          >
            {/* Satellite tile */}
            {imageUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={imageUrl}
                alt="satellite"
                className="absolute inset-0 h-full w-full object-contain"
                onLoad={onImageLoad}
                draggable={false}
                style={{ imageRendering: view.scale >= 2 ? 'pixelated' : 'auto' }}
              />
            )}
            <svg
              ref={svgRef}
              viewBox={`0 0 ${imageDims.w} ${imageDims.h}`}
              preserveAspectRatio="xMidYMid meet"
              className="absolute inset-0 h-full w-full"
              style={{
                cursor: spaceHeld || panning ? 'inherit' : mode === 'draw' ? 'crosshair' : 'default',
                // Scale stroke widths inversely so lines/handles stay readable when zoomed in
                ['--axis-zoom' as string]: String(view.scale),
              }}
              onPointerDown={onSvgPointerDown}
              onPointerMove={onSvgPointerMove}
              onPointerLeave={onSvgPointerLeave}
              onDoubleClick={() => mode === 'draw' && finalizeDrawingPoly()}
            >
              {facets.map(renderFacetPolygon)}

              {/* Rubber-band: dashed line from the last placed vertex to the
                  live cursor, so the contractor sees the edge BEFORE clicking. */}
              {mode === 'draw' && hoverPt && drawingPoly.length > 0 && (
                <line
                  x1={drawingPoly[drawingPoly.length - 1][0] * imageDims.w}
                  y1={drawingPoly[drawingPoly.length - 1][1] * imageDims.h}
                  x2={hoverPt[0] * imageDims.w}
                  y2={hoverPt[1] * imageDims.h}
                  stroke={hoverSnappedVertex ? '#22d3ee' : '#fbbf24'}
                  strokeWidth={2 / view.scale}
                  strokeDasharray={`${5 / view.scale} ${4 / view.scale}`}
                  opacity={0.8}
                />
              )}

              {/* In-progress polygon */}
              {drawingPoly.length > 0 && (
                <g>
                  {drawingPoly.length >= 2 && (
                    <polyline
                      points={drawingPoly.map(([x, y]) => `${x * imageDims.w},${y * imageDims.h}`).join(' ')}
                      fill="none"
                      stroke="#fbbf24"
                      strokeWidth={3 / view.scale}
                      strokeDasharray={`${6 / view.scale} ${4 / view.scale}`}
                    />
                  )}
                  {drawingPoly.map(([x, y], i) => (
                    <circle
                      key={i}
                      cx={x * imageDims.w} cy={y * imageDims.h}
                      r={(i === 0 ? 10 : 7) / view.scale}
                      fill={i === 0 ? '#fbbf24' : 'white'}
                      stroke="#fbbf24"
                      strokeWidth={2 / view.scale}
                    />
                  ))}
                </g>
              )}

              {/* Preview dot at the resolved cursor position — cyan when it
                  will magnetize onto an existing vertex (shared edge). */}
              {mode === 'draw' && hoverPt && (
                <circle
                  cx={hoverPt[0] * imageDims.w} cy={hoverPt[1] * imageDims.h}
                  r={(hoverSnappedVertex ? 8 : 5) / view.scale}
                  fill={hoverSnappedVertex ? '#22d3ee' : 'rgba(255,255,255,0.5)'}
                  stroke={hoverSnappedVertex ? '#0891b2' : '#fbbf24'}
                  strokeWidth={1.5 / view.scale}
                  pointerEvents="none"
                />
              )}
            </svg>
          </div>

          {/* First-use coachmark — dismissible tips, shown once. */}
          {showCoach && (
            <div className="pointer-events-auto absolute left-1/2 top-4 z-30 w-[min(420px,90%)] -translate-x-1/2 rounded-lg border border-blue-400/40 bg-slate-900/95 p-4 shadow-2xl backdrop-blur">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-sm font-semibold text-white">How to trace a roof facet</div>
                <button onClick={dismissCoach} className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white">✕</button>
              </div>
              <ol className="space-y-2 text-xs text-slate-200">
                <li className="flex gap-2">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[11px] font-bold text-white">1</span>
                  <span>Click each <strong>corner</strong> of one roof plane. Dots snap to the edges for you.</span>
                </li>
                <li className="flex gap-2">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[11px] font-bold text-white">2</span>
                  <span>Click the <strong>first dot again</strong> (or press <kbd className="rounded bg-slate-800 px-1">Enter</kbd>) to finish that facet.</span>
                </li>
                <li className="flex gap-2">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[11px] font-bold text-white">3</span>
                  <span>Repeat for each plane, then <strong>label the edges</strong> (ridge, eave, valley…).</span>
                </li>
              </ol>
              <div className="mt-2 rounded bg-slate-800/60 px-2 py-1.5 text-[10px] text-slate-400">
                <kbd className="rounded bg-slate-700 px-1 text-slate-200">Shift</kbd> square corners ·
                drag = pan · scroll = zoom · <kbd className="rounded bg-slate-700 px-1 text-slate-200">⌘Z</kbd> undo
              </div>
              <button onClick={dismissCoach} className="mt-3 w-full rounded bg-blue-600 py-1.5 text-xs font-semibold text-white hover:bg-blue-500">Got it — let me draw</button>
              <div className="mt-1 text-center text-[10px] text-slate-500">…or use <strong>AI assistance</strong> below to auto-detect facets.</div>
            </div>
          )}

          {/* Floating pan keypad — top-right. INSTANT CSS pan (no refetch, no
              facet misalignment). Drag the canvas, scroll to zoom, or use
              arrow keys / WASD (held = continuous) for the same effect. */}
          <div className="pointer-events-auto absolute right-2 top-2 grid grid-cols-3 gap-0.5 rounded-md border border-white/20 bg-slate-900/85 p-1 shadow-lg backdrop-blur">
            <div></div>
            <button
              onClick={() => panView(0, 70)}
              title="Pan up (↑ / W)"
              className="flex h-8 w-8 items-center justify-center rounded bg-slate-800 text-base text-white hover:bg-blue-600"
            >↑</button>
            <div></div>
            <button
              onClick={() => panView(70, 0)}
              title="Pan left (← / A)"
              className="flex h-8 w-8 items-center justify-center rounded bg-slate-800 text-base text-white hover:bg-blue-600"
            >←</button>
            <div className="flex h-8 w-8 items-center justify-center text-[9px] text-slate-500">pan</div>
            <button
              onClick={() => panView(-70, 0)}
              title="Pan right (→ / D)"
              className="flex h-8 w-8 items-center justify-center rounded bg-slate-800 text-base text-white hover:bg-blue-600"
            >→</button>
            <div></div>
            <button
              onClick={() => panView(0, -70)}
              title="Pan down (↓ / S)"
              className="flex h-8 w-8 items-center justify-center rounded bg-slate-800 text-base text-white hover:bg-blue-600"
            >↓</button>
            <div></div>
          </div>

          {/* Floating zoom controls */}
          <div className="pointer-events-none absolute bottom-2 right-2 flex flex-col items-end gap-1">
            <div className="pointer-events-auto flex items-center gap-1 rounded-md border border-white/10 bg-slate-900/85 p-1 text-xs text-slate-200 backdrop-blur">
              <button
                onClick={zoomOut}
                className="rounded px-2 py-1 hover:bg-slate-800"
                title="Zoom out (-)"
              >−</button>
              <span className="min-w-[3.2rem] px-1 text-center font-mono">
                {(view.scale * 100).toFixed(0)}%
              </span>
              <button
                onClick={zoomIn}
                className="rounded px-2 py-1 hover:bg-slate-800"
                title="Zoom in (+)"
              >+</button>
              <button
                onClick={resetView}
                className="ml-1 rounded bg-slate-800 px-2 py-1 hover:bg-slate-700"
                title="Reset view (0)"
              >Fit</button>
            </div>
            <div className="pointer-events-none rounded bg-slate-900/70 px-2 py-1 text-[10px] text-slate-400 backdrop-blur">
              Wheel = zoom · Space + drag (or middle-mouse) = pan
            </div>
          </div>
        </div>

        {/* Side panel */}
        <aside className="w-72 shrink-0 overflow-y-auto rounded-lg border border-white/10 bg-slate-900/60 p-3 text-sm">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
            Facets ({facets.length})
          </h3>

          {facets.length === 0 && (
            <p className="text-xs text-slate-500">
              No facets yet. Switch to <strong>+ Draw facet</strong> and click points around a roof plane to trace it. Press <kbd className="rounded bg-slate-800 px-1">Enter</kbd> to close.
            </p>
          )}

          <ul className="space-y-2">
            {facets.map((f, i) => {
              const facetEdges = edges.filter(e => e.facetLabel === f.label)
              const labeled = facetEdges.filter(e => e.edgeType !== 'unlabeled').length
              const isActive = activeFacetIdx === i
              return (
                <li
                  key={f.label}
                  className={`rounded-md border p-2 transition ${
                    isActive ? 'border-blue-400/60 bg-blue-500/10' : 'border-white/10 bg-slate-800/40'
                  }`}
                  onClick={() => setActiveFacetIdx(i)}
                >
                  <div className="mb-1 flex items-center justify-between">
                    <strong className="text-slate-100">Facet {f.label}</strong>
                    <button
                      onClick={(ev) => { ev.stopPropagation(); deleteFacet(i) }}
                      className="text-xs text-rose-400 hover:text-rose-300"
                    >Remove</button>
                  </div>
                  <div className="mb-1 flex items-center gap-2 text-xs text-slate-300">
                    <label className="text-slate-400">Pitch:</label>
                    <select
                      value={f.pitch}
                      onChange={(ev) => setFacetPitch(i, ev.target.value)}
                      onClick={(ev) => ev.stopPropagation()}
                      className="rounded bg-slate-800 px-2 py-1 text-xs text-slate-100"
                    >
                      {PITCH_OPTIONS.map(p => <option key={p} value={p}>{p}</option>)}
                    </select>
                  </div>
                  <div className="text-xs text-slate-500">
                    {f.polygon.length} vertices · {labeled}/{facetEdges.length} edges labeled
                  </div>

                  {/* Inline edge label list when this facet is active.
                      Hover a row to highlight that exact edge on the canvas. */}
                  {isActive && facetEdges.length > 0 && (
                    <div className="mt-2 border-t border-white/10 pt-2">
                      <div className="mb-1 text-xs text-slate-400">Edges — hover to find it on the roof:</div>
                      <ul className="space-y-1">
                        {facetEdges.map((e, eIdx) => {
                          const color = EDGE_COLORS[e.edgeType]
                          const rowSelected = selectedEdge?.facetIdx === i && selectedEdge.edgeIdx === e.vertexIndexStart
                          const unlabeled = e.edgeType === 'unlabeled'
                          return (
                            <li
                              key={`${e.vertexIndexStart}-${e.vertexIndexEnd}`}
                              onMouseEnter={() => setSelectedEdge({ facetIdx: i, edgeIdx: e.vertexIndexStart })}
                              className={`flex items-center justify-between gap-2 rounded px-2 py-1 text-xs transition ${
                                rowSelected ? 'bg-slate-700 ring-1 ring-white/40' : 'bg-slate-800/60'
                              }`}
                            >
                              <span className="flex items-center gap-2">
                                <span className="inline-block h-3 w-3 rounded-sm" style={{ background: color }} />
                                <span className="font-medium text-slate-200">Edge {eIdx + 1}</span>
                                {unlabeled && <span className="text-[10px] text-amber-400">needs label</span>}
                                {e.sharedWithFacetLabel && (
                                  <span className="rounded bg-slate-700 px-1 text-[10px] text-slate-300">shared ↔ {e.sharedWithFacetLabel}</span>
                                )}
                              </span>
                              <select
                                value={e.edgeType}
                                onChange={(ev) => setEdgeLabel(i, e.vertexIndexStart, ev.target.value as EdgeType)}
                                onClick={(ev) => ev.stopPropagation()}
                                className="rounded bg-slate-700 px-1 py-0.5 text-xs text-slate-100"
                              >
                                <option value="unlabeled">unlabeled</option>
                                <option value="eave">eave</option>
                                <option value="rake">rake</option>
                                <option value="ridge">ridge</option>
                                <option value="hip">hip</option>
                                <option value="valley">valley</option>
                                <option value="wall_intersection">wall</option>
                              </select>
                            </li>
                          )
                        })}
                      </ul>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>

          {/* Edge type legend */}
          <h3 className="mt-4 mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Edge legend</h3>
          <ul className="space-y-1 text-xs text-slate-300">
            {(Object.keys(EDGE_COLORS) as EdgeType[]).filter(k => k !== 'unlabeled' && k !== 'gable_end').map(t => (
              <li key={t} className="flex items-center gap-2">
                <span className="inline-block h-2 w-4 rounded" style={{ background: EDGE_COLORS[t] }} />
                {t.replace('_', ' ')}
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </div>
  )
}

export default RoofFacetEditor
