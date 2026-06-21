'use client'

/**
 * Axis Performance — EagleView-style annotated 2D roof view.
 *
 * Renders the satellite tile + facet polygons + edge labels + pitch arrows
 * + area callouts in a clean, report-ready layout. This is the visualization
 * adjusters expect — color-coded edges, labeled measurements, no editing UI.
 *
 * Export to PNG via the browser's native canvas serialization. The same SVG
 * is embedded in the PDF report's roof section for a consistent look.
 *
 * Color coding matches the spec / measurement-key page convention:
 *   ridges: black, eaves: gold, rakes: purple, hips: dark gray,
 *   valleys: blue, step flashing: red, flashing: orange
 */
import { useMemo, useRef, useState } from 'react'
import type { Facet, LabeledEdge, EdgeType } from './RoofFacetEditor'

interface Props {
  imageUrl: string
  imageWidthPx: number
  imageHeightPx: number
  facets: Facet[]
  edges: LabeledEdge[]
  aggregates?: {
    total_roof_sqft?: number
    squares?: number
    predominant_pitch?: string
    eaves_ft?: number
    rakes_ft?: number
    ridges_ft?: number
    hips_ft?: number
    valleys_ft?: number
  }
}

const EDGE_COLORS: Record<EdgeType, string> = {
  eave: '#fbbf24',        // gold/yellow
  rake: '#a855f7',        // purple
  ridge: '#0f172a',       // black
  hip: '#475569',         // dark gray
  valley: '#3b82f6',      // blue
  gable_end: '#22c55e',
  wall_intersection: '#f97316',  // orange (step flashing)
  unlabeled: '#94a3b8',
}

const EDGE_LABELS: Record<EdgeType, string> = {
  eave: 'EAVE',
  rake: 'RAKE',
  ridge: 'RIDGE',
  hip: 'HIP',
  valley: 'VALLEY',
  gable_end: 'GABLE',
  wall_intersection: 'WALL',
  unlabeled: '?',
}

