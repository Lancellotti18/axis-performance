'use client'
/**
 * AerialViewer — satellite image with zoom, pan, house highlight, and click-to-measure.
 *
 * Scale: Esri World Imagery at zoom 18, 640×420 px image.
 * mpp = 156543.03392 × cos(lat_rad) / 2^18  → metres per native pixel
 */

import React, { useRef, useState, useEffect, useCallback } from 'react'

// The backend now serves 1280×840 images (2× resolution for the same geographic area).
// We display them at 640×420 CSS pixels → retina-quality at all zoom levels.
const IMG_W = 640
const IMG_H = 420
const IMG_NATIVE_W = 1280   // actual pixel dimensions of the fetched image
const IMG_NATIVE_H = 840
const ZOOM_LEVEL = 18
const ESRI_MPP0 = 156543.03392   // metres/pixel at zoom 0 at equator
const M_TO_FT   = 3.28084
const MIN_ZOOM        = 1     // no blank space — can't zoom below natural image size
const MAX_ZOOM        = 14
const HIGHLIGHT_MAX_Z = 1.57  // hide highlight above 157% zoom

export interface DamageZone {
  type:                 'missing_shingles' | 'staining' | 'debris' | 'structural_damage' | 'discoloration' | 'moss_algae'
  severity:             'low' | 'medium' | 'high'
  location_description?: string
  x_pct:  number   // 0–1 fraction of image width
  y_pct:  number   // 0–1 fraction of image height
  w_pct:  number
  h_pct:  number
  description: string
  confidence:  number
}

interface Props {
  imageUrl:     string
  lat:          number | null
  address?:     string
  damageZones?: DamageZone[]   // from aerial damage analysis — overlaid on satellite
  fillHeight?:  boolean        // true = fill parent height instead of fixed 520px
}

type Pt = { x: number; y: number }

function mpp(lat: number) {
  return (ESRI_MPP0 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, ZOOM_LEVEL)
}

const ZONE_COLOR: Record<string, string> = {
  missing_shingles:  'rgba(239,68,68,0.45)',
  staining:          'rgba(245,158,11,0.40)',
  debris:            'rgba(234,179,8,0.40)',
  structural_damage: 'rgba(127,29,29,0.55)',
  discoloration:     'rgba(249,115,22,0.38)',
  moss_algae:        'rgba(34,197,94,0.38)',
}
const ZONE_STROKE: Record<string, string> = {
  missing_shingles:  '#ef4444',
  staining:          '#f59e0b',
  debris:            '#eab308',
  structural_damage: '#7f1d1d',
  discoloration:     '#f97316',
  moss_algae:        '#22c55e',
}

