'use client'

/**
 * MagnifierLoupe — the close-up used to land a facet corner exactly on a roof
 * edge.
 *
 * The previous loupe was a CSS background-image crop at a FIXED 3.5× of the
 * tile's native size, showing bare imagery. Three things made it hard to use,
 * and this rewrite addresses each:
 *
 *  1. Fixed magnification. Once the contractor zoomed the canvas past ~8×, the
 *     canvas was showing the roof larger than the loupe was — so the loupe
 *     stopped being a magnifier at all. Magnification is now a multiple of the
 *     CURRENT canvas zoom, so it's always meaningfully closer than the canvas.
 *  2. No geometry. Bare pixels can't tell you whether you're about to snap onto
 *     the neighbouring plane's vertex, which is exactly the decision the loupe
 *     exists to support. It now draws the same facets, in-progress trace, and
 *     snap state as the canvas.
 *  3. Parked in the top-right corner, on top of the work. It now moves to
 *     whichever corner the cursor is furthest from.
 *
 * Drawn as SVG over the same source tile, so the browser samples the image's
 * real pixels instead of upscaling a pre-scaled bitmap.
 */
import { useMemo } from 'react'
import type { Facet, Pt } from './RoofFacetEditor'

interface Props {
  imageUrl: string
  /** Natural pixel dimensions of the tile — the SVG coordinate space. */
  imageDims: { w: number; h: number }
  /** Cursor position in image fractions (0..1). */
  hoverPt: Pt
  /** Canvas zoom, so the loupe can stay proportionally closer. */
  viewScale: number
  facets: Facet[]
  /** Vertices of the polygon currently being traced. */
  drawingPoly: Pt[]
  /** True when clicking will magnetize onto an existing vertex. */
  snapped: boolean
  /** Diameter in CSS px. */
  size?: number
}

/** Image pixels across the loupe at canvas zoom 1 — the widest, least-zoomed view. */
const BASE_SPAN_PX = 130
/** Never show fewer than this many image pixels; past it there's no more detail. */
const MIN_SPAN_PX = 18

export default function MagnifierLoupe({
  imageUrl, imageDims, hoverPt, viewScale, facets, drawingPoly, snapped, size = 176,
}: Props) {
  // How much of the tile the loupe covers. Shrinking with canvas zoom keeps the
  // loupe a constant multiple closer than the canvas, at every zoom level.
  const span = Math.max(MIN_SPAN_PX, BASE_SPAN_PX / Math.max(0.2, viewScale))

  const cx = hoverPt[0] * imageDims.w
  const cy = hoverPt[1] * imageDims.h
  const half = span / 2
  const viewBox = `${cx - half} ${cy - half} ${span} ${span}`

  // One image pixel is this many loupe pixels — the unit for hairlines that
  // must stay crisp no matter how far in we are.
  const pxPerImagePx = size / span
  const hair = 1 / pxPerImagePx

  // Sit in the corner furthest from the cursor so the loupe never covers the
  // spot being traced.
  const corner = useMemo(() => {
    const vertical = hoverPt[1] < 0.5 ? 'bottom-3' : 'top-3'
    const horizontal = hoverPt[0] < 0.5 ? 'right-3' : 'left-3'
    return `${vertical} ${horizontal}`
  }, [hoverPt])

  const accent = snapped ? '#22d3ee' : '#fbbf24'

  return (
    <div
      className={`pointer-events-none absolute z-20 overflow-hidden rounded-full shadow-2xl ${corner}`}
      style={{
        width: size,
        height: size,
        border: `2px solid ${snapped ? '#22d3ee' : 'rgba(255,255,255,0.85)'}`,
      }}
    >
      <svg viewBox={viewBox} width={size} height={size} className="block bg-slate-950">
        {/* The tile itself, sampled at the loupe's resolution. Smoothing off
            once we're past 1:1 so roof edges stay as crisp lines. */}
        <image
          href={imageUrl}
          x={0} y={0} width={imageDims.w} height={imageDims.h}
          preserveAspectRatio="none"
          style={{ imageRendering: pxPerImagePx >= 2 ? 'pixelated' : 'auto' }}
        />

        {/* Existing planes — what a corner can snap to. */}
        {facets.map(f => (
          <polygon
            key={f.label}
            points={f.polygon.map(([x, y]) => `${x * imageDims.w},${y * imageDims.h}`).join(' ')}
            fill="rgba(56,189,248,0.10)"
            stroke="rgba(56,189,248,0.85)"
            strokeWidth={hair * 1.5}
            strokeLinejoin="round"
          />
        ))}
        {/* Their vertices, so a shared corner is unmistakable up close. */}
        {facets.flatMap(f => f.polygon.map(([x, y], i) => (
          <circle key={`${f.label}-${i}`} cx={x * imageDims.w} cy={y * imageDims.h}
            r={hair * 3} fill="rgba(56,189,248,0.95)" />
        )))}

        {/* The trace in progress, including the live rubber-band segment. */}
        {drawingPoly.length > 0 && (
          <>
            {drawingPoly.length >= 2 && (
              <polyline
                points={drawingPoly.map(([x, y]) => `${x * imageDims.w},${y * imageDims.h}`).join(' ')}
                fill="none" stroke="#fbbf24" strokeWidth={hair * 2}
                strokeLinecap="round" strokeLinejoin="round"
              />
            )}
            <line
              x1={drawingPoly[drawingPoly.length - 1][0] * imageDims.w}
              y1={drawingPoly[drawingPoly.length - 1][1] * imageDims.h}
              x2={cx} y2={cy}
              stroke={accent} strokeWidth={hair * 1.5}
              strokeDasharray={`${hair * 4} ${hair * 3}`}
            />
            {drawingPoly.map(([x, y], i) => (
              <circle key={i} cx={x * imageDims.w} cy={y * imageDims.h}
                r={hair * (i === 0 ? 4 : 3)} fill={i === 0 ? '#fbbf24' : '#fff'}
                stroke="#fbbf24" strokeWidth={hair} />
            ))}
          </>
        )}

        {/* Crosshair: hairlines with a gap at the centre, so the pixel being
            placed is never hidden by the very thing pointing at it. */}
        <g stroke={accent} strokeWidth={hair} opacity={0.9}>
          <line x1={cx - half} y1={cy} x2={cx - hair * 5} y2={cy} />
          <line x1={cx + hair * 5} y1={cy} x2={cx + half} y2={cy} />
          <line x1={cx} y1={cy - half} x2={cx} y2={cy - hair * 5} />
          <line x1={cx} y1={cy + hair * 5} x2={cx} y2={cy + half} />
        </g>
        <circle cx={cx} cy={cy} r={hair * 3.5} fill="none" stroke={accent} strokeWidth={hair} />
        <circle cx={cx} cy={cy} r={hair * 0.9} fill={accent} />
      </svg>

      {/* Snap state is the loupe's most important readout — it's the difference
          between two planes sharing an edge and merely touching. */}
      <div className="absolute inset-x-0 bottom-1 flex justify-center">
        <span
          className="rounded px-1.5 text-[9px] font-semibold text-white"
          style={{ background: snapped ? 'rgba(8,145,178,0.9)' : 'rgba(0,0,0,0.65)' }}
        >
          {snapped ? 'snap to corner' : `${Math.round(pxPerImagePx * 10) / 10}×`}
        </span>
      </div>
    </div>
  )
}
