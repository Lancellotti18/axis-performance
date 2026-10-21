'use client'

/**
 * Axis Roofing Performance — Multi-facet roof editor.
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
import MagnifierLoupe from './MagnifierLoupe'
import { groupEdgesByLine, labelLine } from './edgeGeometry'

export type EdgeType =
  | 'eave' | 'rake' | 'ridge' | 'hip' | 'valley'
  | 'gable_end' | 'wall_intersection' | 'unlabeled'

export type Pt = [number, number]

export interface Facet {
  label: string                  // 'A', 'B', etc.
  polygon: Pt[]                   // closed ring, do NOT repeat first vertex
  pitch: string                   // 'X/12'
  pitchSource?: string            // provenance: solar_measured | lidar_measured | ... | manual | default
  confidence: number              // 0..1
  userConfirmed: boolean
  aiSuggested?: boolean           // true if it originated from AI (training provenance)
  azimuthDeg?: number             // compass bearing the slope faces, when MEASURED (auto-measure)
}

export interface LabeledEdge {
  facetLabel: string
  vertexIndexStart: number
  vertexIndexEnd: number
  edgeType: EdgeType
  sharedWithFacetLabel?: string
  userConfirmed: boolean
}

/** A section the contractor marked "Not roof" (a tree or its shadow). Shown
 *  greyed out, counted nowhere, and can be brought back. */
export interface ExcludedFacet {
  facet: Facet
  edges: LabeledEdge[]
  reason: string
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
  // Driven by the step's status card: bump `n` to switch to drawing, walk the
  // contractor through the lines that still need a type, or open the drawing help.
  command?: { kind: 'draw' | 'guide' | 'help'; n: number }
  // The house confirmed in the picker, as fractions of the image. Without it
  // the draw map showed two look-alike houses and nothing saying which one is
  // the job: 1114 Willow Pond was traced on 1112 next door (2026-10-19).
  houseGuide?: { point?: { x: number; y: number } | null; outline?: { x: number; y: number }[] | null }
  excludedFacets?: ExcludedFacet[]
  onRestoreFacet?: (label: string) => void
  /** "Not roof" straight from the map: click a section's letter, then the
   *  button under it (an RV parked against the house, a tree, a shadow). */
  onExcludeFacet?: (label: string) => void
}

// What each line type IS, in the words a homeowner would understand — shown
// while walking the contractor through the lines nothing could type.
const LINE_HINTS: Record<Exclude<EdgeType, 'unlabeled' | 'gable_end'>, string> = {
  ridge: 'Level line along the top, where two slopes meet',
  hip: 'Sloped line where two slopes meet and the roof falls away on both sides',
  valley: 'Sloped line where two slopes meet in a V — water runs along it',
  eave: 'Bottom edge of a slope, where the gutter is',
  rake: 'Sloped outer edge at a gable end',
  wall_intersection: 'Where the roof meets a wall or a chimney',
}

const GUIDE_MAX_SCALE = 8

const PITCH_OPTIONS = ['2/12', '3/12', '4/12', '5/12', '6/12', '7/12', '8/12', '9/12', '10/12', '12/12']

// Phase 1: label + color for a facet's pitch provenance, so a MEASURED pitch reads
// green (trusted) and the bare default reads amber (needs a look). Mirrors the
// labels FacetSuggestions uses and the report's _pitch_source_label.
function pitchSourceMeta(src?: string): { label: string; color: string } {
  switch (src) {
    case 'solar_measured': return { label: '📐 measured (Solar)', color: 'text-emerald-400' }
    case 'solar_3d': return { label: '📐 measured (Google 3D)', color: 'text-emerald-400' }
    case 'solar_3d_edited': return { label: '📐 Google 3D pitch · outline edited', color: 'text-emerald-400' }
    case 'solar_direction': return { label: '📐 measured (Solar dir.)', color: 'text-emerald-400' }
    case 'lidar_measured': return { label: '📐 measured (LiDAR)', color: 'text-emerald-400' }
    case 'ground_photo': return { label: '📷 ground photo', color: 'text-sky-400' }
    case 'ai_satellite': return { label: '🛰 AI estimate', color: 'text-amber-400' }
    case 'manual': return { label: '✎ you set this', color: 'text-[#2d2d2d]' }
    default: return { label: '⚠ default — verify', color: 'text-amber-400' }
  }
}

const EDGE_COLORS: Record<EdgeType, string> = {
  eave: '#fb923c',
  rake: '#60a5fa',
  ridge: '#a78bfa',
  hip: '#34d399',
  valley: '#f87171',
  gable_end: '#fde68a',
  wall_intersection: '#9ca3af',
  // Loud on purpose: a line with no type is not counted anywhere, and it was
  // drawn faint white — on a real roof nobody could find the ones left.
  unlabeled: '#ff1fa8',
}

// The legend's "needs confirm" / "confirmed" samples show a line STATE, not a
// type. Drawn in ridge purple they read as a third purple line; slate is a
// colour no line type uses.
const STATE_SWATCH = '#475569'

