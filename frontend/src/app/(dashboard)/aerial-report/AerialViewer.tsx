'use client'
/**
 * AerialViewer — satellite image with zoom, pan, house highlight, and click-to-measure.
 *
 * Scale math:
 *   The backend always generates the satellite image at zoom level 18 via Esri.
 *   At zoom 18, the Web Mercator meters-per-pixel formula is:
 *     mpp = 156543.03392 * cos(lat_rad) / 2^18
 *   The image is 640×420 px. We expose this scale to the user as ft/px so
 *   they can click two points and get an accurate real-world distance.
 *
 * Interactions:
 *   - Scroll wheel (or pinch) → zoom (1×–12×), centered on cursor
 *   - Click + drag → pan
 *   - Measure mode: click point A, click point B → distance line + label
 *   - Reset button → snap back to fit
 */

import React, {
  useRef, useState, useEffect, useCallback, useLayoutEffect,
} from 'react'

const ZOOM_MAP_LEVEL = 18          // must match aerial_roof_service.py
const ESRI_EARTH_CIRCUMFERENCE = 156543.03392   // metres at equator per pixel at zoom 0
const METERS_TO_FEET = 3.28084

interface Props {
  imageUrl:  string
  lat:       number           // property latitude — used to compute scale
  address?:  string
}

type Point = { x: number; y: number }

function metersPerPixel(lat: number) {
  return (ESRI_EARTH_CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, ZOOM_MAP_LEVEL)
}

