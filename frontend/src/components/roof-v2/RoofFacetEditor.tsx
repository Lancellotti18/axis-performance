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

export function RoofFacetEditor({
  imageUrl, imageWidthPx, imageHeightPx,
  initialFacets = [], initialEdges = [], onChange,
}: Props) {
  const [facets, setFacets] = useState<Facet[]>(initialFacets)
  const [edges, setEdges] = useState<LabeledEdge[]>(initialEdges)
  const [mode, setMode] = useState<Mode>('draw')
  const [activeFacetIdx, setActiveFacetIdx] = useState<number | null>(null)
  const [drawingPoly, setDrawingPoly] = useState<Pt[]>([])
  const [dragVertex, setDragVertex] = useState<{ facetIdx: number; vertexIdx: number } | null>(null)
  const [selectedEdge, setSelectedEdge] = useState<{ facetIdx: number; edgeIdx: number } | null>(null)
  const [imageDims, setImageDims] = useState({ w: imageWidthPx, h: imageHeightPx })
  const svgRef = useRef<SVGSVGElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const lastOnChangeRef = useRef<string>('')

  // Notify parent whenever facets or edges change — JSON-compare to avoid loops.
  useEffect(() => {
    const snap = JSON.stringify({ facets, edges })
    if (snap === lastOnChangeRef.current) return
    lastOnChangeRef.current = snap
    onChange(facets, edges)
  }, [facets, edges, onChange])

  // ---- Coordinate helpers ----
  const eventToFrac = useCallback((ev: React.PointerEvent | PointerEvent): Pt => {
    const svg = svgRef.current
    if (!svg) return [0, 0]
    const rect = svg.getBoundingClientRect()
    const x = (ev.clientX - rect.left) / rect.width
    const y = (ev.clientY - rect.top) / rect.height
    return [clampFrac(x), clampFrac(y)]
  }, [])

  // ---- Drawing flow ----
  const onSvgPointerDown = useCallback((ev: React.PointerEvent<SVGSVGElement>) => {
    if (mode !== 'draw') return
    if (ev.button !== 0) return
    const pt = eventToFrac(ev)
    // Close polygon if clicking near first vertex
    if (drawingPoly.length >= 3) {
      const [fx, fy] = drawingPoly[0]
      if (Math.abs(pt[0] - fx) < 0.012 && Math.abs(pt[1] - fy) < 0.018) {
        finalizeDrawingPoly()
        return
      }
    }
    setDrawingPoly(prev => [...prev, pt])
  }, [mode, drawingPoly, eventToFrac])

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
            <line
              key={i}
              x1={p1[0] * imageDims.w} y1={p1[1] * imageDims.h}
              x2={p2[0] * imageDims.w} y2={p2[1] * imageDims.h}
              stroke={color}
              strokeWidth={isSel ? 6 : 4}
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
          )
        })}
        {/* Vertices */}
        {f.polygon.map(([x, y], i) => (
          <circle
            key={i}
            cx={x * imageDims.w} cy={y * imageDims.h} r={8}
            fill="white"
            stroke={isActive ? '#3b82f6' : '#475569'}
            strokeWidth={2}
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
              transform={`translate(${cx * imageDims.w}, ${cy * imageDims.h})`}
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
        <div className="mx-2 h-5 w-px bg-white/10" />
        <span className="text-xs text-slate-400">
          {facets.length} facet{facets.length === 1 ? '' : 's'}
        </span>
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
          }}
          tabIndex={0}
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
            />
          )}
          <svg
            ref={svgRef}
            viewBox={`0 0 ${imageDims.w} ${imageDims.h}`}
            preserveAspectRatio="xMidYMid meet"
            className="absolute inset-0 h-full w-full"
            style={{ cursor: mode === 'draw' ? 'crosshair' : 'default' }}
            onPointerDown={onSvgPointerDown}
            onDoubleClick={() => mode === 'draw' && finalizeDrawingPoly()}
          >
            {facets.map(renderFacetPolygon)}

            {/* In-progress polygon */}
            {drawingPoly.length > 0 && (
              <g>
                {drawingPoly.length >= 2 && (
                  <polyline
                    points={drawingPoly.map(([x, y]) => `${x * imageDims.w},${y * imageDims.h}`).join(' ')}
                    fill="none"
                    stroke="#fbbf24"
                    strokeWidth={3}
                    strokeDasharray="6 4"
                  />
                )}
                {drawingPoly.map(([x, y], i) => (
                  <circle
                    key={i}
                    cx={x * imageDims.w} cy={y * imageDims.h} r={i === 0 ? 10 : 7}
                    fill={i === 0 ? '#fbbf24' : 'white'}
                    stroke="#fbbf24"
                    strokeWidth={2}
                  />
                ))}
              </g>
            )}
          </svg>
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

                  {/* Inline edge label list when this facet is active */}
                  {isActive && facetEdges.length > 0 && (
                    <div className="mt-2 border-t border-white/10 pt-2">
                      <div className="mb-1 text-xs text-slate-400">Edges:</div>
                      <ul className="space-y-1">
                        {facetEdges.map(e => {
                          const color = EDGE_COLORS[e.edgeType]
                          return (
                            <li
                              key={`${e.vertexIndexStart}-${e.vertexIndexEnd}`}
                              className="flex items-center justify-between gap-2 rounded bg-slate-800/60 px-2 py-1 text-xs"
                            >
                              <span className="flex items-center gap-2">
                                <span
                                  className="inline-block h-2 w-3 rounded"
                                  style={{ background: color }}
                                />
                                {e.vertexIndexStart}→{e.vertexIndexEnd}
                                {e.sharedWithFacetLabel && (
                                  <span className="rounded bg-slate-700 px-1 text-[10px] text-slate-300">↔{e.sharedWithFacetLabel}</span>
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
