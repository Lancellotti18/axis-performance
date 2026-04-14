'use client'
/**
 * AerialViewer — satellite image with zoom, pan, house highlight, and click-to-measure.
 *
 * Scale: Esri World Imagery at zoom 18, 640×420 px image.
 * mpp = 156543.03392 × cos(lat_rad) / 2^18  → metres per native pixel
 */

import React, { useRef, useState, useEffect, useCallback } from 'react'

const IMG_W = 640
const IMG_H = 420
const ZOOM_LEVEL = 18
const ESRI_MPP0 = 156543.03392   // metres/pixel at zoom 0 at equator
const M_TO_FT   = 3.28084
const MIN_ZOOM  = 0.8
const MAX_ZOOM  = 14

interface Props {
  imageUrl: string
  lat:      number
  address?: string
}

type Pt = { x: number; y: number }

function mpp(lat: number) {
  return (ESRI_MPP0 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, ZOOM_LEVEL)
}

export default function AerialViewer({ imageUrl, lat, address }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)   // the fixed-height viewport
  const [zoom,    setZoom]    = useState(1)
  const [pan,     setPan]     = useState<Pt>({ x: 0, y: 0 })
  const [measuring, setMeasuring] = useState(false)
  const [ptA,     setPtA]     = useState<Pt | null>(null)
  const [ptB,     setPtB]     = useState<Pt | null>(null)

  const dragging  = useRef(false)
  const dragStart = useRef<Pt>({ x: 0, y: 0 })
  const panStart  = useRef<Pt>({ x: 0, y: 0 })

  // Center the image in the viewport on first render
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const { width: cW, height: cH } = el.getBoundingClientRect()
    setPan({ x: (cW - IMG_W) / 2, y: (cH - IMG_H) / 2 })
  }, [])

  // Zoom centred on a given viewport point
  const zoomAt = useCallback((factor: number, cx: number, cy: number) => {
    setZoom(z => {
      const next = Math.min(Math.max(z * factor, MIN_ZOOM), MAX_ZOOM)
      setPan(p => ({
        x: cx - (cx - p.x) * (next / z),
        y: cy - (cy - p.y) * (next / z),
      }))
      return next
    })
  }, [])

  // Zoom centred on viewport centre (for toolbar buttons)
  const zoomCenter = useCallback((factor: number) => {
    const el = wrapRef.current
    if (!el) return
    const { width: cW, height: cH } = el.getBoundingClientRect()
    zoomAt(factor, cW / 2, cH / 2)
  }, [zoomAt])

  // Reset to initial centered fit
  const reset = useCallback(() => {
    const el = wrapRef.current
    if (!el) return
    const { width: cW, height: cH } = el.getBoundingClientRect()
    setZoom(1)
    setPan({ x: (cW - IMG_W) / 2, y: (cH - IMG_H) / 2 })
  }, [])

  // Scroll-to-zoom (passive:false for Safari)
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - rect.left, e.clientY - rect.top)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  // Drag-to-pan
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (measuring) return
    dragging.current = true
    dragStart.current = { x: e.clientX, y: e.clientY }
    panStart.current  = pan
  }, [pan, measuring])

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging.current) return
    setPan({
      x: panStart.current.x + (e.clientX - dragStart.current.x),
      y: panStart.current.y + (e.clientY - dragStart.current.y),
    })
  }, [])

  const onMouseUp = useCallback(() => { dragging.current = false }, [])

  // Click-to-measure — converts viewport click → image-pixel coords
  const onClick = useCallback((e: React.MouseEvent) => {
    if (!measuring) return
    const el = wrapRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const imgX = (e.clientX - rect.left - pan.x) / zoom
    const imgY = (e.clientY - rect.top  - pan.y) / zoom

    if (!ptA) {
      setPtA({ x: imgX, y: imgY })
      setPtB(null)
    } else if (!ptB) {
      setPtB({ x: imgX, y: imgY })
    } else {
      setPtA({ x: imgX, y: imgY })
      setPtB(null)
    }
  }, [measuring, ptA, ptB, pan, zoom])

  const clearMeasure = useCallback(() => { setPtA(null); setPtB(null) }, [])
  const toggleMeasure = useCallback(() => {
    setMeasuring(m => !m)
    clearMeasure()
  }, [clearMeasure])

  const feetPerPx = mpp(lat) * M_TO_FT
  const distFt = ptA && ptB
    ? Math.round(Math.sqrt((ptB.x - ptA.x) ** 2 + (ptB.y - ptA.y) ** 2) * feetPerPx)
    : null
  const mid = ptA && ptB
    ? { x: (ptA.x + ptB.x) / 2, y: (ptA.y + ptB.y) / 2 }
    : null

  // House is always at the image center (backend geocodes address → image center)
  const hx = IMG_W / 2
  const hy = IMG_H / 2

  // Scale-bar: show 50 ft in native pixels
  const scaleBarNativePx = Math.round(50 / feetPerPx)
  const scaleBarViewPx   = Math.round(scaleBarNativePx * zoom)

  const fmtDist = (ft: number) =>
    ft >= 5280 ? `${(ft / 5280).toFixed(2)} mi` : `${ft} ft`

  return (
    <div
      className="rounded-2xl overflow-hidden select-none"
      style={{ border: '1px solid rgba(219,234,254,0.8)', background: '#0f172a', boxShadow: '0 4px 20px rgba(59,130,246,0.12)' }}
    >
      {/* ── Toolbar ─────────────────────────────────────────────────── */}
      <div
        className="flex items-center gap-3 px-4 py-2.5"
        style={{ background: 'rgba(15,23,42,0.97)', borderBottom: '1px solid rgba(255,255,255,0.07)' }}
      >
        {/* Zoom buttons */}
        <div className="flex items-center gap-1 bg-white/5 rounded-lg p-0.5">
          <button
            onClick={() => zoomCenter(1.4)}
            className="w-8 h-8 rounded-md flex items-center justify-center text-white font-bold text-lg hover:bg-white/15 transition-all"
            title="Zoom in"
          >+</button>
          <span className="text-slate-400 text-xs tabular-nums px-1 min-w-[42px] text-center">
            {Math.round(zoom * 100)}%
          </span>
          <button
            onClick={() => zoomCenter(1 / 1.4)}
            className="w-8 h-8 rounded-md flex items-center justify-center text-white font-bold text-lg hover:bg-white/15 transition-all"
            title="Zoom out"
          >−</button>
        </div>

        <button
          onClick={reset}
          className="px-3 py-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-all text-xs font-semibold"
        >
          Reset
        </button>

        <div className="w-px h-4 bg-white/10" />

        {/* Measure toggle */}
        <button
          onClick={toggleMeasure}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
          style={{
            background: measuring ? 'rgba(245,158,11,0.2)' : 'rgba(255,255,255,0.07)',
            color:      measuring ? '#fcd34d' : '#94a3b8',
            border:     `1px solid ${measuring ? 'rgba(245,158,11,0.5)' : 'transparent'}`,
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M3 12h18M3 6h18M3 18h18"/>
          </svg>
          {measuring ? 'Measuring' : 'Measure'}
        </button>

        {measuring && (
          <span className="text-slate-500 text-xs">
            {!ptA ? '→ Click point A' : !ptB ? '→ Click point B' : '→ Click to remeasure'}
          </span>
        )}
        {measuring && ptA && (
          <button onClick={clearMeasure} className="text-slate-500 hover:text-slate-300 text-xs transition-all">
            Clear
          </button>
        )}

        <div className="flex-1" />

        <span className="text-slate-600 text-[10px]">Scroll to zoom · Drag to pan</span>
      </div>

      {/* ── Map viewport ─────────────────────────────────────────────── */}
      <div
        ref={wrapRef}
        style={{
          position: 'relative',
          height:   520,
          overflow: 'hidden',
          cursor:   measuring ? 'crosshair' : 'grab',
        }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        onClick={onClick}
      >
        {/* Transformed image layer */}
        <div
          style={{
            position:        'absolute',
            top:             0,
            left:            0,
            transform:       `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: '0 0',
            width:           IMG_W,
            height:          IMG_H,
            lineHeight:      0,
          }}
        >
          <img
            src={imageUrl}
            alt={address ? `Aerial view of ${address}` : 'Aerial view'}
            width={IMG_W}
            height={IMG_H}
            draggable={false}
            style={{ display: 'block', width: IMG_W, height: IMG_H }}
          />

          {/* SVG overlay — same coordinate space as image */}
          <svg
            width={IMG_W}
            height={IMG_H}
            viewBox={`0 0 ${IMG_W} ${IMG_H}`}
            style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none', overflow: 'visible' }}
          >
            {/* ── House highlight ── */}
            {/* Outer glow ring (always visible, especially at zoom-out) */}
            <circle cx={hx} cy={hy} r={28} fill="rgba(99,102,241,0.12)" stroke="rgba(99,102,241,0.35)" strokeWidth={1.5} />
            {/* Mid ring */}
            <circle cx={hx} cy={hy} r={14} fill="rgba(99,102,241,0.18)" stroke="#818cf8" strokeWidth={2} />
            {/* Center dot */}
            <circle cx={hx} cy={hy} r={4}  fill="#c7d2fe" />
            {/* Crosshair ticks */}
            <line x1={hx-44} y1={hy} x2={hx-16} y2={hy} stroke="#818cf8" strokeWidth={1.5} strokeLinecap="round" />
            <line x1={hx+16} y1={hy} x2={hx+44} y2={hy} stroke="#818cf8" strokeWidth={1.5} strokeLinecap="round" />
            <line x1={hx} y1={hy-44} x2={hx} y2={hy-16} stroke="#818cf8" strokeWidth={1.5} strokeLinecap="round" />
            <line x1={hx} y1={hy+16} x2={hx} y2={hy+44} stroke="#818cf8" strokeWidth={1.5} strokeLinecap="round" />

            {/* ── Measure points + line ── */}
            {ptA && (
              <>
                <circle cx={ptA.x} cy={ptA.y} r={6} fill="#f59e0b" stroke="white" strokeWidth={2} />
                <text x={ptA.x + 9} y={ptA.y - 7} fill="white" fontSize={11} fontWeight="700"
                  style={{ filter: 'drop-shadow(0 1px 3px rgba(0,0,0,1))' }}>A</text>
              </>
            )}
            {ptA && ptB && (
              <>
                <line x1={ptA.x} y1={ptA.y} x2={ptB.x} y2={ptB.y}
                  stroke="#f59e0b" strokeWidth={2} strokeDasharray="8,5" />
                <circle cx={ptB.x} cy={ptB.y} r={6} fill="#f59e0b" stroke="white" strokeWidth={2} />
                <text x={ptB.x + 9} y={ptB.y - 7} fill="white" fontSize={11} fontWeight="700"
                  style={{ filter: 'drop-shadow(0 1px 3px rgba(0,0,0,1))' }}>B</text>
                {mid && distFt !== null && (
                  <g>
                    <rect x={mid.x - 36} y={mid.y - 14} width={72} height={22} rx={5}
                      fill="rgba(245,158,11,0.92)" />
                    <text x={mid.x} y={mid.y + 3} textAnchor="middle"
                      fill="white" fontSize={12} fontWeight="800">
                      {fmtDist(distFt)}
                    </text>
                  </g>
                )}
              </>
            )}
          </svg>
        </div>

        {/* ── Fixed HUD overlays (outside transform) ── */}

        {/* Zoom % badge bottom-left */}
        <div
          className="absolute bottom-3 left-3 flex items-center gap-2"
          style={{ pointerEvents: 'none' }}
        >
          <div className="px-2.5 py-1 rounded-full text-[10px] font-bold text-slate-300"
            style={{ background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(6px)' }}>
            {Math.round(zoom * 100)}%
          </div>
          {/* Scale bar */}
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full"
            style={{ background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(6px)' }}>
            <div className="relative flex items-center" style={{ width: Math.min(scaleBarViewPx, 120), height: 10 }}>
              <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-px bg-white/50" />
              <div className="absolute left-0 w-px h-2.5 bg-white/70" />
              <div className="absolute right-0 w-px h-2.5 bg-white/70" />
            </div>
            <span className="text-[10px] text-slate-400 whitespace-nowrap">50 ft</span>
          </div>
        </div>

        {/* Measure result badge bottom-right */}
        {distFt !== null && (
          <div className="absolute bottom-3 right-3 px-3 py-1.5 rounded-xl text-sm font-bold text-white"
            style={{ background: 'rgba(245,158,11,0.93)', backdropFilter: 'blur(6px)', pointerEvents: 'none' }}>
            📏 {fmtDist(distFt)}
          </div>
        )}

        {/* "Property" label badge — top of highlight, fixed to map coords */}
        <div
          className="absolute text-[10px] font-bold text-indigo-300 px-2 py-0.5 rounded-full"
          style={{
            background:  'rgba(99,102,241,0.25)',
            border:      '1px solid rgba(99,102,241,0.4)',
            backdropFilter: 'blur(4px)',
            pointerEvents:  'none',
            // Position: top of the outer ring (r=28) in viewport coords
            left: pan.x + hx * zoom - 30,
            top:  pan.y + (hy - 28) * zoom - 24,
          }}
        >
          Property
        </div>
      </div>

      {/* ── Footer ─────────────────────────────────────────────────── */}
      <div
        className="flex items-center justify-between px-4 py-2"
        style={{ background: 'rgba(15,23,42,0.97)', borderTop: '1px solid rgba(255,255,255,0.06)' }}
      >
        <span className="text-slate-600 text-[10px]">Esri World Imagery · zoom {ZOOM_LEVEL} · ~{feetPerPx.toFixed(1)} ft/pixel</span>
        {address && <span className="text-slate-500 text-[10px] truncate max-w-xs ml-4">{address}</span>}
      </div>
    </div>
  )
}
