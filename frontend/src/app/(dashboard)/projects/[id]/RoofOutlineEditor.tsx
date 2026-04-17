'use client'
/**
 * RoofOutlineEditor — EagleView-style editable roof polygon over a satellite tile.
 *
 * Flow: user opens the modal from the aerial-report panel, we call
 * /roofing/outline to get an AI-traced polygon in 0..1 image fractions,
 * then render it as an SVG with draggable corner handles. Area and
 * perimeter update live as vertices move.
 *
 * Scale: Esri World Imagery at zoom 18.
 *   mpp = 156543.03392 × cos(lat_rad) / 2^18   metres per native pixel
 *   ft_per_px = mpp × 3.28084
 * All coordinates are stored as image-fraction pairs so resizing the
 * preview doesn't change the polygon — only the on-screen projection.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '@/lib/api'

const DISPLAY_W = 640
const DISPLAY_H = 420
const NATIVE_W = 1280
const NATIVE_H = 840
const ZOOM = 18
const ESRI_MPP0 = 156543.03392
const M_TO_FT = 3.28084

function ftPerPx(lat: number): number {
  return (ESRI_MPP0 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, ZOOM) * M_TO_FT
}

// Shoelace area in image-fraction² (closed polygon).
function shoelaceFrac(pts: [number, number][]): number {
  const n = pts.length
  if (n < 3) return 0
  let s = 0
  for (let i = 0; i < n; i++) {
    const [x1, y1] = pts[i]
    const [x2, y2] = pts[(i + 1) % n]
    s += x1 * y2 - x2 * y1
  }
  return Math.abs(s) / 2
}

function perimeterFt(pts: [number, number][], fpp: number): number {
  const n = pts.length
  if (n < 2) return 0
  let total = 0
  for (let i = 0; i < n; i++) {
    const [x1, y1] = pts[i]
    const [x2, y2] = pts[(i + 1) % n]
    const dx = (x2 - x1) * NATIVE_W * fpp
    const dy = (y2 - y1) * NATIVE_H * fpp
    total += Math.sqrt(dx * dx + dy * dy)
  }
  return total
}

interface Props {
  open: boolean
  onClose: () => void
  imageUrl: string
  lat: number | null
  initialPolygon?: [number, number][]
  initialConfidence?: number
  initialNotes?: string
  initialWarnings?: string[]
  onApply?: (result: { polygon: [number, number][]; sqft: number; perimeterFt: number }) => void
}

export default function RoofOutlineEditor({
  open,
  onClose,
  imageUrl,
  lat,
  initialPolygon,
  initialConfidence,
  initialNotes,
  initialWarnings,
  onApply,
}: Props) {
  const [polygon, setPolygon] = useState<[number, number][]>(initialPolygon || [])
  const [confidence, setConfidence] = useState<number>(initialConfidence ?? 0)
  const [notes, setNotes] = useState<string>(initialNotes || '')
  const [warnings, setWarnings] = useState<string[]>(initialWarnings || [])
  const [detecting, setDetecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null)

  const svgRef = useRef<SVGSVGElement>(null)
  const draggingIdx = useRef<number | null>(null)

  // Reset state when the modal reopens with a fresh polygon.
  useEffect(() => {
    if (!open) return
    setPolygon(initialPolygon || [])
    setConfidence(initialConfidence ?? 0)
    setNotes(initialNotes || '')
    setWarnings(initialWarnings || [])
    setError(null)
    setSelectedIdx(null)
  }, [open, initialPolygon, initialConfidence, initialNotes, initialWarnings])

  const fpp = lat != null ? ftPerPx(lat) : null

  const stats = useMemo(() => {
    const areaFrac = shoelaceFrac(polygon)
    if (!fpp) return { sqft: null, perimeter: null }
    const sqft = areaFrac * NATIVE_W * NATIVE_H * fpp * fpp
    const perim = perimeterFt(polygon, fpp)
    return { sqft: Math.round(sqft), perimeter: Math.round(perim) }
  }, [polygon, fpp])

  // Segment lengths for per-edge labels
  const edgeLengths = useMemo(() => {
    if (!fpp) return [] as number[]
    return polygon.map((_, i) => {
      const [x1, y1] = polygon[i]
      const [x2, y2] = polygon[(i + 1) % polygon.length]
      const dx = (x2 - x1) * NATIVE_W * fpp
      const dy = (y2 - y1) * NATIVE_H * fpp
      return Math.round(Math.sqrt(dx * dx + dy * dy))
    })
  }, [polygon, fpp])

  const toDisplay = (pt: [number, number]): [number, number] => [
    pt[0] * DISPLAY_W,
    pt[1] * DISPLAY_H,
  ]

  const fromClient = useCallback((clientX: number, clientY: number): [number, number] => {
    const svg = svgRef.current
    if (!svg) return [0, 0]
    const rect = svg.getBoundingClientRect()
    const x = (clientX - rect.left) / rect.width
    const y = (clientY - rect.top) / rect.height
    return [Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y))]
  }, [])

  const onVertexDown = (idx: number) => (e: React.PointerEvent) => {
    e.stopPropagation()
    e.preventDefault()
    draggingIdx.current = idx
    setSelectedIdx(idx)
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
  }

  const onSvgPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (draggingIdx.current == null) return
    const pt = fromClient(e.clientX, e.clientY)
    setPolygon(prev => {
      const next = [...prev]
      next[draggingIdx.current as number] = pt
      return next
    })
  }

  const onSvgPointerUp = () => {
    draggingIdx.current = null
  }

  // Click on an edge inserts a new vertex at the midpoint.
  const onEdgeClick = (idx: number) => (e: React.MouseEvent) => {
    e.stopPropagation()
    setPolygon(prev => {
      const n = prev.length
      if (n < 2) return prev
      const [x1, y1] = prev[idx]
      const [x2, y2] = prev[(idx + 1) % n]
      const mid: [number, number] = [(x1 + x2) / 2, (y1 + y2) / 2]
      const next = [...prev]
      next.splice(idx + 1, 0, mid)
      return next
    })
  }

  const removeSelected = () => {
    if (selectedIdx == null) return
    if (polygon.length <= 3) return
    setPolygon(prev => prev.filter((_, i) => i !== selectedIdx))
    setSelectedIdx(null)
  }

  const redetect = async () => {
    setDetecting(true)
    setError(null)
    try {
      const res = await api.roofing.detectOutline(imageUrl, lat, {
        imageWidthPx: NATIVE_W,
        imageHeightPx: NATIVE_H,
        zoom: ZOOM,
      })
      setPolygon((res.polygon || []) as [number, number][])
      setConfidence(res.confidence || 0)
      setNotes(res.notes || '')
      setWarnings(res.warnings || [])
    } catch (e) {
      setError((e as Error).message || 'Outline detection failed')
    }
    setDetecting(false)
  }

  // Auto-detect on first open if we don't already have an outline.
  useEffect(() => {
    if (!open) return
    if (polygon.length > 0) return
    if (!imageUrl) return
    redetect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, imageUrl])

  if (!open) return null

  const path =
    polygon.length >= 2
      ? polygon.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0] * DISPLAY_W} ${p[1] * DISPLAY_H}`).join(' ') + ' Z'
      : ''

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl max-w-5xl w-full overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200">
          <div>
            <h3 className="text-base font-bold text-slate-900">Edit roof outline</h3>
            <p className="text-xs text-slate-500">
              Drag corners to correct the AI&rsquo;s trace. Click an edge to add a point.
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700 text-xl leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="grid md:grid-cols-[1fr_280px] gap-0">
          {/* ── Viewport ─────────────────────────────────────────────── */}
          <div className="bg-slate-900 p-3 flex items-center justify-center">
            <div
              style={{
                position: 'relative',
                width: DISPLAY_W,
                height: DISPLAY_H,
                maxWidth: '100%',
              }}
            >
              <img
                src={imageUrl}
                alt="Satellite"
                width={DISPLAY_W}
                height={DISPLAY_H}
                draggable={false}
                style={{ display: 'block', width: '100%', height: '100%', userSelect: 'none' }}
              />
              <svg
                ref={svgRef}
                viewBox={`0 0 ${DISPLAY_W} ${DISPLAY_H}`}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: '100%',
                  touchAction: 'none',
                }}
                onPointerMove={onSvgPointerMove}
                onPointerUp={onSvgPointerUp}
                onPointerLeave={onSvgPointerUp}
              >
                {/* Fill */}
                {path && (
                  <path
                    d={path}
                    fill="rgba(250,204,21,0.18)"
                    stroke="#facc15"
                    strokeWidth={2.25}
                    strokeLinejoin="round"
                  />
                )}

                {/* Edge hit-targets + labels */}
                {polygon.map((_, i) => {
                  const [x1, y1] = toDisplay(polygon[i])
                  const [x2, y2] = toDisplay(polygon[(i + 1) % polygon.length])
                  const mx = (x1 + x2) / 2
                  const my = (y1 + y2) / 2
                  const len = edgeLengths[i]
                  return (
                    <g key={`edge-${i}`}>
                      <line
                        x1={x1}
                        y1={y1}
                        x2={x2}
                        y2={y2}
                        stroke="transparent"
                        strokeWidth={14}
                        style={{ cursor: 'copy' }}
                        onClick={onEdgeClick(i)}
                      />
                      {len != null && len > 0 && (
                        <g pointerEvents="none">
                          <rect
                            x={mx - 22}
                            y={my - 9}
                            width={44}
                            height={16}
                            rx={3}
                            fill="rgba(15,23,42,0.85)"
                          />
                          <text
                            x={mx}
                            y={my + 3}
                            textAnchor="middle"
                            fill="#fcd34d"
                            fontSize={10}
                            fontWeight={700}
                          >
                            {len} ft
                          </text>
                        </g>
                      )}
                    </g>
                  )
                })}

                {/* Vertex handles */}
                {polygon.map((p, i) => {
                  const [x, y] = toDisplay(p)
                  const active = selectedIdx === i
                  return (
                    <g key={`v-${i}`}>
                      <circle
                        cx={x}
                        cy={y}
                        r={active ? 10 : 8}
                        fill={active ? '#f59e0b' : 'white'}
                        stroke={active ? 'white' : '#f59e0b'}
                        strokeWidth={2.5}
                        style={{ cursor: 'grab' }}
                        onPointerDown={onVertexDown(i)}
                      />
                    </g>
                  )
                })}
              </svg>

              {/* Empty / loading states */}
              {detecting && (
                <div className="absolute inset-0 flex items-center justify-center bg-slate-900/60 text-amber-200 text-xs font-semibold">
                  <svg className="animate-spin w-4 h-4 mr-2" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                  </svg>
                  Tracing roof outline…
                </div>
              )}
              {!detecting && polygon.length === 0 && !error && (
                <div className="absolute inset-0 flex items-center justify-center text-slate-300 text-xs">
                  No outline detected yet — tap &ldquo;Re-detect&rdquo;.
                </div>
              )}
            </div>
          </div>

          {/* ── Sidebar ─────────────────────────────────────────────── */}
          <div className="p-4 border-l border-slate-200 bg-slate-50 flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2">
              <div className="bg-white rounded-lg p-2 border border-slate-200">
                <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Roof area</div>
                <div className="text-xl font-black text-slate-900 tabular-nums leading-none">
                  {stats.sqft != null ? stats.sqft.toLocaleString() : '—'}
                </div>
                <div className="text-[10px] text-slate-500">sqft</div>
              </div>
              <div className="bg-white rounded-lg p-2 border border-slate-200">
                <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Perimeter</div>
                <div className="text-xl font-black text-slate-900 tabular-nums leading-none">
                  {stats.perimeter != null ? stats.perimeter.toLocaleString() : '—'}
                </div>
                <div className="text-[10px] text-slate-500">ft</div>
              </div>
            </div>

            {confidence > 0 && (
              <div className="text-[11px] text-slate-500">
                AI confidence:{' '}
                <span className="font-semibold text-slate-700">
                  {Math.round(confidence * 100)}%
                </span>
              </div>
            )}

            {notes && (
              <div className="text-[11px] text-slate-600 bg-white rounded-lg p-2 border border-slate-200 leading-relaxed">
                {notes}
              </div>
            )}

            {warnings.length > 0 && (
              <div className="text-[11px] text-amber-700 bg-amber-50 rounded-lg p-2 border border-amber-200 leading-relaxed space-y-1">
                {warnings.map((w, i) => (
                  <div key={i}>⚠ {w}</div>
                ))}
              </div>
            )}

            {error && (
              <div className="text-[11px] text-red-700 bg-red-50 rounded-lg p-2 border border-red-200">
                {error}
              </div>
            )}

            <div className="flex flex-col gap-2 mt-auto">
              <button
                onClick={redetect}
                disabled={detecting}
                className="px-3 py-2 rounded-lg text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-100 disabled:opacity-50"
              >
                {detecting ? 'Detecting…' : '↻ Re-detect outline'}
              </button>
              <button
                onClick={removeSelected}
                disabled={selectedIdx == null || polygon.length <= 3}
                className="px-3 py-2 rounded-lg text-xs font-semibold text-red-700 bg-white border border-red-200 hover:bg-red-50 disabled:opacity-40"
              >
                Remove selected corner
              </button>
              <button
                onClick={() => {
                  if (onApply && stats.sqft != null && stats.perimeter != null) {
                    onApply({
                      polygon,
                      sqft: stats.sqft,
                      perimeterFt: stats.perimeter,
                    })
                  }
                  onClose()
                }}
                disabled={polygon.length < 3 || stats.sqft == null}
                className="px-3 py-2 rounded-lg text-xs font-bold text-white shadow-sm disabled:opacity-50"
                style={{
                  background:
                    polygon.length < 3 || stats.sqft == null
                      ? '#94a3b8'
                      : 'linear-gradient(135deg, #f59e0b, #d97706)',
                }}
              >
                Apply measurements
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