export default function AerialViewer({ imageUrl, lat, address }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const imgRef       = useRef<HTMLImageElement>(null)
  const svgRef       = useRef<SVGSVGElement>(null)

  // Zoom / pan state
  const [zoom, setZoom]   = useState(1)
  const [pan,  setPan]    = useState<Point>({ x: 0, y: 0 })
  const dragging          = useRef(false)
  const dragStart         = useRef<Point>({ x: 0, y: 0 })
  const panStart          = useRef<Point>({ x: 0, y: 0 })

  // Measure state
  const [measuring,  setMeasuring]  = useState(false)
  const [ptA,        setPtA]        = useState<Point | null>(null)
  const [ptB,        setPtB]        = useState<Point | null>(null)
  const [imgSize,    setImgSize]    = useState<{ w: number; h: number } | null>(null)

  // Feet per pixel at this latitude and zoom level
  const mpp      = metersPerPixel(lat)
  const feetPerPx = mpp * METERS_TO_FEET

  // Read natural image size once loaded
  const handleImgLoad = useCallback(() => {
    const img = imgRef.current
    if (img) setImgSize({ w: img.naturalWidth, h: img.naturalHeight })
  }, [])

  // ── Scroll-to-zoom (imperative, passive:false for Safari) ─────────────────
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect  = el.getBoundingClientRect()
      const mx    = e.clientX - rect.left
      const my    = e.clientY - rect.top
      const delta = e.deltaY < 0 ? 1.12 : 1 / 1.12
      setZoom(z => {
        const next = Math.min(Math.max(z * delta, 1), 12)
        // Adjust pan so the point under the cursor stays fixed
        setPan(p => ({
          x: mx - (mx - p.x) * (next / z),
          y: my - (my - p.y) * (next / z),
        }))
        return next
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // ── Drag to pan ────────────────────────────────────────────────────────────
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (measuring) return   // measure mode handles clicks, not drags
    dragging.current = true
    dragStart.current = { x: e.clientX, y: e.clientY }
    panStart.current  = pan
  }, [pan, measuring])

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging.current) return
    const dx = e.clientX - dragStart.current.x
    const dy = e.clientY - dragStart.current.y
    setPan({ x: panStart.current.x + dx, y: panStart.current.y + dy })
  }, [])

  const onMouseUp = useCallback(() => { dragging.current = false }, [])

  // ── Measure: click handler ─────────────────────────────────────────────────
  const handleMeasureClick = useCallback((e: React.MouseEvent) => {
    if (!measuring) return
    const el   = containerRef.current
    const img  = imgRef.current
    if (!el || !img || !imgSize) return

    const rect = el.getBoundingClientRect()
    // The image is rendered at its natural size and transformed via CSS.
    // We need the click position in image-pixel space.
    const imgRect = img.getBoundingClientRect()
    const px = (e.clientX - imgRect.left) / zoom
    const py = (e.clientY - imgRect.top)  / zoom

    if (!ptA) {
      setPtA({ x: px, y: py })
      setPtB(null)
    } else if (!ptB) {
      setPtB({ x: px, y: py })
    } else {
      // Start a new measurement
      setPtA({ x: px, y: py })
      setPtB(null)
    }
  }, [measuring, ptA, ptB, zoom, imgSize])

  // Reset zoom/pan
  const reset = useCallback(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }, [])

  // Clear measurement
  const clearMeasure = useCallback(() => {
    setPtA(null)
    setPtB(null)
  }, [])

  // Distance in feet between ptA and ptB
  const distanceFt = ptA && ptB
    ? Math.round(Math.sqrt((ptB.x - ptA.x) ** 2 + (ptB.y - ptA.y) ** 2) * feetPerPx)
    : null

  // SVG line midpoint for label
  const mid = ptA && ptB
    ? { x: (ptA.x + ptB.x) / 2, y: (ptA.y + ptB.y) / 2 }
    : null

  const W = imgSize?.w ?? 640
  const H = imgSize?.h ?? 420

  // House is always at the center of the image (backend centers on lat/lng)
  const houseX = W / 2
  const houseY = H / 2

  return (
    <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid rgba(219,234,254,0.8)', background: '#0f172a', boxShadow: '0 2px 12px rgba(59,130,246,0.10)' }}>

      {/* ── Toolbar ── */}
      <div
        className="flex items-center justify-between px-4 py-2.5 border-b"
        style={{ borderColor: 'rgba(255,255,255,0.08)', background: 'rgba(15,23,42,0.95)' }}
      >
        <div className="flex items-center gap-2">
          {/* Zoom controls */}
          <button
            onClick={() => setZoom(z => Math.min(z * 1.3, 12))}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-300 hover:text-white hover:bg-white/10 transition-all text-base font-bold"
            title="Zoom in"
          >+</button>
          <span className="text-slate-400 text-xs tabular-nums w-10 text-center">{Math.round(zoom * 100)}%</span>
          <button
            onClick={() => setZoom(z => Math.max(z / 1.3, 1))}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-300 hover:text-white hover:bg-white/10 transition-all text-base font-bold"
            title="Zoom out"
          >−</button>
          <div className="w-px h-4 bg-white/10 mx-1" />
          <button
            onClick={reset}
            className="px-2.5 py-1 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-all text-xs font-semibold"
          >Reset</button>
        </div>

        <div className="flex items-center gap-2">
          {/* Measure toggle */}
          <button
            onClick={() => {
              setMeasuring(m => !m)
              clearMeasure()
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
            style={{
              background: measuring ? 'rgba(99,102,241,0.25)' : 'rgba(255,255,255,0.08)',
              color:      measuring ? '#a5b4fc' : '#94a3b8',
              border:     measuring ? '1px solid rgba(99,102,241,0.5)' : '1px solid transparent',
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M21 6H3M21 12H3M21 18H3"/>
            </svg>
            {measuring ? 'Measuring…' : 'Measure'}
          </button>

          {measuring && ptA && (
            <button
              onClick={clearMeasure}
              className="px-2 py-1 rounded-lg text-xs text-slate-400 hover:text-white hover:bg-white/10 transition-all"
            >Clear</button>
          )}
        </div>

        <div className="text-slate-500 text-[10px]">
          {measuring
            ? ptA && !ptB ? 'Click a second point' : 'Click a point to measure'
            : 'Scroll to zoom · Drag to pan'}
        </div>
      </div>

      {/* ── Image area ── */}
      <div
        ref={containerRef}
        className="relative overflow-hidden"
        style={{
          height:  560,
          cursor:  measuring ? 'crosshair' : dragging.current ? 'grabbing' : 'grab',
          userSelect: 'none',
        }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        onClick={handleMeasureClick}
      >
        {/* Transformed image + SVG overlay */}
        <div
          style={{
            transform:       `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: '0 0',
            position:        'absolute',
            top: 0, left: 0,
            lineHeight:      0,
          }}
        >
          <img
            ref={imgRef}
            src={imageUrl}
            alt={address ? `Aerial view of ${address}` : 'Aerial satellite view'}
            onLoad={handleImgLoad}
            draggable={false}
            style={{ display: 'block', width: W, height: H }}
          />

          {/* SVG overlay — same size as image */}
          <svg
            ref={svgRef}
            width={W}
            height={H}
            viewBox={`0 0 ${W} ${H}`}
            style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}
          >
            {/* ── House highlight: pulsing ring centered on the property ── */}
            <circle
              cx={houseX} cy={houseY} r={18}
              fill="rgba(99,102,241,0.18)"
              stroke="#6366f1"
              strokeWidth={2}
            />
            {/* Inner dot */}
            <circle cx={houseX} cy={houseY} r={4} fill="#818cf8" />
            {/* Crosshair lines */}
            <line x1={houseX - 30} y1={houseY} x2={houseX - 20} y2={houseY} stroke="#6366f1" strokeWidth={1.5} />
            <line x1={houseX + 20} y1={houseY} x2={houseX + 30} y2={houseY} stroke="#6366f1" strokeWidth={1.5} />
            <line x1={houseX} y1={houseY - 30} x2={houseX} y2={houseY - 20} stroke="#6366f1" strokeWidth={1.5} />
            <line x1={houseX} y1={houseY + 20} x2={houseX} y2={houseY + 30} stroke="#6366f1" strokeWidth={1.5} />

            {/* ── Measurement: point A ── */}
            {ptA && (
              <>
                <circle cx={ptA.x} cy={ptA.y} r={5} fill="#f59e0b" stroke="white" strokeWidth={1.5} />
                <text x={ptA.x + 8} y={ptA.y - 6} fill="white" fontSize={10} fontWeight="600"
                  style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.9))' }}>A</text>
              </>
            )}

            {/* ── Measurement: point B + line + label ── */}
            {ptA && ptB && (
              <>
                {/* Dashed line */}
                <line
                  x1={ptA.x} y1={ptA.y} x2={ptB.x} y2={ptB.y}
                  stroke="#f59e0b" strokeWidth={2} strokeDasharray="6,4"
                />
                {/* Point B dot */}
                <circle cx={ptB.x} cy={ptB.y} r={5} fill="#f59e0b" stroke="white" strokeWidth={1.5} />
                <text x={ptB.x + 8} y={ptB.y - 6} fill="white" fontSize={10} fontWeight="600"
                  style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.9))' }}>B</text>

                {/* Distance label bubble */}
                {mid && distanceFt !== null && (
                  <g>
                    <rect
                      x={mid.x - 32} y={mid.y - 14}
                      width={64} height={20} rx={4}
                      fill="rgba(245,158,11,0.90)"
                    />
                    <text
                      x={mid.x} y={mid.y + 2}
                      textAnchor="middle" fill="white"
                      fontSize={11} fontWeight="700"
                    >
                      {distanceFt >= 5280
                        ? `${(distanceFt / 5280).toFixed(2)} mi`
                        : `${distanceFt} ft`}
                    </text>
                  </g>
                )}
              </>
            )}
          </svg>
        </div>

        {/* Zoom-level badge (bottom-left, outside the transform) */}
        <div
          className="absolute bottom-3 left-3 px-2.5 py-1 rounded-full text-[10px] font-bold text-slate-300"
          style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(6px)', pointerEvents: 'none' }}
        >
          {Math.round(zoom * 100)}% · ~{Math.round(feetPerPx)} ft/px
        </div>

        {/* Measurement result badge (bottom-right) */}
        {distanceFt !== null && (
          <div
            className="absolute bottom-3 right-3 px-3 py-1.5 rounded-xl text-sm font-bold text-white"
            style={{ background: 'rgba(245,158,11,0.90)', backdropFilter: 'blur(6px)', pointerEvents: 'none' }}
          >
            📏 {distanceFt >= 5280 ? `${(distanceFt / 5280).toFixed(2)} mi` : `${distanceFt} ft`}
          </div>
        )}
      </div>

      {/* ── Footer: scale bar ── */}
      <div
        className="flex items-center gap-3 px-4 py-2 border-t"
        style={{ borderColor: 'rgba(255,255,255,0.06)', background: 'rgba(15,23,42,0.95)' }}
      >
        {/* Visual scale bar — 100 ft wide */}
        {(() => {
          const barPx   = Math.round(100 / feetPerPx)  // pixels for 100 ft at current zoom
          const barZoom = Math.min(barPx * zoom, 200)  // clamp so it doesn't overflow
          return (
            <div className="flex items-center gap-2">
              <div className="relative flex items-center" style={{ width: barZoom, height: 10 }}>
                <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-0.5 bg-white/40" />
                <div className="absolute left-0 w-px h-2 bg-white/60" />
                <div className="absolute right-0 w-px h-2 bg-white/60" />
              </div>
              <span className="text-slate-500 text-[10px]">100 ft</span>
            </div>
          )
        })()}
        <div className="flex-1" />
        <span className="text-slate-600 text-[10px]">Esri World Imagery · zoom {ZOOM_MAP_LEVEL}</span>
      </div>
    </div>
  )
}