// Where a facet's letter goes. The average of the corners lands OUTSIDE an
// L- or U-shaped facet (a back slope wrapped round a dormer put its "G" on the
// dormer), so this picks the inside point furthest from every side.
function labelPoint(poly: [number, number][], w: number, h: number): [number, number] {
  const pts = poly.map(([x, y]) => [x * w, y * h] as [number, number])
  const inside = (x: number, y: number) => {
    let c = false
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j]
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c
    }
    return c
  }
  const edgeDist = (x: number, y: number) => {
    let best = Infinity
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length]
      const dx = bx - ax, dy = by - ay
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)))
      best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)))
    }
    return best
  }
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1])
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys)
  let best: [number, number] | null = null, bestD = -1
  const N = 24
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
    const x = x0 + ((x1 - x0) * i) / N, y = y0 + ((y1 - y0) * j) / N
    if (!inside(x, y)) continue
    const d = edgeDist(x, y)
    if (d > bestD) { bestD = d; best = [x, y] }
  }
  if (!best) {
    return [poly.reduce((s, p) => s + p[0], 0) / poly.length, poly.reduce((s, p) => s + p[1], 0) / poly.length]
  }
  return [best[0] / w, best[1] / h]
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
  // A line pointing past its facet's corners (left over from two facets that
  // shared a letter) has no geometry; reading it crashed the page.
  if (!p1 || !p2) return undefined
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
  initialFacets = [], initialEdges = [], onChange, syncRev, command, houseGuide,
  excludedFacets = [], onRestoreFacet, onExcludeFacet,
}: Props) {
  const [facets, setFacets] = useState<Facet[]>(initialFacets)
  // Closed on arrival — see the aside below for why.
  const [facetPanelOpen, setFacetPanelOpen] = useState(false)
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
  // `group`: every facet corner sitting on the grabbed one. Neighbouring facets
  // each hold their own copy of a shared corner; moving only the top copy left
  // the other facets' lines behind, so lines looked impossible to move (Ryan,
  // 2026-10-21). Alt/Option detaches just the one corner.
  const [dragVertex, setDragVertex] = useState<{ facetIdx: number; vertexIdx: number; group: [number, number][] } | null>(null)
  const [selectedEdge, setSelectedEdge] = useState<{ facetIdx: number; edgeIdx: number } | null>(null)
  const [imageDims, setImageDims] = useState({ w: imageWidthPx, h: imageHeightPx })
  // Live cursor position (image fractions) while drawing — drives the
  // rubber-band preview line + the "where will this click land" preview dot.
  const [hoverPt, setHoverPt] = useState<Pt | null>(null)
  const [hoverSnappedVertex, setHoverSnappedVertex] = useState(false)

  // Drawing help — opened from "Need help drawing?" only. It used to open by
  // itself on first visit and sat on top of the map with everything else.
  const [showCoach, setShowCoach] = useState(false)
  // The floating line-colour legend, collapsible.
  const [legendOpen, setLegendOpen] = useState(true)
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
  // The same constraint as a toggle in the toolbar, for anyone who doesn't
  // know to hold Shift.
  const [orthoEnabled, setOrthoEnabled] = useState(false)
  // Alt/Option held = place the vertex EXACTLY where the cursor is, bypassing
  // both the magnetic vertex snap and the gradient edge snap. The snaps are a
  // help most of the time but fight you when you're pinning a precise corner —
  // holding Alt gives surgical placement without toggling the snap off.
  const [altHeld, setAltHeld] = useState(false)

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
    const onDown = (e: KeyboardEvent) => { if (e.key === 'Shift') setShiftHeld(true); if (e.altKey) setAltHeld(true) }
    const onUp = (e: KeyboardEvent) => { if (e.key === 'Shift') setShiftHeld(false); if (!e.altKey) setAltHeld(false) }
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
    const iw = imageDims.w, ih = imageDims.h
    if (!rect.width || !rect.height || !iw || !ih) return [0, 0]
    // The SVG uses preserveAspectRatio="xMidYMid meet", so its viewBox is
    // letterboxed inside the element box. Undo that letterbox — otherwise the
    // plotted point drifts from the cursor whenever the container's aspect
    // ratio doesn't match the tile's (the "point doesn't line up" bug).
    const s = Math.min(rect.width / iw, rect.height / ih)
    const contentW = iw * s, contentH = ih * s
    const offX = (rect.width - contentW) / 2
    const offY = (rect.height - contentH) / 2
    const x = (ev.clientX - rect.left - offX) / contentW
    const y = (ev.clientY - rect.top - offY) / contentH
    return [clampFrac(x), clampFrac(y)]
  }, [imageDims.w, imageDims.h])

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

  const facetsRef = useRef<Facet[]>(initialFacets)
  useEffect(() => { facetsRef.current = facets }, [facets])
  // Frame the roof. The tile shows the whole neighbourhood, so a traced or
  // auto-measured roof opened as a small shape in the middle of it — the map
  // was the dominant visual, but the ROOF on it was not.
  const fitToRoof = useCallback(() => {
    const el = containerRef.current
    const pts = facetsRef.current.flatMap(f => f.polygon)
    if (!el || pts.length === 0) { setView({ scale: 1, x: 0, y: 0 }); return }
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) return
    const xs = pts.map(p => p[0]); const ys = pts.map(p => p[1])
    const k = Math.min(r.width / imageDims.w, r.height / imageDims.h)
    const ox = (r.width - imageDims.w * k) / 2; const oy = (r.height - imageDims.h * k) / 2
    const x0 = ox + Math.min(...xs) * imageDims.w * k, x1 = ox + Math.max(...xs) * imageDims.w * k
    const y0 = oy + Math.min(...ys) * imageDims.h * k, y1 = oy + Math.max(...ys) * imageDims.h * k
    const S = Math.max(1, Math.min(GUIDE_MAX_SCALE * 0.75,
      0.7 * Math.min(r.width / Math.max(x1 - x0, 1), r.height / Math.max(y1 - y0, 1))))
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2
    setView({ scale: S, x: r.width / 2 - cx * S, y: r.height / 2 - cy * S })
  }, [imageDims.w, imageDims.h])
  // Frame it when a roof ARRIVES — opened with one, or a new outline pushed in
  // by the parent (an auto-measure result) — never because of the
  // contractor's own drawing or labeling, which would yank the view mid-task.
  // Keyed on the outline, so a parent sync that only changed labels is ignored.
  //
  // A parent push arrives in two renders: `syncRev` changes first, and the
  // pushed facets land in this component's state on the next. So a sync only
  // marks a fit as pending; the facets that follow decide it.
  const openedWithRoof = useRef(initialFacets.length > 0)
  const fit = useRef<{ sync: number | undefined; outline: string | null; pending: boolean }>(
    { sync: syncRev, outline: null, pending: false })
  useEffect(() => {
    const st = fit.current
    const outline = facets.length
      ? facets.map(f => `${f.label}:${f.polygon.length}:${f.polygon[0]?.join(',')}`).join('|')
      : ''
    if (syncRev !== st.sync) {
      st.sync = syncRev
      st.pending = true
      if (outline === (st.outline ?? '')) return        // wait for the pushed facets
    }
    let doFit = false
    if (st.outline === null) {
      doFit = openedWithRoof.current && facets.length > 0  // opened a saved/measured roof
    } else if (st.pending) {
      doFit = outline !== st.outline && facets.length > 0  // a NEW outline was pushed in
    }
    st.pending = false
    st.outline = outline
    if (doFit && drawingPoly.length === 0) requestAnimationFrame(() => requestAnimationFrame(fitToRoof))
    // drawingPoly is read, not tracked: a fit must never be triggered by drawing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facets, syncRev, fitToRoof])

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

  // ---- Pinch-to-zoom (touch) ----
  // Two fingers on the canvas zoom about their midpoint — the standard tablet
  // gesture. Native capture-phase listeners so pinching never places vertices.
  const touchPtsRef = useRef<Map<number, { x: number; y: number }>>(new Map())
  const pinchRef = useRef<{ startDist: number; startScale: number } | null>(null)
  const viewScaleRef = useRef(1)
  useEffect(() => { viewScaleRef.current = view.scale }, [view.scale])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const down = (ev: PointerEvent) => {
      if (ev.pointerType !== 'touch') return
      touchPtsRef.current.set(ev.pointerId, { x: ev.clientX, y: ev.clientY })
      if (touchPtsRef.current.size === 2) {
        const [a, b] = [...touchPtsRef.current.values()]
        pinchRef.current = {
          startDist: Math.max(12, Math.hypot(a.x - b.x, a.y - b.y)),
          startScale: viewScaleRef.current,
        }
      }
    }
    const move = (ev: PointerEvent) => {
      if (ev.pointerType !== 'touch' || !touchPtsRef.current.has(ev.pointerId)) return
      touchPtsRef.current.set(ev.pointerId, { x: ev.clientX, y: ev.clientY })
      if (pinchRef.current && touchPtsRef.current.size === 2) {
        ev.preventDefault()
        const [a, b] = [...touchPtsRef.current.values()]
        const dist = Math.max(12, Math.hypot(a.x - b.x, a.y - b.y))
        const rect = el.getBoundingClientRect()
        setViewClamped(
          pinchRef.current.startScale * (dist / pinchRef.current.startDist),
          (a.x + b.x) / 2 - rect.left,
          (a.y + b.y) / 2 - rect.top,
        )
      }
    }
    const up = (ev: PointerEvent) => {
      touchPtsRef.current.delete(ev.pointerId)
      if (touchPtsRef.current.size < 2) pinchRef.current = null
    }
    el.addEventListener('pointerdown', down, { capture: true })
    el.addEventListener('pointermove', move, { capture: true, passive: false })
    el.addEventListener('pointerup', up, { capture: true })
    el.addEventListener('pointercancel', up, { capture: true })
    return () => {
      el.removeEventListener('pointerdown', down, { capture: true } as EventListenerOptions)
      el.removeEventListener('pointermove', move, { capture: true, passive: false } as EventListenerOptions)
      el.removeEventListener('pointerup', up, { capture: true } as EventListenerOptions)
      el.removeEventListener('pointercancel', up, { capture: true } as EventListenerOptions)
    }
  }, [setViewClamped])

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

    // 1. Orthogonality (toolbar toggle, or Shift held)
    if ((orthoEnabled || shiftHeld) && drawingPoly.length > 0) {
      pt = constrainTo45(drawingPoly[drawingPoly.length - 1], pt, imageDims.w, imageDims.h)
    }

    // Alt = exact placement: skip every magnetic assist so the vertex lands
    // precisely under the cursor (still honors the Shift ortho constraint above).
    if (altHeld) return { pt, onVertex: false }

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
      // Tighter than before (was 14px) so it only grabs when the cursor is
      // genuinely on a roof edge — a wide radius is what made precise corners
      // feel like they "jumped."
      const edgeRadius = Math.max(4, Math.round(9 / Math.max(1, view.scale * 0.6)))
      const snapped = snapToNearestEdge(pt[0] * imageDims.w, pt[1] * imageDims.h, edgeRadius)
      if (snapped.snapped) pt = [snapped.x / imageDims.w, snapped.y / imageDims.h]
    }
    return { pt, onVertex: false }
  }, [shiftHeld, orthoEnabled, altHeld, drawingPoly, facets, snapEnabled, snapReady, imageDims, view.scale])

  const onSvgPointerDown = useCallback((ev: React.PointerEvent<SVGSVGElement>) => {
    if (mode !== 'draw') return
    if (ev.button !== 0) return
    // Two fingers = pinch zoom, never a vertex.
    if (ev.pointerType === 'touch' && touchPtsRef.current.size >= 2) return
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
    // The first letter nobody has. Counting facets reused a letter once one had
    // been removed or marked "Not roof" (9 facets -> "J" while a J existed), and
    // the server, holding one row per letter, refused the save and kept nothing
    // (711 Spring Branch Rd, 2026-10-21).
    const taken = new Set([...facets.map(f => f.label), ...excludedFacets.map(x => x.facet.label)])
    let label = FACET_LABELS.find(l => !taken.has(l)) || ''
    for (let k = facets.length + 1; !label; k++) if (!taken.has(`F${k}`)) label = `F${k}`
    const newFacet: Facet = {
      label,
      polygon: drawingPoly,
      pitch: '6/12',
      pitchSource: 'default',   // hand-drawn facet starts on the unverified default
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
  }, [drawingPoly, facets, excludedFacets])

  // ---- Vertex dragging ----
  const onVertexPointerDown = useCallback((
    ev: React.PointerEvent, facetIdx: number, vertexIdx: number,
  ) => {
    if (mode !== 'select') return
    ev.stopPropagation()
    ev.preventDefault()
    const grabbed = facets[facetIdx]?.polygon[vertexIdx]
    const group: [number, number][] = [[facetIdx, vertexIdx]]
    if (grabbed && !ev.altKey) {
      const tolX = 1 / imageDims.w, tolY = 1 / imageDims.h      // within one image pixel
      facets.forEach((f, fi) => f.polygon.forEach((p, vi) => {
        if (fi === facetIdx && vi === vertexIdx) return
        if (Math.abs(p[0] - grabbed[0]) <= tolX && Math.abs(p[1] - grabbed[1]) <= tolY) group.push([fi, vi])
      }))
    }
    setDragVertex({ facetIdx, vertexIdx, group })
  }, [mode, facets, imageDims.w, imageDims.h])

  useEffect(() => {
    if (!dragVertex) return
    const onMove = (ev: PointerEvent) => {
      const pt = eventToFrac(ev as unknown as React.PointerEvent)
      const moving = new Map<number, Set<number>>()
      for (const [fi, vi] of dragVertex.group) {
        if (!moving.has(fi)) moving.set(fi, new Set())
        moving.get(fi)!.add(vi)
      }
      setFacets(prev => prev.map((f, i) => {
        const vs = moving.get(i)
        if (!vs) return f
        const poly = f.polygon.map((p, j) => (vs.has(j) ? pt : p))
        // Reshaped by hand, an auto-measured facet's OUTLINE is now the
        // contractor's: the AI labeller may help with its lines again and the
        // report stops calling it auto-measured. Its pitch is still measured.
        const pitchSource = f.pitchSource === 'solar_3d' ? 'solar_3d_edited' : f.pitchSource
        return { ...f, polygon: poly, pitchSource }
      }))
    }
    const onUp = () => {
      // Recompute edge plan lengths is server-side; client just persists vertex moves.
      // Re-evaluate shared_with for this facet's edges since vertices moved.
      const moved = new Set(dragVertex.group.map(([fi]) => facets[fi]?.label).filter(Boolean))
      setEdges(prev => prev.map(e => {
        if (!moved.has(e.facetLabel)) return e
        const facet = facets.find(f => f.label === e.facetLabel)
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

  // ---- Lines with no type: find them, walk through them ----
  // Counted as distinct ROOF LINES (a shared line is one line, not one per
  // facet), the same way the measurements panel counts — three different
  // numbers on one screen (8, 10, "all labeled") was the confusion.
  // Same rule as edgeReviewCounts (the status card's count): a roof line needs
  // a type when the copy it is counted under has none. Counting raw unlabeled
  // copies instead made the walkthrough say "6 left" beside a card saying 4
  // whenever one side of a shared line was typed and the other was not.
  const blankLines = useMemo(
    () => groupEdgesByLine(facets, edges)
      .filter(g => g.representative.edgeType === 'unlabeled')
      .map(g => g.representative),
    [facets, edges],
  )
  const [guiding, setGuiding] = useState(false)

  // Centre and zoom the canvas on one line, so a 4 ft line is findable.
  const goToLine = useCallback((e: { facetLabel: string; vertexIndexStart: number }) => {
    const fi = facets.findIndex(f => f.label === e.facetLabel)
    const f = facets[fi]
    const el = containerRef.current
    if (!f || !el) return
    const a = f.polygon[e.vertexIndexStart]; const b = f.polygon[(e.vertexIndexStart + 1) % f.polygon.length]
    if (!a || !b) return
    setMode('label')
    setActiveFacetIdx(fi)
    setSelectedEdge({ facetIdx: fi, edgeIdx: e.vertexIndexStart })
    setGuiding(true)
    // Measure AFTER the layout settles: entering label mode hides the nudge
    // banner above the canvas, which makes the canvas taller. Centring on the
    // old size left the line ~300 px below the middle at high zoom.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const r = el.getBoundingClientRect()
      // The SVG letterboxes the image inside the stage (preserveAspectRatio meet).
      const k = Math.min(r.width / imageDims.w, r.height / imageDims.h)
      const ox = (r.width - imageDims.w * k) / 2; const oy = (r.height - imageDims.h * k) / 2
      const px = ox + ((a[0] + b[0]) / 2) * imageDims.w * k
      const py = oy + ((a[1] + b[1]) / 2) * imageDims.h * k
      const lenPx = Math.hypot((b[0] - a[0]) * imageDims.w * k, (b[1] - a[1]) * imageDims.h * k)
      // The line fills about a third of the canvas, but never past 8x: beyond
      // that a satellite photo is only pixels and the roof around it is lost.
      const S = Math.max(2, Math.min(GUIDE_MAX_SCALE, (Math.min(r.width, r.height) / 3) / Math.max(lenPx, 1)))
      setView({ scale: S, x: r.width / 2 - px * S, y: r.height / 2 - py * S })
    }))
  }, [facets, imageDims.w, imageDims.h])

  const selectedRecord = useMemo(() => {
    if (!selectedEdge) return null
    const f = facets[selectedEdge.facetIdx]
    return f ? edges.find(e => e.facetLabel === f.label && e.vertexIndexStart === selectedEdge.edgeIdx) ?? null : null
  }, [selectedEdge, facets, edges])

  const nextBlank = useCallback((after?: { facetLabel: string; vertexIndexStart: number } | null,
                                 pool = blankLines) => {
    if (pool.length === 0) return null
    const i = after ? pool.findIndex(e => e.facetLabel === after.facetLabel && e.vertexIndexStart === after.vertexIndexStart) : -1
    return pool[(i + 1) % pool.length]
  }, [blankLines])

  const startGuide = useCallback(() => {
    const first = nextBlank(null)
    if (first) goToLine(first)
  }, [nextBlank, goToLine])

  // Type the selected line (both facets' copies of it), then move on to the next blank one.
  const typeSelectedLine = useCallback((t: EdgeType) => {
    if (!selectedRecord) return
    const target = { facetLabel: selectedRecord.facetLabel, vertexIndexStart: selectedRecord.vertexIndexStart }
    const updated = labelLine(facets, edges, target, t)
    setEdges(updated)
    const remaining = groupEdgesByLine(facets, updated)
      .filter(g => g.representative.edgeType === 'unlabeled')
      .map(g => g.representative)
    const nxt = remaining.length ? nextBlank(target, [...remaining]) ?? remaining[0] : null
    if (nxt) goToLine(nxt)
    else { setGuiding(false); setSelectedEdge(null); setView({ scale: 1, x: 0, y: 0 }) }
  }, [selectedRecord, facets, edges, nextBlank, goToLine])

  // Commands from the status card above the map.
  const lastCommand = useRef(command?.n ?? 0)
  useEffect(() => {
    if (!command || command.n === lastCommand.current) return
    lastCommand.current = command.n
    if (command.kind === 'draw') { setGuiding(false); setSelectedEdge(null); setMode('draw') }
    else if (command.kind === 'guide') startGuide()
    else if (command.kind === 'help') setShowCoach(true)
  }, [command, startGuide])

  // Which stored edges belong to a CONFIRMED roof line (either facet's copy),
  // so the map can show labeled-but-unconfirmed lines differently.
  const confirmedKeys = useMemo(() => {
    const k = new Set<string>()
    for (const g of groupEdgesByLine(facets, edges)) {
      if (g.confirmed) g.members.forEach(m => k.add(`${m.facetLabel}:${m.vertexIndexStart}`))
    }
    return k
  }, [facets, edges])

  // ---- Facet pitch / delete ----
  const setFacetPitch = useCallback((facetIdx: number, pitch: string) => {
    // A contractor-typed pitch is provenance 'manual' — it overrides any prior
    // measured/default source so the report shows who set the value.
    setFacets(prev => prev.map((f, i) => (i === facetIdx ? { ...f, pitch, pitchSource: 'manual' } : f)))
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
          fill={isActive ? 'rgba(96,165,250,0.18)' : 'transparent'}
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
          const blank = !edgeRec || edgeRec.edgeType === 'unlabeled'
          // Three states the contractor can read at a glance (see the legend):
          // ? unlabeled = loud pink dashed · labeled, needs confirm = bright with
          // a soft glow · confirmed = solid and quieter, done.
          const confirmed = !blank && confirmedKeys.has(`${f.label}:${i}`)
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
              {/* A line with no type pulses, so it can be FOUND on the roof. */}
              {blank && (
                <line
                  x1={p1[0] * imageDims.w} y1={p1[1] * imageDims.h}
                  x2={p2[0] * imageDims.w} y2={p2[1] * imageDims.h}
                  stroke={EDGE_COLORS.unlabeled} strokeWidth={14 / view.scale} strokeLinecap="round"
                  pointerEvents="none"
                >
                  <animate attributeName="opacity" values="0.1;0.45;0.1" dur="1.4s" repeatCount="indefinite" />
                </line>
              )}
              {!blank && !confirmed && (
                <line
                  x1={p1[0] * imageDims.w} y1={p1[1] * imageDims.h}
                  x2={p2[0] * imageDims.w} y2={p2[1] * imageDims.h}
                  stroke={color} strokeOpacity={0.35} strokeWidth={12 / view.scale}
                  strokeLinecap="round" pointerEvents="none"
                />
              )}
              <line
                x1={p1[0] * imageDims.w} y1={p1[1] * imageDims.h}
                x2={p2[0] * imageDims.w} y2={p2[1] * imageDims.h}
                stroke={color}
                strokeOpacity={confirmed && !isSel ? 0.8 : 1}
                strokeWidth={(isSel ? 7 : blank ? 5 : confirmed ? 3 : 4.5) / view.scale}
                strokeDasharray={blank ? `${10 / view.scale} ${6 / view.scale}` : undefined}
                strokeLinecap="round"
                style={{ cursor: mode === 'label' || mode === 'select' ? 'pointer' : 'default' }}
                onClick={(ev) => {
                  if (mode === 'label') {
                    ev.stopPropagation()
                    // Pick the type from named buttons; cycling through seven
                    // colours by repeated clicks was guesswork.
                    setSelectedEdge({ facetIdx: idx, edgeIdx: i })
                    setGuiding(true)
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
          const [cx, cy] = labelPoint(f.polygon, imageDims.w, imageDims.h)
          return (
            <g
              transform={`translate(${cx * imageDims.w}, ${cy * imageDims.h}) scale(${1 / view.scale})`}
              style={{ cursor: 'pointer' }}
              // Not mid-shape: a click on a letter selects that section instead
              // of dropping a drawing point on it.
              onPointerDown={(ev) => { if (drawingPoly.length === 0) ev.stopPropagation() }}
              onClick={(ev) => { ev.stopPropagation(); setActiveFacetIdx(idx) }}
            >
              <circle r={18} fill={isActive ? '#1e40af' : '#1f2937'} fillOpacity={0.85} />
              <text
                textAnchor="middle" dominantBaseline="central"
                fill="white" fontSize={18} fontWeight={700}
              >{f.label}</text>
              {isActive && onExcludeFacet && drawingPoly.length === 0 && (
                <g transform="translate(0, 40)" style={{ cursor: 'pointer' }}
                  onPointerDown={(ev) => ev.stopPropagation()}
                  onClick={(ev) => { ev.stopPropagation(); setActiveFacetIdx(null); onExcludeFacet(f.label) }}>
                  <title>Not part of the roof (a vehicle, tree or shadow): take this section out of the measurement. You can restore it.</title>
                  <rect x={-86} y={-17} width={172} height={34} rx={17} fill="#374151" fillOpacity={0.95} stroke="white" strokeWidth={1.5} />
                  <text textAnchor="middle" dominantBaseline="central" fill="white" fontSize={15} fontWeight={700}>
                    ✕ Not roof · remove {f.label}
                  </text>
                </g>
              )}
            </g>
          )
        })()}
      </g>
    )
  }

  const unlabeledCount = blankLines.length

  const toolBtn = (on: boolean) =>
    `rounded-md px-3 py-1.5 text-xs font-medium transition ${on ? 'bg-blue-600 text-white' : 'bg-white text-[#2d2d2d] hover:bg-[#eeeeed]'}`
  const helperBtn = 'rounded-md px-2 py-1.5 text-xs font-medium text-[#1a1a1a] hover:bg-[#eeeeed] disabled:opacity-30'

  return (
    <div className="flex h-full w-full flex-col gap-2">
      {/* Tools: drawing on the left, helpers on the right. Status, next steps
          and help live in the status card above the map, not in here. */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[#dededc] bg-[#f8f8f7] p-1.5 text-sm text-[#1a1a1a]">
        <div className="flex items-center gap-1 rounded-md bg-[#eeeeed] p-0.5" role="group" aria-label="Drawing tools">
          {(['draw', 'select', 'label'] as Mode[]).map(m => (
            <button
              key={m}
              onClick={() => { setMode(m); setSelectedEdge(null); if (m !== 'label') setGuiding(false) }}
              className={toolBtn(mode === m)}
              aria-pressed={mode === m}
              title={m === 'draw' ? 'Click the corners of one roof plane, then click the first corner again to close it'
                : m === 'select' ? 'Drag a corner to move it'
                : 'Click a line on the map, then pick its type'}
            >
              {m === 'draw' ? '+ Draw facet' : m === 'select' ? 'Edit vertices' : 'Label by hand'}
            </button>
          ))}
        </div>

        {mode === 'draw' && drawingPoly.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-[#4b5563]">
              {drawingPoly.length} corner{drawingPoly.length === 1 ? '' : 's'} — click the first corner (or press Enter) to close
            </span>
            {drawingPoly.length >= 3 && (
              <button onClick={finalizeDrawingPoly}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500">Close facet</button>
            )}
            <button onClick={() => setDrawingPoly([])}
              className="rounded-md bg-white px-3 py-1.5 text-xs font-medium text-[#1a1a1a] hover:bg-[#eeeeed]">Cancel</button>
          </div>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-1" role="group" aria-label="Helpers">
          <label className="flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-[#2d2d2d] hover:bg-[#eeeeed]"
            title="Corners snap onto the roof edges in the photo. Hold Alt/Option while clicking for exact placement.">
            <input type="checkbox" checked={snapEnabled} onChange={e => setSnapEnabled(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-[#dededc]" />
            Snap to edge
          </label>
          <label className="flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-[#2d2d2d] hover:bg-[#eeeeed]"
            title="Keep new lines at right angles (or 45°) to the last one. Holding Shift does the same.">
            <input type="checkbox" checked={orthoEnabled || shiftHeld} onChange={e => setOrthoEnabled(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-[#dededc]" />
            Ortho
          </label>
          <div className="mx-1 h-5 w-px bg-[#dededc]" />
          <button onClick={undo} disabled={!canUndo} title="Undo (⌘Z / Ctrl+Z)" className={helperBtn}>↶ Undo</button>
          <button onClick={redo} disabled={!canRedo} title="Redo (⌘⇧Z / Ctrl+Y)" className={helperBtn}>↷ Redo</button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 gap-3">
        {/* Canvas */}
        <div
          ref={containerRef}
          className="relative min-h-0 flex-1 touch-none overflow-hidden rounded-lg border border-[#dededc] bg-[#f8f8f7]"
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
          {/* Blurred backdrop — fills the letterbox area with a soft continuation
              of the satellite instead of hard black bars. Sits behind the pannable
              stage and doesn't move, so it always covers the full viewport. */}
          {imageUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imageUrl}
              alt=""
              aria-hidden
              draggable={false}
              className="pointer-events-none absolute inset-0 h-full w-full scale-110 object-cover opacity-50 blur-2xl"
            />
          )}
          {/* Transformed stage — image + svg move/scale together */}
          <div
            ref={stageRef}
            className="absolute inset-0"
            style={{
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
              transformOrigin: '0 0',
              // Only while dragging. Left on permanently, the browser draws the
              // lines and letters once at 1x and stretches that bitmap, which is
              // why they went blurry on zoom; off, it redraws them sharp.
              willChange: panning ? 'transform' : 'auto',
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
              {/* The confirmed house's outline is NOT drawn here: on top of the
                  traced lines it was one more set of lines to read (Ryan,
                  2026-10-20). It still drives the off-house warning. */}
              {facets.map(renderFacetPolygon)}
              {/* "Not roof" sections: greyed and dashed, counted nowhere. Drawn
                  above the roof so their Restore pill can always be clicked. */}
              {excludedFacets.map(x => {
                const pts = x.facet.polygon.map(([px, py]) => `${px * imageDims.w},${py * imageDims.h}`).join(' ')
                const [lx, ly] = labelPoint(x.facet.polygon, imageDims.w, imageDims.h)
                return (
                  <g key={`x-${x.facet.label}`}>
                    <polygon points={pts} pointerEvents="none" fill="rgba(209,213,219,0.42)"
                      stroke="#e5e7eb" strokeWidth={2.5 / view.scale}
                      strokeDasharray={`${6 / view.scale} ${5 / view.scale}`} />
                    <g transform={`translate(${lx * imageDims.w}, ${ly * imageDims.h}) scale(${1 / view.scale})`}
                      style={{ cursor: onRestoreFacet ? 'pointer' : 'default' }}
                      onClick={(ev) => { ev.stopPropagation(); onRestoreFacet?.(x.facet.label) }}>
                      <title>Not roof — click to bring this section back into the measurement</title>
                      <rect x={-82} y={-17} width={164} height={34} rx={17} fill="#374151" fillOpacity={0.95} stroke="white" strokeWidth={1.5} />
                      <text textAnchor="middle" dominantBaseline="central" fill="white" fontSize={16} fontWeight={700}>
                        Not roof · ↺ Restore
                      </text>
                    </g>
                  </g>
                )
              })}
              {houseGuide?.point && (
                <g pointerEvents="none"
                  transform={`translate(${houseGuide.point.x * imageDims.w}, ${houseGuide.point.y * imageDims.h}) scale(${1 / view.scale})`}>
                  <rect x={-72} y={-62} width={144} height={38} rx={8} fill="#1a1a1a" fillOpacity={0.88} />
                  <text x={0} y={-43} textAnchor="middle" dominantBaseline="central" fill="white" fontSize={22} fontWeight={700}>Your house</text>
                  <circle r={10} fill="#22d3ee" stroke="white" strokeWidth={3} />
                </g>
              )}

              {/* A "?" on every line that still needs a type, readable at any zoom. */}
              {blankLines.map(e => {
                const f = facets.find(ff => ff.label === e.facetLabel)
                if (!f) return null
                const a = f.polygon[e.vertexIndexStart]; const b = f.polygon[(e.vertexIndexStart + 1) % f.polygon.length]
                if (!a || !b) return null
                const mx = (a[0] + b[0]) / 2 * imageDims.w; const my = (a[1] + b[1]) / 2 * imageDims.h
                return (
                  <g key={`q-${e.facetLabel}-${e.vertexIndexStart}`}
                    transform={`translate(${mx}, ${my}) scale(${1 / view.scale})`}
                    style={{ cursor: 'pointer' }}
                    onClick={(ev) => { ev.stopPropagation(); goToLine(e) }}>
                    <circle r={11} fill={EDGE_COLORS.unlabeled} stroke="white" strokeWidth={2} />
                    <text textAnchor="middle" dominantBaseline="central" fill="white" fontSize={14} fontWeight={800}>?</text>
                  </g>
                )
              })}

              {/* Rubber-band: dashed line from the last placed vertex to the
                  live cursor, so the contractor sees the edge BEFORE clicking. */}
              {mode === 'draw' && hoverPt && drawingPoly.length > 0 && (
                <line
                  x1={drawingPoly[drawingPoly.length - 1][0] * imageDims.w}
                  y1={drawingPoly[drawingPoly.length - 1][1] * imageDims.h}
                  x2={hoverPt[0] * imageDims.w}
                  y2={hoverPt[1] * imageDims.h}
                  stroke={hoverSnappedVertex ? '#22d3ee' : '#fbbf24'}
                  strokeWidth={3.5 / view.scale}
                  strokeDasharray={`${5 / view.scale} ${4 / view.scale}`}
                  opacity={0.9}
                />
              )}

              {/* In-progress polygon */}
              {drawingPoly.length > 0 && (
                <g>
                  {drawingPoly.length >= 2 && (
                    <>
                      {/* Dark halo so the trace stays visible on light roofs */}
                      <polyline
                        points={drawingPoly.map(([x, y]) => `${x * imageDims.w},${y * imageDims.h}`).join(' ')}
                        fill="none"
                        stroke="rgba(0,0,0,0.55)"
                        strokeWidth={8 / view.scale}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                      <polyline
                        points={drawingPoly.map(([x, y]) => `${x * imageDims.w},${y * imageDims.h}`).join(' ')}
                        fill="none"
                        stroke="#fbbf24"
                        strokeWidth={4.5 / view.scale}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </>
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

          {/* Magnifier loupe — the close-up for landing a corner exactly on a
              roof edge, showing the geometry as well as the pixels so a shared
              vertex is visible before you commit to it. Draw mode only. */}
          {mode === 'draw' && hoverPt && imageUrl && (
            <MagnifierLoupe
              imageUrl={imageUrl}
              imageDims={imageDims}
              hoverPt={hoverPt}
              viewScale={view.scale}
              facets={facets}
              drawingPoly={drawingPoly}
              snapped={hoverSnappedVertex}
            />
          )}

          {/* First-use coachmark — dismissible tips, shown once. */}
          {showCoach && (
            <div className="pointer-events-auto absolute left-1/2 top-4 z-30 w-[min(420px,90%)] -translate-x-1/2 rounded-lg border border-blue-400/40 bg-[#f8f8f7] p-4 shadow-2xl">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-sm font-semibold text-[#1a1a1a]">How to trace a roof for the best results</div>
                <button onClick={dismissCoach} className="rounded p-1 text-[#6b7280] hover:bg-[#eeeeed] hover:text-[#1a1a1a]">✕</button>
              </div>
              <p className="mb-2 rounded bg-blue-50 px-2 py-1.5 text-[11px] text-blue-900">
                The AI auto-labels your edges (ridge, eave, hip, valley) by reading how the planes fit
                together — so a <strong>clean, complete trace = far better labels + accuracy</strong>.
              </p>
              <ol className="space-y-2 text-xs text-[#1a1a1a]">
                <li className="flex gap-2">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[11px] font-bold text-white">1</span>
                  <span><strong>Zoom in first.</strong> Scroll to fill the screen with the roof. Use the loupe (top-right) to place each corner exactly on the roof edge.</span>
                </li>
                <li className="flex gap-2">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[11px] font-bold text-white">2</span>
                  <span>Trace <strong>one flat plane at a time.</strong> Click each corner, then click the <strong>first dot</strong> (or <kbd className="rounded bg-[#eeeeed] px-1">Enter</kbd>) to close it. One polygon = one slope of the roof.</span>
                </li>
                <li className="flex gap-2">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[11px] font-bold text-white">3</span>
                  <span><strong>Share the edges.</strong> Where two planes meet (a ridge or valley), trace right along the same line — dots turn <span className="text-cyan-300">cyan</span> and snap onto the neighbor so the two planes connect. This is what tells the AI it&apos;s a ridge/hip/valley.</span>
                </li>
                <li className="flex gap-2">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[11px] font-bold text-white">4</span>
                  <span><strong>Trace EVERY plane</strong> before labeling — including small dormers and porch roofs. Missing planes make edges mislabel.</span>
                </li>
                <li className="flex gap-2">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-[11px] font-bold text-white">5</span>
                  <span>When every plane is traced, follow the <strong>status card above the map</strong>: label the lines, then confirm them. The measurements lock in once every line is confirmed.</span>
                </li>
              </ol>
              <div className="mt-2 rounded bg-[#eeeeed] px-2 py-1.5 text-[10px] text-[#6b7280]">
                <kbd className="rounded bg-[#e4e4e2] px-1 text-[#1a1a1a]">Shift</kbd> square corners ·
                drag = pan · scroll = zoom · <kbd className="rounded bg-[#e4e4e2] px-1 text-[#1a1a1a]">⌘Z</kbd> undo
              </div>
              <button onClick={dismissCoach} className="mt-3 w-full rounded bg-blue-600 py-1.5 text-xs font-semibold text-white hover:bg-blue-500">Got it — let me trace</button>
            </div>
          )}

          {/* Floating pan keypad — top-right. INSTANT CSS pan (no refetch, no
              facet misalignment). Drag the canvas, scroll to zoom, or use
              arrow keys / WASD (held = continuous) for the same effect. */}
          <div className="pointer-events-auto absolute right-2 top-2 grid grid-cols-3 gap-0.5 rounded-md border border-[#dededc] bg-[#f8f8f7] p-1 shadow-lg">
            <div></div>
            <button
              onClick={() => panView(0, 70)}
              title="Pan up (↑ / W)"
              className="flex h-8 w-8 items-center justify-center rounded bg-[#eeeeed] text-base text-[#1a1a1a] hover:bg-blue-600 hover:text-white"
            >↑</button>
            <div></div>
            <button
              onClick={() => panView(70, 0)}
              title="Pan left (← / A)"
              className="flex h-8 w-8 items-center justify-center rounded bg-[#eeeeed] text-base text-[#1a1a1a] hover:bg-blue-600 hover:text-white"
            >←</button>
            <div className="flex h-8 w-8 items-center justify-center text-[9px] text-[#6b7280]">pan</div>
            <button
              onClick={() => panView(-70, 0)}
              title="Pan right (→ / D)"
              className="flex h-8 w-8 items-center justify-center rounded bg-[#eeeeed] text-base text-[#1a1a1a] hover:bg-blue-600 hover:text-white"
            >→</button>
            <div></div>
            <button
              onClick={() => panView(0, -70)}
              title="Pan down (↓ / S)"
              className="flex h-8 w-8 items-center justify-center rounded bg-[#eeeeed] text-base text-[#1a1a1a] hover:bg-blue-600 hover:text-white"
            >↓</button>
            <div></div>
          </div>

          {/* "What is this line?" — the selected line is zoomed to and pulsing;
              pick its type by name, and the next one that needs a type comes up. */}
          {guiding && mode === 'label' && selectedRecord && (
            <div className="pointer-events-auto absolute left-2 top-2 z-10 w-[300px] rounded-lg border border-[#ff1fa8]/40 bg-white/95 p-3 text-xs text-[#1a1a1a] shadow-lg">
              <div className="mb-1 flex items-center justify-between">
                <strong className="text-sm">What is this line?</strong>
                <button onClick={() => { setGuiding(false); setSelectedEdge(null) }}
                  className="rounded px-1.5 text-[#6b7280] hover:text-[#1a1a1a]" title="Close">✕</button>
              </div>
              <p className="mb-2 text-[11px] text-[#6b7280]">
                {selectedRecord.edgeType === 'unlabeled'
                  ? `${unlabeledCount} line${unlabeledCount === 1 ? '' : 's'} left. The pulsing line is the one being asked about.`
                  : `Currently: ${selectedRecord.edgeType.replace('_', ' ')}. Pick another type to change it.`}
                {selectedRecord.sharedWithFacetLabel ? ' It sits between two roof planes.' : ' It is on the outside edge of the roof.'}
              </p>
              <div className="grid grid-cols-2 gap-1.5">
                {(Object.keys(LINE_HINTS) as (keyof typeof LINE_HINTS)[]).map(t => (
                  <button key={t} onClick={() => typeSelectedLine(t)} title={LINE_HINTS[t]}
                    className="flex items-center gap-1.5 rounded border border-[#dededc] bg-[#f8f8f7] px-2 py-1.5 text-left hover:border-[#1a1a1a]/30 hover:bg-white">
                    <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: EDGE_COLORS[t] }} />
                    <span className="font-medium capitalize">{t === 'wall_intersection' ? 'Wall / chimney' : t}</span>
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[10px] leading-snug text-[#6b7280]">
                Ridge: level top line · Hip: sloped, falls away both sides · Valley: sloped V · Eave: gutter edge ·
                Rake: sloped gable edge · Wall: roof meets a wall or chimney.
              </p>
            </div>
          )}

          {/* Floating legend — what the three line states mean. Collapsible. */}
          <div className="pointer-events-auto absolute bottom-2 left-2 z-10 rounded-md border border-[#dededc] bg-white/95 text-[11px] text-[#2d2d2d] shadow">
            <button onClick={() => setLegendOpen(o => !o)} aria-expanded={legendOpen}
              className="flex w-full items-center justify-between gap-3 px-2 py-1 font-semibold">
              Legend <span aria-hidden>{legendOpen ? '−' : '+'}</span>
            </button>
            {legendOpen && (
              <ul className="space-y-1 border-t border-[#eeeeed] px-2 py-1.5">
                <li className="flex items-center gap-2">
                  <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full text-[9px] font-bold text-white" style={{ background: EDGE_COLORS.unlabeled }}>?</span>
                  Unlabeled
                </li>
                <li className="flex items-center gap-2">
                  <span className="inline-block h-1.5 w-4 rounded" style={{ background: STATE_SWATCH, boxShadow: `0 0 0 3px ${STATE_SWATCH}55` }} />
                  Labeled (needs confirm)
                </li>
                <li className="flex items-center gap-2">
                  <span className="inline-block h-1 w-4 rounded opacity-80" style={{ background: STATE_SWATCH }} />
                  Confirmed
                </li>
                <li className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 border-t border-[#eeeeed] pt-1 text-[10px] text-[#6b7280]">
                  {(['ridge', 'hip', 'valley', 'eave', 'rake', 'wall_intersection'] as EdgeType[]).map(t => (
                    <span key={t} className="flex items-center gap-1">
                      <span className="inline-block h-1.5 w-2.5 rounded-sm" style={{ background: EDGE_COLORS[t] }} />
                      {t === 'wall_intersection' ? 'wall' : t}
                    </span>
                  ))}
                </li>
              </ul>
            )}
          </div>

          {/* Floating zoom controls */}
          <div className="pointer-events-none absolute bottom-2 right-2 flex flex-col items-end gap-1">
            <div className="pointer-events-auto flex items-center gap-1 rounded-md border border-[#dededc] bg-[#f8f8f7] p-1 text-xs text-[#1a1a1a]">
              <button
                onClick={zoomOut}
                className="rounded px-2 py-1 hover:bg-[#eeeeed]"
                title="Zoom out (-)"
              >−</button>
              <span className="min-w-[3.2rem] px-1 text-center font-mono">
                {(view.scale * 100).toFixed(0)}%
              </span>
              <button
                onClick={zoomIn}
                className="rounded px-2 py-1 hover:bg-[#eeeeed]"
                title="Zoom in (+)"
              >+</button>
              <button
                onClick={() => (facets.length ? fitToRoof() : resetView())}
                className="ml-1 rounded bg-[#eeeeed] px-2 py-1 hover:bg-[#e4e4e2]"
                title={facets.length ? 'Frame the roof (0 = whole photo)' : 'Reset view (0)'}
              >Fit</button>
            </div>
            <div className="pointer-events-none rounded bg-[#f8f8f7] px-2 py-1 text-[10px] text-[#6b7280]">
              Wheel = zoom · Space + drag (or middle-mouse) = pan
            </div>
          </div>
        </div>

        {/* Manual labeling — collapsed by default.
            A first-timer does not need a per-facet list to trace a roof; the
            canvas is the job. But the collapsed rail was a bare hamburger and a
            number, which nobody could be expected to decode — so it now says
            what it is, vertically when narrow and as a full header when open. */}
        <aside className={`shrink-0 overflow-y-auto rounded-lg border border-[#dededc] bg-[#f8f8f7] text-sm transition-all ${facetPanelOpen ? 'w-72 p-3' : 'w-12 p-2'}`}>
          <button
            onClick={() => setFacetPanelOpen(o => !o)}
            title={facetPanelOpen ? 'Hide manual labeling' : 'Open manual labeling — rename, set pitch, delete facets by hand'}
            aria-expanded={facetPanelOpen}
            className={`flex w-full items-center rounded font-semibold text-[#0068d6] hover:text-[#01498f] ${facetPanelOpen ? 'mb-2 justify-between gap-2 text-xs uppercase tracking-wide' : 'flex-col justify-center gap-2 py-1'}`}
          >
            {facetPanelOpen ? (
              <>
                <span>Manual labeling ({facets.length})</span>
                <span aria-hidden className="text-sm">×</span>
              </>
            ) : (
              <>
                <span aria-hidden className="text-base leading-none">✎</span>
                <span
                  className="whitespace-nowrap text-[10px] font-bold uppercase tracking-[0.14em]"
                  style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
                >Manual labeling</span>
                <span className="rounded-full bg-[#0068d6] px-1.5 text-[10px] font-bold tabular-nums text-white">{facets.length}</span>
              </>
            )}
          </button>
          {!facetPanelOpen ? null : (
          <>

          {facets.length === 0 && (
            <p className="text-xs text-[#6b7280]">
              No facets yet. Switch to <strong>+ Draw facet</strong> and click points around a roof plane to trace it. Press <kbd className="rounded bg-[#eeeeed] px-1">Enter</kbd> to close.
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
                  className={`rounded-md border p-2 transition ${ isActive ? 'border-blue-400/60 bg-blue-500/10' : 'border-[#dededc] bg-[#eeeeed]' }`}
                  onClick={() => setActiveFacetIdx(i)}
                >
                  <div className="mb-1 flex items-center justify-between">
                    <strong className="text-[#1a1a1a]">Facet {f.label}</strong>
                    <button
                      onClick={(ev) => { ev.stopPropagation(); deleteFacet(i) }}
                      className="text-xs text-rose-400 hover:text-rose-800"
                    >Remove</button>
                  </div>
                  <div className="mb-1 flex items-center gap-2 text-xs text-[#2d2d2d]">
                    <label className="text-[#6b7280]">Pitch:</label>
                    <select
                      value={f.pitch}
                      onChange={(ev) => setFacetPitch(i, ev.target.value)}
                      onClick={(ev) => ev.stopPropagation()}
                      className="rounded bg-[#eeeeed] px-2 py-1 text-xs text-[#1a1a1a]"
                    >
                      {PITCH_OPTIONS.map(p => <option key={p} value={p}>{p}</option>)}
                    </select>
                    {(() => {
                      const m = pitchSourceMeta(f.pitchSource)
                      return <span className={`text-[11px] ${m.color}`} title="Where this pitch came from">{m.label}</span>
                    })()}
                  </div>
                  <div className="text-xs text-[#6b7280]">
                    {f.polygon.length} vertices · {labeled}/{facetEdges.length} edges labeled
                  </div>

                  {/* Inline edge label list when this facet is active.
                      Hover a row to highlight that exact edge on the canvas. */}
                  {isActive && facetEdges.length > 0 && (
                    <div className="mt-2 border-t border-[#dededc] pt-2">
                      <div className="mb-1 text-xs text-[#6b7280]">Edges — hover to find it on the roof:</div>
                      <ul className="space-y-1">
                        {facetEdges.map((e, eIdx) => {
                          const color = EDGE_COLORS[e.edgeType]
                          const rowSelected = selectedEdge?.facetIdx === i && selectedEdge.edgeIdx === e.vertexIndexStart
                          const unlabeled = e.edgeType === 'unlabeled'
                          return (
                            <li
                              key={`${e.vertexIndexStart}-${e.vertexIndexEnd}`}
                              onMouseEnter={() => setSelectedEdge({ facetIdx: i, edgeIdx: e.vertexIndexStart })}
                              className={`flex items-center justify-between gap-2 rounded px-2 py-1 text-xs transition ${ rowSelected ? 'bg-[#e4e4e2] ring-1 ring-white/40' : 'bg-[#eeeeed]' }`}
                            >
                              <span className="flex items-center gap-2">
                                <span className="inline-block h-3 w-3 rounded-sm" style={{ background: color }} />
                                <span className="font-medium text-[#1a1a1a]">Edge {eIdx + 1}</span>
                                {unlabeled && <span className="text-[10px] text-amber-400">needs label</span>}
                                {e.sharedWithFacetLabel && (
                                  <span className="rounded bg-[#e4e4e2] px-1 text-[10px] text-[#2d2d2d]">shared ↔ {e.sharedWithFacetLabel}</span>
                                )}
                              </span>
                              <select
                                value={e.edgeType}
                                onChange={(ev) => setEdgeLabel(i, e.vertexIndexStart, ev.target.value as EdgeType)}
                                onClick={(ev) => ev.stopPropagation()}
                                className="rounded bg-[#e4e4e2] px-1 py-0.5 text-xs text-[#1a1a1a]"
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
          <h3 className="mt-4 mb-2 text-xs font-semibold uppercase tracking-wide text-[#6b7280]">Edge legend</h3>
          <ul className="space-y-1 text-xs text-[#2d2d2d]">
            {(Object.keys(EDGE_COLORS) as EdgeType[]).filter(k => k !== 'unlabeled' && k !== 'gable_end').map(t => (
              <li key={t} className="flex items-center gap-2">
                <span className="inline-block h-2 w-4 rounded" style={{ background: EDGE_COLORS[t] }} />
                {t.replace('_', ' ')}
              </li>
            ))}
          </ul>
          </>
          )}
        </aside>
      </div>
    </div>
  )
}

export default RoofFacetEditor