export function AnnotatedRoofView({ imageUrl, imageWidthPx, imageHeightPx, facets, edges, aggregates }: Props) {
  const [imageDims, setImageDims] = useState({ w: imageWidthPx, h: imageHeightPx })
  const [showLabels, setShowLabels] = useState(true)
  const [showAreas, setShowAreas] = useState(true)
  const [showCompass, setShowCompass] = useState(true)
  const svgRef = useRef<SVGSVGElement | null>(null)

  const onImageLoad = (ev: React.SyntheticEvent<HTMLImageElement>) => {
    const img = ev.currentTarget
    if (img.naturalWidth > 0) setImageDims({ w: img.naturalWidth, h: img.naturalHeight })
  }

  // Crop the view to the traced roof (with padding) so the house FILLS the
  // frame instead of sitting tiny in the middle of a wide tile. Falls back to
  // the full tile when nothing is traced yet.
  const crop = useMemo(() => {
    const pts = facets.flatMap(f => f.polygon)
    if (pts.length < 3) return { viewBox: `0 0 ${imageDims.w} ${imageDims.h}`, u: 1, vx: 0, vy: 0, vw: imageDims.w, vh: imageDims.h }
    let minX = 1, minY = 1, maxX = 0, maxY = 0
    for (const [x, y] of pts) {
      if (x < minX) minX = x; if (x > maxX) maxX = x
      if (y < minY) minY = y; if (y > maxY) maxY = y
    }
    const padX = Math.max((maxX - minX) * 0.18, 0.03)
    const padY = Math.max((maxY - minY) * 0.18, 0.03)
    const x0 = Math.max(0, minX - padX), y0 = Math.max(0, minY - padY)
    const x1 = Math.min(1, maxX + padX), y1 = Math.min(1, maxY + padY)
    // u = fraction of the image width that is visible. Multiply all label/stroke
    // sizes by u so they stay a CONSTANT on-screen size when cropped/zoomed —
    // otherwise fixed pixel sizes blow up + overlap in a tight crop.
    return {
      viewBox: `${x0 * imageDims.w} ${y0 * imageDims.h} ${(x1 - x0) * imageDims.w} ${(y1 - y0) * imageDims.h}`,
      u: Math.max(0.12, x1 - x0),
      vx: x0 * imageDims.w, vy: y0 * imageDims.h,
      vw: (x1 - x0) * imageDims.w, vh: (y1 - y0) * imageDims.h,
    }
  }, [facets, imageDims])
  const cropViewBox = crop.viewBox
  const u = crop.u

  // Index edges by (facet_label, vertex_index_start) for fast lookup while rendering polygons
  const edgesByFacet = useMemo(() => {
    const m = new Map<string, Map<number, LabeledEdge>>()
    for (const e of edges) {
      let inner = m.get(e.facetLabel)
      if (!inner) { inner = new Map(); m.set(e.facetLabel, inner) }
      inner.set(e.vertexIndexStart, e)
    }
    return m
  }, [edges])

  const downloadPng = async () => {
    if (!svgRef.current) return
    const svg = svgRef.current
    const xml = new XMLSerializer().serializeToString(svg)
    const svgBlob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(svgBlob)
    const img = new Image()
    img.crossOrigin = 'anonymous'
    await new Promise((resolve, reject) => {
      img.onload = resolve
      img.onerror = reject
      img.src = url
    }).catch(() => { /* swallow CORS */ })
    const canvas = document.createElement('canvas')
    canvas.width = imageDims.w
    canvas.height = imageDims.h
    const ctx = canvas.getContext('2d')
    if (!ctx) { URL.revokeObjectURL(url); return }
    ctx.drawImage(img, 0, 0, imageDims.w, imageDims.h)
    URL.revokeObjectURL(url)
    canvas.toBlob(blob => {
      if (!blob) return
      const dl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = dl
      a.download = 'axis-roof-annotated.png'
      a.click()
      setTimeout(() => URL.revokeObjectURL(dl), 2000)
    }, 'image/png')
  }

  return (
    <section className="rounded-lg border border-white/10 bg-slate-900/40 p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">Annotated Roof View</h3>
          <p className="text-xs text-slate-400">EagleView-style technical drawing with color-coded edges and measurements.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Toggle label="Labels" value={showLabels} onChange={setShowLabels} />
          <Toggle label="Areas" value={showAreas} onChange={setShowAreas} />
          <Toggle label="Compass" value={showCompass} onChange={setShowCompass} />
          <button onClick={downloadPng} className="rounded bg-blue-600 px-3 py-1.5 text-white hover:bg-blue-500">
            Download PNG
          </button>
        </div>
      </div>

      <div className="relative overflow-hidden rounded-lg border border-white/10 bg-black">
        {/* Hidden loader just to capture the tile's natural dimensions. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={imageUrl} alt="" className="hidden" onLoad={onImageLoad} />
        <svg
          ref={svgRef}
          viewBox={cropViewBox}
          preserveAspectRatio="xMidYMid meet"
          className="block max-h-[560px] w-full"
        >
          {/* Satellite tile inside the SVG so it crops to the roof with the
              overlays. */}
          <image href={imageUrl} x={0} y={0} width={imageDims.w} height={imageDims.h} preserveAspectRatio="none" />
          {/* Facet fills (translucent so satellite shows through) */}
          {facets.map((f, i) => {
            const points = f.polygon.map(([x, y]) => `${x * imageDims.w},${y * imageDims.h}`).join(' ')
            const cx = (f.polygon.reduce((s, p) => s + p[0], 0) / f.polygon.length) * imageDims.w
            const cy = (f.polygon.reduce((s, p) => s + p[1], 0) / f.polygon.length) * imageDims.h
            return (
              <g key={`fill-${f.label}`}>
                <polygon points={points} fill={hueByIndex(i)} fillOpacity={0.18} stroke="none" />
                {showAreas && (
                  <g>
                    <rect
                      x={cx - 46 * u} y={cy - 15 * u}
                      width={92 * u} height={30 * u}
                      fill="rgba(15, 23, 42, 0.82)"
                      stroke="#3b82f6" strokeWidth={1.2 * u}
                      rx={4 * u}
                    />
                    <text
                      x={cx} y={cy - 3 * u}
                      textAnchor="middle" dominantBaseline="middle"
                      fill="white" fontSize={10.5 * u} fontWeight={700}
                    >{f.label}</text>
                    <text
                      x={cx} y={cy + 8 * u}
                      textAnchor="middle" dominantBaseline="middle"
                      fill="#cbd5e1" fontSize={8.5 * u}
                    >{f.pitch}</text>
                  </g>
                )}
              </g>
            )
          })}

          {/* Edges with color coding + labels */}
          {facets.flatMap(f => {
            const inner = edgesByFacet.get(f.label)
            return f.polygon.map((p1, i) => {
              const p2 = f.polygon[(i + 1) % f.polygon.length]
              const e = inner?.get(i)
              const color = e ? EDGE_COLORS[e.edgeType] : EDGE_COLORS.unlabeled
              const x1 = p1[0] * imageDims.w
              const y1 = p1[1] * imageDims.h
              const x2 = p2[0] * imageDims.w
              const y2 = p2[1] * imageDims.h
              const mx = (x1 + x2) / 2
              const my = (y1 + y2) / 2
              const angle = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI
              // Flip so text is always readable (right-side up)
              const textAngle = (angle > 90 || angle < -90) ? angle + 180 : angle
              const label = e ? EDGE_LABELS[e.edgeType] : '?'
              return (
                <g key={`${f.label}-${i}`}>
                  <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={2.4 * u} strokeLinecap="round" />
                  {showLabels && e && e.edgeType !== 'unlabeled' && (
                    <g transform={`translate(${mx}, ${my}) rotate(${textAngle})`}>
                      <rect
                        x={-20 * u} y={-17 * u} width={40 * u} height={13 * u} rx={3 * u}
                        fill="rgba(255,255,255,0.92)"
                        stroke={color} strokeWidth={0.8 * u}
                      />
                      <text
                        x={0} y={-10.5 * u}
                        textAnchor="middle" dominantBaseline="middle"
                        fill={color} fontSize={8 * u} fontWeight={700}
                      >{label}</text>
                    </g>
                  )}
                </g>
              )
            })
          })}

          {/* Compass — anchored to the top-right of the VISIBLE crop, scaled by u */}
          {showCompass && (
            <g transform={`translate(${crop.vx + crop.vw - 46 * u}, ${crop.vy + 46 * u}) scale(${u})`}>
              <circle r={32} fill="rgba(15, 23, 42, 0.85)" stroke="#475569" strokeWidth={2} />
              <text x={0} y={-8} textAnchor="middle" fill="#fbbf24" fontSize={14} fontWeight={700}>N</text>
              <line x1={0} y1={-2} x2={0} y2={24} stroke="#fbbf24" strokeWidth={2.5} />
              <polygon points="0,-14 -6,-2 6,-2" fill="#fbbf24" />
            </g>
          )}
        </svg>
      </div>

      {aggregates && (
        <div className="mt-3 grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
          <Stat label="Roof area" value={aggregates.total_roof_sqft != null ? `${aggregates.total_roof_sqft.toFixed(0)} ft²` : '—'} />
          <Stat label="Squares" value={aggregates.squares != null ? `${aggregates.squares.toFixed(2)}` : '—'} />
          <Stat label="Pitch" value={aggregates.predominant_pitch || '—'} />
          <Stat label="Facets" value={String(facets.length)} />
        </div>
      )}

      {/* Legend */}
      <div className="mt-3 flex flex-wrap gap-3 text-[10px]">
        {(['eave', 'rake', 'ridge', 'hip', 'valley'] as EdgeType[]).map(t => (
          <span key={t} className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-4 rounded" style={{ background: EDGE_COLORS[t] }} />
            <span className="text-slate-400 uppercase">{EDGE_LABELS[t]}</span>
          </span>
        ))}
      </div>
    </section>
  )
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-1 text-slate-300">
      <input type="checkbox" checked={value} onChange={e => onChange(e.target.checked)} className="accent-blue-500" />
      {label}
    </label>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded bg-slate-900/60 p-2">
      <div className="text-[9px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-sm font-semibold text-slate-100">{value}</div>
    </div>
  )
}

function hueByIndex(i: number): string {
  const hues = ['#3b82f6', '#a855f7', '#22c55e', '#f59e0b', '#ec4899', '#06b6d4', '#84cc16']
  return hues[i % hues.length]
}

export default AnnotatedRoofView
