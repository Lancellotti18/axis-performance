'use client'
/**
 * RenderViewer — interactive render image with zoom, pan, and two-click measurement.
 *
 * Scale estimation:
 *   If the blueprint's total_sqft is known we derive an approximate
 *   feet-per-pixel ratio by assuming the full house width occupies ~70% of the
 *   image width and that the footprint is roughly 1.5× wide as it is deep.
 *   Measurements are shown as estimates; a calibration flow lets the user
 *   override with a known real-world distance.
 */

import React, { useRef, useState, useCallback, useEffect } from 'react'

interface Props {
  src: string
  label: string
  totalSqft?: number   // from blueprint analysis — used for scale estimation
}

type Point = { x: number; y: number }

const MIN_ZOOM = 1
const MAX_ZOOM = 8

export default function RenderViewer({ src, label, totalSqft }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const imgRef       = useRef<HTMLImageElement>(null)

  // Zoom / pan
  const [zoom, setZoom]       = useState(1)
  const [pan,  setPan]        = useState<Point>({ x: 0, y: 0 })
  const dragging              = useRef(false)
  const dragStart             = useRef<Point>({ x: 0, y: 0 })
  const panStart              = useRef<Point>({ x: 0, y: 0 })

  // Measure mode
  const [measuring,   setMeasuring]   = useState(false)
  const [pointA,      setPointA]      = useState<Point | null>(null)
  const [pointB,      setPointB]      = useState<Point | null>(null)
  const [imgNatural,  setImgNatural]  = useState<{ w: number; h: number } | null>(null)

  // Calibration
  const [calibrating,    setCalibrating]    = useState(false)
  const [calA,           setCalA]           = useState<Point | null>(null)
  const [calB,           setCalB]           = useState<Point | null>(null)
  const [calInputFt,     setCalInputFt]     = useState('')
  const [feetPerPixel,   setFeetPerPixel]   = useState<number | null>(null)
  const [calConfirmed,   setCalConfirmed]   = useState(false)

  // Attach wheel listener as non-passive so preventDefault() works in Safari
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const handler = (e: WheelEvent) => {
      e.preventDefault()
      const delta = e.deltaY > 0 ? 0.85 : 1.18
      setZoom(z => clampZoom(z * delta))
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [])

  // Derive a rough default scale from sqft when image loads
  useEffect(() => {
    if (!imgNatural || !totalSqft || feetPerPixel) return
    // Assume footprint is 1.5× wide as deep → width ≈ sqrt(sqft * 1.5)
    const estWidthFt  = Math.sqrt(totalSqft * 1.5)
    const housePixels = imgNatural.w * 0.70   // house occupies ~70% of image width
    setFeetPerPixel(estWidthFt / housePixels)
  }, [imgNatural, totalSqft, feetPerPixel])

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Convert a clientX/Y event on the container to image-native pixel coords */
  function clientToImagePx(cx: number, cy: number): Point | null {
    const cont = containerRef.current
    const img  = imgRef.current
    if (!cont || !img || !imgNatural) return null

    const cr   = cont.getBoundingClientRect()
    const ir   = img.getBoundingClientRect()

    // Position within the rendered (zoomed) image element
    const rx = cx - ir.left
    const ry = cy - ir.top

    // Scale back to native image pixels
    const scaleX = imgNatural.w / ir.width
    const scaleY = imgNatural.h / ir.height

    return { x: rx * scaleX, y: ry * scaleY }
  }

  /** Image-native px coords → overlay SVG coords (fraction of container size) */
  function imgPxToOverlay(pt: Point): Point | null {
    const img = imgRef.current
    if (!img || !imgNatural) return null
    const ir = img.getBoundingClientRect()
    const cr = containerRef.current!.getBoundingClientRect()
    return {
      x: (ir.left - cr.left) + (pt.x / imgNatural.w) * ir.width,
      y: (ir.top  - cr.top)  + (pt.y / imgNatural.h) * ir.height,
    }
  }

  function distanceFt(a: Point, b: Point): string {
    const dxPx = b.x - a.x
    const dyPx = b.y - a.y
    const distPx = Math.sqrt(dxPx * dxPx + dyPx * dyPx)
    if (!feetPerPixel) return `${Math.round(distPx)} px`
    const ft = distPx * feetPerPixel
    if (ft < 1) return `${(ft * 12).toFixed(1)} in`
    return `${ft.toFixed(1)} ft`
  }

  // ── Zoom helpers ──────────────────────────────────────────────────────────

  function clampZoom(z: number) {
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))
  }

  function resetView() {
    setZoom(1)
    setPan({ x: 0, y: 0 })
    setPointA(null)
    setPointB(null)
    setCalA(null)
    setCalB(null)
    setMeasuring(false)
    setCalibrating(false)
  }

  // ── Mouse / touch handlers ────────────────────────────────────────────────

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (measuring || calibrating) return   // don't pan while placing points
    dragging.current  = true
    dragStart.current = { x: e.clientX, y: e.clientY }
    panStart.current  = { ...pan }
  }, [pan, measuring, calibrating])

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging.current) return
    const dx = e.clientX - dragStart.current.x
    const dy = e.clientY - dragStart.current.y
    setPan({ x: panStart.current.x + dx, y: panStart.current.y + dy })
  }, [])

  const onMouseUp = useCallback(() => {
    dragging.current = false
  }, [])

  const onClick = useCallback((e: React.MouseEvent) => {
    if (dragging.current) return  // ignore drag-end clicks

    const pt = clientToImagePx(e.clientX, e.clientY)
    if (!pt) return

    if (calibrating) {
      if (!calA) { setCalA(pt); return }
      if (!calB) { setCalB(pt); return }
      return
    }

    if (!measuring) return

    if (!pointA) { setPointA(pt); setPointB(null); return }
    if (!pointB) { setPointB(pt); return }
    // Third click = reset to new measurement
    setPointA(pt)
    setPointB(null)
  }, [measuring, calibrating, pointA, pointB, calA, calB])

  // ── Calibration confirm ───────────────────────────────────────────────────

  function confirmCalibration() {
    if (!calA || !calB || !calInputFt) return
    const dxPx = calB.x - calA.x
    const dyPx = calB.y - calA.y
    const distPx = Math.sqrt(dxPx * dxPx + dyPx * dyPx)
    const ftVal = parseFloat(calInputFt)
    if (!ftVal || distPx === 0) return
    setFeetPerPixel(ftVal / distPx)
    setCalConfirmed(true)
    setCalibrating(false)
    setCalA(null)
    setCalB(null)
    setCalInputFt('')
  }

  // ── Overlay geometry ──────────────────────────────────────────────────────

  const overlayA = pointA ? imgPxToOverlay(pointA) : null
  const overlayB = pointB ? imgPxToOverlay(pointB) : null
  const calOvA   = calA   ? imgPxToOverlay(calA)   : null
  const calOvB   = calB   ? imgPxToOverlay(calB)   : null

  const midLabel: Point | null = (overlayA && overlayB)
    ? { x: (overlayA.x + overlayB.x) / 2, y: (overlayA.y + overlayB.y) / 2 }
    : null

  // ── Cursor style ──────────────────────────────────────────────────────────

  const cursor = measuring || calibrating ? 'crosshair' : dragging.current ? 'grabbing' : 'grab'

  return (
    <div className="flex flex-col gap-0 rounded-xl overflow-hidden" style={{ border: '1px solid rgba(219,234,254,0.8)' }}>

      {/* ── Header bar ── */}
      <div className="px-4 py-2.5 bg-slate-50 border-b flex items-center justify-between gap-2 flex-wrap" style={{ borderColor: 'rgba(219,234,254,0.8)' }}>
        <span className="text-slate-700 text-xs font-bold uppercase tracking-wider">{label}</span>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Zoom controls */}
          <div className="flex items-center gap-1 bg-white rounded-lg border px-1.5 py-0.5" style={{ borderColor: 'rgba(219,234,254,0.9)' }}>
            <button onClick={() => setZoom(z => clampZoom(z / 1.25))} className="text-slate-500 hover:text-slate-800 text-base font-bold w-6 h-6 flex items-center justify-center" title="Zoom out">−</button>
            <span className="text-slate-500 text-xs w-10 text-center select-none">{Math.round(zoom * 100)}%</span>
            <button onClick={() => setZoom(z => clampZoom(z * 1.25))} className="text-slate-500 hover:text-slate-800 text-base font-bold w-6 h-6 flex items-center justify-center" title="Zoom in">+</button>
          </div>

          {/* Measure toggle */}
          <button
            onClick={() => { setMeasuring(m => !m); setCalibrating(false); setPointA(null); setPointB(null) }}
            className={`text-xs font-semibold px-3 py-1.5 rounded-lg transition-all ${measuring ? 'text-white' : 'text-slate-600 bg-white border hover:bg-slate-50'}`}
            style={measuring ? { background: 'linear-gradient(135deg,#6366f1,#4f46e5)', border: 'none' } : { borderColor: 'rgba(219,234,254,0.9)' }}
            title="Click two points to measure distance"
          >
            📐 Measure
          </button>

          {/* Calibrate */}
          <button
            onClick={() => { setCalibrating(c => !c); setMeasuring(false); setCalA(null); setCalB(null) }}
            className={`text-xs font-semibold px-3 py-1.5 rounded-lg transition-all ${calibrating ? 'text-white' : 'text-slate-600 bg-white border hover:bg-slate-50'}`}
            style={calibrating ? { background: 'linear-gradient(135deg,#f59e0b,#d97706)', border: 'none' } : { borderColor: 'rgba(219,234,254,0.9)' }}
            title="Set a known real-world distance to calibrate measurements"
          >
            ⚙ Calibrate
          </button>

          {/* Reset */}
          <button onClick={resetView} className="text-xs font-semibold px-3 py-1.5 rounded-lg text-slate-600 bg-white border hover:bg-slate-50" style={{ borderColor: 'rgba(219,234,254,0.9)' }}>
            Reset
          </button>

          {/* Download */}
          <a href={src} download={`${label.toLowerCase().replace(/\s/g,'_')}_render.png`} className="text-blue-500 hover:text-blue-700 text-xs font-semibold">
            ↓ Download
          </a>
        </div>
      </div>

      {/* ── Status / instruction bar ── */}
      {(measuring || calibrating) && (
        <div className={`px-4 py-2 text-xs font-medium flex items-center gap-2 ${calibrating ? 'bg-amber-50 text-amber-700' : 'bg-indigo-50 text-indigo-700'}`}>
          {calibrating ? (
            <>
              {!calA && '① Click the first calibration point on the image'}
              {calA && !calB && '② Click the second calibration point'}
              {calA && calB && (
                <span className="flex items-center gap-2 flex-wrap">
                  Distance between those points:
                  <input
                    type="number"
                    placeholder="e.g. 20"
                    value={calInputFt}
                    onChange={e => setCalInputFt(e.target.value)}
                    className="w-20 border rounded px-2 py-0.5 text-xs text-slate-800 focus:outline-none focus:border-amber-400"
                    style={{ borderColor: '#fcd34d' }}
                  />
                  <span>feet</span>
                  <button onClick={confirmCalibration} disabled={!calInputFt} className="px-3 py-0.5 rounded bg-amber-500 text-white text-xs font-bold disabled:opacity-40">
                    Confirm
                  </button>
                </span>
              )}
            </>
          ) : (
            <>
              {!pointA && '① Click the first point to start measuring'}
              {pointA && !pointB && '② Click the second point'}
              {pointA && pointB && `Distance: ${distanceFt(pointA, pointB)}${!feetPerPixel ? ' (calibrate for feet)' : ''} — click to start a new measurement`}
            </>
          )}
        </div>
      )}

      {/* ── Scale info bar ── */}
      {!measuring && !calibrating && feetPerPixel && (
        <div className="px-4 py-1.5 bg-slate-50 border-b text-xs text-slate-400 flex items-center gap-1" style={{ borderColor: 'rgba(219,234,254,0.6)' }}>
          {calConfirmed ? '⚙ Custom calibration active' : '~Estimated scale from blueprint sqft'}
          {' '}— scroll to zoom, drag to pan
        </div>
      )}
      {!measuring && !calibrating && !feetPerPixel && (
        <div className="px-4 py-1.5 bg-slate-50 border-b text-xs text-slate-400" style={{ borderColor: 'rgba(219,234,254,0.6)' }}>
          Scroll to zoom · Drag to pan · Use Calibrate for real-world measurements
        </div>
      )}

      {/* ── Image viewport ── */}
      <div
        ref={containerRef}
        className="relative overflow-hidden bg-slate-100 select-none"
        style={{ aspectRatio: '16/9', cursor }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        onClick={onClick}
      >
        <img
          ref={imgRef}
          src={src}
          alt={label}
          draggable={false}
          onLoad={e => {
            const img = e.currentTarget
            setImgNatural({ w: img.naturalWidth, h: img.naturalHeight })
          }}
          style={{
            position:        'absolute',
            top:             '50%',
            left:            '50%',
            transform:       `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px)) scale(${zoom})`,
            transformOrigin: 'center center',
            width:           '100%',
            height:          '100%',
            objectFit:       'cover',
            transition:      dragging.current ? 'none' : 'transform 0.05s ease-out',
            userSelect:      'none',
          }}
        />

        {/* SVG overlay for measurement lines */}
        <svg
          className="absolute inset-0 pointer-events-none"
          width="100%"
          height="100%"
          style={{ overflow: 'visible' }}
        >
          {/* Calibration line */}
          {calOvA && calOvB && (
            <g>
              <line x1={calOvA.x} y1={calOvA.y} x2={calOvB.x} y2={calOvB.y} stroke="#f59e0b" strokeWidth={2} strokeDasharray="6 3" />
              <circle cx={calOvA.x} cy={calOvA.y} r={5} fill="#f59e0b" />
              <circle cx={calOvB.x} cy={calOvB.y} r={5} fill="#f59e0b" />
            </g>
          )}
          {calOvA && !calOvB && <circle cx={calOvA.x} cy={calOvA.y} r={5} fill="#f59e0b" />}

          {/* Measurement line */}
          {overlayA && (
            <circle cx={overlayA.x} cy={overlayA.y} r={6} fill="#6366f1" stroke="white" strokeWidth={2} />
          )}
          {overlayA && overlayB && (
            <g>
              <line x1={overlayA.x} y1={overlayA.y} x2={overlayB.x} y2={overlayB.y} stroke="#6366f1" strokeWidth={2} />
              {/* Tick marks at ends */}
              <line
                x1={overlayA.x} y1={overlayA.y - 6}
                x2={overlayA.x} y2={overlayA.y + 6}
                stroke="#6366f1" strokeWidth={2}
              />
              <line
                x1={overlayB.x} y1={overlayB.y - 6}
                x2={overlayB.x} y2={overlayB.y + 6}
                stroke="#6366f1" strokeWidth={2}
              />
              <circle cx={overlayB.x} cy={overlayB.y} r={6} fill="#6366f1" stroke="white" strokeWidth={2} />
              {/* Distance label */}
              {midLabel && (
                <>
                  <rect
                    x={midLabel.x - 32} y={midLabel.y - 18}
                    width={64} height={22}
                    rx={6} fill="#6366f1" opacity={0.92}
                  />
                  <text
                    x={midLabel.x} y={midLabel.y - 3}
                    textAnchor="middle"
                    fill="white"
                    fontSize={11}
                    fontWeight="700"
                    fontFamily="ui-monospace, monospace"
                  >
                    {distanceFt(pointA!, pointB!)}
                  </text>
                </>
              )}
            </g>
          )}
        </svg>
      </div>
    </div>
  )
}