export default function AerialViewer({ imageUrl, lat, address, damageZones, fillHeight }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)   // the fixed-height viewport
  const [zoom,    setZoom]    = useState(1)
  const [pan,     setPan]     = useState<Pt>({ x: 0, y: 0 })
  const [measuring, setMeasuring] = useState(false)
  const [ptA,     setPtA]     = useState<Pt | null>(null)
  const [ptB,     setPtB]     = useState<Pt | null>(null)

  const dragging  = useRef(false)
  const dragStart = useRef<Pt>({ x: 0, y: 0 })
  const panStart  = useRef<Pt>({ x: 0, y: 0 })
  const zoomRef   = useRef(1)   // mirror of zoom state for use inside event-handler closures

  // Clamp pan so the image never exposes the dark background outside its edges
  const clampPan = useCallback((p: Pt, z: number): Pt => {
    const el = wrapRef.current
    if (!el) return p
    const cW = el.clientWidth
    const cH = el.clientHeight
    const sw = IMG_W * z
    const sh = IMG_H * z
    return {
      // if image is wider than viewport: allow panning within bounds; else center it
      x: sw >= cW ? Math.min(0, Math.max(cW - sw, p.x)) : (cW - sw) / 2,
      y: sh >= cH ? Math.min(0, Math.max(cH - sh, p.y)) : (cH - sh) / 2,
    }
  }, [])

  // Center the image once the flex container has a real size.
  // A plain useEffect runs before the browser finishes flex layout, returning
  // width=0/height=0, which would pan the image completely off-screen.
  // ResizeObserver fires after layout, guaranteeing real dimensions.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    let centered = false
    const center = () => {
      if (centered) return
      const { width: cW, height: cH } = el.getBoundingClientRect()
      if (cW <= 0 || cH <= 0) return
      centered = true
      setPan(clampPan({ x: (cW - IMG_W) / 2, y: (cH - IMG_H) / 2 }, 1))
    }
    center()  // try immediately in case element already has size
    const ro = new ResizeObserver(center)
    ro.observe(el)
    return () => ro.disconnect()
  }, [clampPan])

  // Zoom centred on a given viewport point
  const zoomAt = useCallback((factor: number, cx: number, cy: number) => {
    setZoom(z => {
      const next = Math.min(Math.max(z * factor, MIN_ZOOM), MAX_ZOOM)
      zoomRef.current = next
      setPan(p => clampPan({
        x: cx - (cx - p.x) * (next / z),
        y: cy - (cy - p.y) * (next / z),
      }, next))
      return next
    })
  }, [clampPan])

  // Zoom centred on viewport centre (for toolbar buttons)
  const zoomCenter = useCallback((factor: number) => {
    const el = wrapRef.current
    if (!el) return
    const { width: cW, height: cH } = el.getBoundingClientRect()
    zoomAt(factor, cW / 2, cH / 2)
  }, [zoomAt])

  // Reset to 100% centered
  const reset = useCallback(() => {
    const el = wrapRef.current
    if (!el) return
    const { width: cW, height: cH } = el.getBoundingClientRect()
    zoomRef.current = 1
    setZoom(1)
    setPan(clampPan({ x: (cW - IMG_W) / 2, y: (cH - IMG_H) / 2 }, 1))
  }, [clampPan])

  // Scroll-to-zoom (passive:false required for Safari + Firefox)
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

  // Touch pan + pinch-to-zoom (iOS Safari, Android Chrome)
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return

    let touchDragging = false
    let lastTX = 0, lastTY = 0, lastDist = 0

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        touchDragging = true
        lastTX = e.touches[0].clientX
        lastTY = e.touches[0].clientY
      } else if (e.touches.length === 2) {
        touchDragging = false
        const dx = e.touches[0].clientX - e.touches[1].clientX
        const dy = e.touches[0].clientY - e.touches[1].clientY
        lastDist = Math.sqrt(dx * dx + dy * dy)
      }
    }

    const onTouchMove = (e: TouchEvent) => {
      e.preventDefault()
      if (e.touches.length === 1 && touchDragging) {
        const dx = e.touches[0].clientX - lastTX
        const dy = e.touches[0].clientY - lastTY
        setPan(p => clampPan({ x: p.x + dx, y: p.y + dy }, zoomRef.current))
        lastTX = e.touches[0].clientX
        lastTY = e.touches[0].clientY
      } else if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX
        const dy = e.touches[0].clientY - e.touches[1].clientY
        const dist = Math.sqrt(dx * dx + dy * dy)
        if (lastDist > 0) {
          const factor = dist / lastDist
          const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2
          const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2
          const rect = el.getBoundingClientRect()
          zoomAt(factor, midX - rect.left, midY - rect.top)
        }
        lastDist = dist
      }
    }

    const onTouchEnd = () => { touchDragging = false; lastDist = 0 }

    el.addEventListener('touchstart', onTouchStart, { passive: false })
    el.addEventListener('touchmove',  onTouchMove,  { passive: false })
    el.addEventListener('touchend',   onTouchEnd)
    return () => {
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove',  onTouchMove)
      el.removeEventListener('touchend',   onTouchEnd)
    }
  }, [zoomAt, clampPan])

  // Drag-to-pan
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (measuring) return
    dragging.current = true
    dragStart.current = { x: e.clientX, y: e.clientY }
    panStart.current  = pan
  }, [pan, measuring])

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging.current) return
    setPan(clampPan({
      x: panStart.current.x + (e.clientX - dragStart.current.x),
      y: panStart.current.y + (e.clientY - dragStart.current.y),
    }, zoomRef.current))
  }, [clampPan])

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

  const feetPerPx = mpp(lat ?? 39.5) * M_TO_FT  // default to US center if lat unavailable
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

        <span className="text-slate-600 text-[10px] hidden sm:inline">Scroll to zoom · Drag to pan</span>
        <span className="text-slate-600 text-[10px] sm:hidden">Pinch to zoom · Drag to pan</span>
      </div>

      {/* ── Map viewport ─────────────────────────────────────────────── */}
      <div
        ref={wrapRef}
        style={{
          position:    'relative',
          height:      fillHeight ? '100%' : 580,
          overflow:    'hidden',
          cursor:      measuring ? 'crosshair' : 'grab',
          touchAction: 'none',
        }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        onClick={onClick}
      >
        {/* Transformed image layer — translate3d forces GPU compositing, rounded coords eliminate subpixel blur */}
        <div
          style={{
            position:        'absolute',
            top:             0,
            left:            0,
            transform:       `translate3d(${Math.round(pan.x * 2) / 2}px, ${Math.round(pan.y * 2) / 2}px, 0) scale(${zoom})`,
            transformOrigin: '0 0',
            width:           IMG_W,
            height:          IMG_H,
            lineHeight:      0,
            willChange:      'transform',
          }}
        >
          {/* Source is 1280×840 px; displayed at 640×420 → retina-quality downscale */}
          <img
            src={imageUrl}
            alt={address ? `Aerial view of ${address}` : 'Aerial view'}
            width={IMG_NATIVE_W}
            height={IMG_NATIVE_H}
            draggable={false}
            style={{ display: 'block', width: IMG_W, height: IMG_H, imageRendering: 'auto' }}
            onError={e => {
              const img = e.currentTarget
              img.style.opacity = '0.15'
              img.style.filter = 'grayscale(1)'
            }}
          />

          {/* SVG overlay — same coordinate space as image */}
          <svg
            width={IMG_W}
            height={IMG_H}
            viewBox={`0 0 ${IMG_W} ${IMG_H}`}
            style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none', overflow: 'visible' }}
          >
            {/* ── House highlight — visible up to 157% zoom, hidden when zoomed in close ── */}
            {lat !== null && zoom <= HIGHLIGHT_MAX_Z && (
              <>
                {/* Radar-ping animation — expands outward and fades */}
                <circle cx={hx} cy={hy} r={20} fill="none" stroke="#facc15" strokeWidth={2.5} opacity={0}>
                  <animate attributeName="r"       from="20"  to="64"  dur="2.2s" repeatCount="indefinite" />
                  <animate attributeName="opacity" from="0.9" to="0"   dur="2.2s" repeatCount="indefinite" />
                </circle>
                {/* Second offset ping for continuous feel */}
                <circle cx={hx} cy={hy} r={20} fill="none" stroke="#facc15" strokeWidth={2} opacity={0}>
                  <animate attributeName="r"       from="20"  to="64"  dur="2.2s" begin="1.1s" repeatCount="indefinite" />
                  <animate attributeName="opacity" from="0.7" to="0"   dur="2.2s" begin="1.1s" repeatCount="indefinite" />
                </circle>
                {/* White drop-shadow ring behind main ring */}
                <circle cx={hx} cy={hy} r={20} fill="rgba(255,255,255,0.25)" stroke="white" strokeWidth={4} />
                {/* Main vivid ring */}
                <circle cx={hx} cy={hy} r={20} fill="rgba(250,204,21,0.22)" stroke="#facc15" strokeWidth={2.5} />
                {/* Inner dot */}
                <circle cx={hx} cy={hy} r={5} fill="#fde047" stroke="white" strokeWidth={2} />
                {/* Crosshair ticks */}
                <line x1={hx-50} y1={hy} x2={hx-24} y2={hy} stroke="white"   strokeWidth={1.5} strokeLinecap="round" strokeOpacity={0.7} />
                <line x1={hx+24} y1={hy} x2={hx+50} y2={hy} stroke="white"   strokeWidth={1.5} strokeLinecap="round" strokeOpacity={0.7} />
                <line x1={hx} y1={hy-50} x2={hx} y2={hy-24} stroke="white"   strokeWidth={1.5} strokeLinecap="round" strokeOpacity={0.7} />
                <line x1={hx} y1={hy+24} x2={hx} y2={hy+50} stroke="white"   strokeWidth={1.5} strokeLinecap="round" strokeOpacity={0.7} />
                <line x1={hx-50} y1={hy} x2={hx-24} y2={hy} stroke="#facc15" strokeWidth={1}   strokeLinecap="round" strokeOpacity={0.9} />
                <line x1={hx+24} y1={hy} x2={hx+50} y2={hy} stroke="#facc15" strokeWidth={1}   strokeLinecap="round" strokeOpacity={0.9} />
                <line x1={hx} y1={hy-50} x2={hx} y2={hy-24} stroke="#facc15" strokeWidth={1}   strokeLinecap="round" strokeOpacity={0.9} />
                <line x1={hx} y1={hy+24} x2={hx} y2={hy+50} stroke="#facc15" strokeWidth={1}   strokeLinecap="round" strokeOpacity={0.9} />
              </>
            )}

            {/* ── Damage zone overlays (from AI vision analysis) ── */}
            {damageZones && damageZones.map((z, i) => {
              const x = z.x_pct * IMG_W
              const y = z.y_pct * IMG_H
              const w = z.w_pct * IMG_W
              const h = z.h_pct * IMG_H
              const fill   = ZONE_COLOR[z.type]   ?? 'rgba(239,68,68,0.4)'
              const stroke = ZONE_STROKE[z.type]  ?? '#ef4444'
              return (
                <g key={i}>
                  <rect x={x} y={y} width={w} height={h} fill={fill} stroke={stroke}
                    strokeWidth={1.5} strokeDasharray="6,3" rx={3} />
                  {/* Severity badge at top-left of zone */}
                  <rect x={x} y={y - 14} width={w < 50 ? 50 : w} height={14} fill={stroke} opacity={0.9} rx={2} />
                  <text x={x + 4} y={y - 4} fill="white" fontSize={9} fontWeight="700" style={{ textTransform: 'uppercase' }}>
                    {z.type.replace(/_/g, ' ')} · {z.severity}
                  </text>
                </g>
              )
            })}

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
            style={{ background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)' }}>
            {Math.round(zoom * 100)}%
          </div>
          {/* Scale bar */}
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full"
            style={{ background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)' }}>
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
            style={{ background: 'rgba(245,158,11,0.93)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)', pointerEvents: 'none' }}>
            📏 {fmtDist(distFt)}
          </div>
        )}

        {/* "Property" label badge — disappears with the highlight above 157% zoom */}
        {lat !== null && zoom <= HIGHLIGHT_MAX_Z && (
          <div
            className="absolute text-[10px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap"
            style={{
              background:          'rgba(250,204,21,0.22)',
              border:              '1px solid rgba(250,204,21,0.75)',
              color:               '#fde047',
              backdropFilter:      'blur(4px)',
              WebkitBackdropFilter:'blur(4px)',
              pointerEvents:       'none',
              left: pan.x + hx * zoom - 32,
              top:  pan.y + (hy - 20) * zoom - 30,
            }}
          >
            📍 Property
          </div>
        )}
      </div>

      {/* ── Footer ─────────────────────────────────────────────────── */}
      <div
        className="flex items-center justify-between px-4 py-2"
        style={{ background: 'rgba(15,23,42,0.97)', borderTop: '1px solid rgba(255,255,255,0.06)' }}
      >
        <span className="text-slate-600 text-[10px]">Esri World Imagery · 2× resolution{lat !== null ? ` · ~${(feetPerPx / 2).toFixed(2)} ft/px` : ''}</span>
        {address && <span className="text-slate-500 text-[10px] truncate max-w-xs ml-4">{address}</span>}
      </div>
    </div>
  )
}
