'use client'
/**
 * RoofOutlineEditor — EagleView-style editable roof polygon over a satellite tile.
 *
 * Flow: user opens the modal from a roofing panel, we call
 * /roofing/outline to get an AI-traced polygon in 0..1 image fractions,
 * then render it as an SVG with draggable corner handles. Area and
 * perimeter update live as vertices move.
 *
 * Scale: Esri World Imagery at zoom 19.
 *   mpp = 156543.03392 × cos(lat_rad) / 2^19   metres per native pixel
 *   ft_per_px = mpp × 3.28084
 * All coordinates are stored as image-fraction pairs so resizing the
 * preview (or zoom/pan) doesn't change the polygon — only the on-screen
 * projection.
 *
 * Zoom/pan: the image + SVG overlay live inside a single transformed
 * container so the SVG's viewBox stays in image-display pixel space and
 * vertex hit-testing remains exact at any zoom. Pan is in viewport px,
 * zoom is a pure scale factor. Vertex drag converts client → image
 * fraction using the image's live bounding rect, which already includes
 * the transform — so drops always land where the pointer releases.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '@/lib/api'

// Base (unzoomed) display size of the image inside the viewport. These stay
// constant — the responsive layout is achieved by scaling the wrapper to fit.
// NATIVE_W/H + ZOOM must match aerial_roof_service._satellite_url so per-foot
// measurements are correct.
const DISPLAY_W = 1280
const DISPLAY_H = 853
const NATIVE_W = 2048
const NATIVE_H = 1366
const ZOOM = 20
const ESRI_MPP0 = 156543.03392
const M_TO_FT = 3.28084

const MIN_SCALE = 0.3
const MAX_SCALE = 10

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

// ── Polygon simplification (Douglas-Peucker, closed-polygon variant) ──────
// Used to thin out AI-returned vertex chains so the editor doesn't open
// with a wall of clustered dots. Contractors can re-add detail via the
// "+ Detail" button, which inserts midpoints on every edge.

function _perpDist(p: [number, number], a: [number, number], b: [number, number]): number {
  const [x, y] = p, [x1, y1] = a, [x2, y2] = b
  const dx = x2 - x1, dy = y2 - y1
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(x - x1, y - y1)
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lenSq))
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy))
}

function _douglasPeuckerOpen(points: [number, number][], eps: number): [number, number][] {
  if (points.length <= 2) return points.slice()
  let maxDist = 0, maxIdx = 0
  const a = points[0], b = points[points.length - 1]
  for (let i = 1; i < points.length - 1; i++) {
    const d = _perpDist(points[i], a, b)
    if (d > maxDist) { maxDist = d; maxIdx = i }
  }
  if (maxDist > eps) {
    const left = _douglasPeuckerOpen(points.slice(0, maxIdx + 1), eps)
    const right = _douglasPeuckerOpen(points.slice(maxIdx), eps)
    return [...left.slice(0, -1), ...right]
  }
  return [a, b]
}

// Closed polygons need anchoring on two diametrically-opposite points or
// the simplifier can collapse them. Find the two vertices farthest apart,
// split the loop into two arcs, simplify each, then stitch.
function simplifyClosedPolygon(pts: [number, number][], epsilon: number): [number, number][] {
  if (pts.length <= 4) return pts.slice()
  let bestSq = 0, p1 = 0, p2 = 0
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[i][0] - pts[j][0], dy = pts[i][1] - pts[j][1]
      const d = dx * dx + dy * dy
      if (d > bestSq) { bestSq = d; p1 = i; p2 = j }
    }
  }
  const arc1: [number, number][] = []
  const arc2: [number, number][] = []
  for (let i = p1; ; i = (i + 1) % pts.length) {
    arc1.push(pts[i])
    if (i === p2) break
  }
  for (let i = p2; ; i = (i + 1) % pts.length) {
    arc2.push(pts[i])
    if (i === p1) break
  }
  const s1 = _douglasPeuckerOpen(arc1, epsilon)
  const s2 = _douglasPeuckerOpen(arc2, epsilon)
  // Stitch: drop the duplicated endpoints
  return [...s1.slice(0, -1), ...s2.slice(0, -1)]
}

// Iteratively increase epsilon until vertex count is at or below the target.
// Operates in image-fraction space, so epsilon ~0.005 = 0.5% of image side.
function simplifyToCount(pts: [number, number][], targetMax: number): [number, number][] {
  if (pts.length <= targetMax) return pts.slice()
  let eps = 0.004
  for (let iter = 0; iter < 25; iter++) {
    const out = simplifyClosedPolygon(pts, eps)
    if (out.length <= targetMax) return out
    eps *= 1.35
  }
  return simplifyClosedPolygon(pts, eps)
}

// Insert a midpoint between every pair of adjacent vertices — doubles the
// count. Used by the "+ Detail" button for contractors who need extra
// control points on a complex roof line.
function expandWithMidpoints(pts: [number, number][]): [number, number][] {
  if (pts.length < 2) return pts.slice()
  const out: [number, number][] = []
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i]
    const [x2, y2] = pts[(i + 1) % pts.length]
    out.push([x1, y1])
    out.push([(x1 + x2) / 2, (y1 + y2) / 2])
  }
  return out
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

type Pt = { x: number; y: number }

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
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)

  // View transform (presentation-only; polygon storage stays in 0..1)
  const [scale, setScale] = useState(1)
  const [pan, setPan] = useState<Pt>({ x: 0, y: 0 })

  const viewportRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const draggingVertex = useRef<number | null>(null)
  const panning = useRef(false)
  const panStart = useRef<Pt>({ x: 0, y: 0 })
  const panOrigin = useRef<Pt>({ x: 0, y: 0 })
  const scaleRef = useRef(1)
  scaleRef.current = scale

  // Reset state when the modal reopens with a fresh polygon.
  useEffect(() => {
    if (!open) return
    setPolygon(initialPolygon || [])
    setConfidence(initialConfidence ?? 0)
    setNotes(initialNotes || '')
    setWarnings(initialWarnings || [])
    setError(null)
    setSelectedIdx(null)
    setHoverIdx(null)
  }, [open, initialPolygon, initialConfidence, initialNotes, initialWarnings])

  const fpp = lat != null ? ftPerPx(lat) : null

  const stats = useMemo(() => {
    const areaFrac = shoelaceFrac(polygon)
    if (!fpp) return { sqft: null as number | null, perimeter: null as number | null }
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

  // ── Fit-to-viewport centering. Runs when the viewport sizes or the modal opens.
  const fitToViewport = useCallback(() => {
    const el = viewportRef.current
    if (!el) return
    const { width: cW, height: cH } = el.getBoundingClientRect()
    if (cW <= 0 || cH <= 0) return
    const fit = Math.min(cW / DISPLAY_W, cH / DISPLAY_H)
    scaleRef.current = fit
    setScale(fit)
    setPan({
      x: (cW - DISPLAY_W * fit) / 2,
      y: (cH - DISPLAY_H * fit) / 2,
    })
  }, [])

  // ── Fit-to-polygon: zoom in on the building's bounding box with padding so
  // the roof fills the viewport instead of being a tiny shape inside the
  // full satellite tile. Vertices spread out and stop clustering as a result.
  // Falls back to fitToViewport when there's no polygon yet.
  const fitToPolygon = useCallback((pts: [number, number][]) => {
    const el = viewportRef.current
    if (!el || pts.length < 3) {
      fitToViewport()
      return
    }
    const { width: cW, height: cH } = el.getBoundingClientRect()
    if (cW <= 0 || cH <= 0) return

    // Bounding box in image-fraction coords [0..1]
    let minX = 1, minY = 1, maxX = 0, maxY = 0
    for (const [x, y] of pts) {
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
    // Convert to display-pixel space
    const bbW = (maxX - minX) * DISPLAY_W
    const bbH = (maxY - minY) * DISPLAY_H
    const cx = ((minX + maxX) / 2) * DISPLAY_W
    const cy = ((minY + maxY) / 2) * DISPLAY_H

    // 25% padding so the building isn't pressed against the edges (gives
    // contractors room to drag corner vertices outside the current shape).
    const PAD = 1.25
    const fit = Math.min(cW / (bbW * PAD), cH / (bbH * PAD))
    const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, fit))

    scaleRef.current = next
    setScale(next)
    setPan({
      x: cW / 2 - cx * next,
      y: cH / 2 - cy * next,
    })
  }, [fitToViewport])

  useEffect(() => {
    if (!open) return
    const el = viewportRef.current
    if (!el) return
    // Initial render: zoom to polygon if we already have one, else show the
    // whole tile so the user can manually trace.
    if (polygon.length >= 3) fitToPolygon(polygon)
    else fitToViewport()
    const ro = new ResizeObserver(() => {
      // Re-fit on resize: keep using whichever mode is current.
      if (polygon.length >= 3) fitToPolygon(polygon)
      else fitToViewport()
    })
    ro.observe(el)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, fitToViewport, fitToPolygon])

  // When auto-detect (or re-detect) returns a polygon, zoom to it.
  // Tracks length-going-from-zero so dragging a single vertex doesn't re-zoom.
  const polygonHadVertices = useRef(false)
  useEffect(() => {
    if (!open) return
    const hasNow = polygon.length >= 3
    if (hasNow && !polygonHadVertices.current) {
      fitToPolygon(polygon)
    }
    polygonHadVertices.current = hasNow
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, polygon.length])

  // ── Zoom centred on a viewport point ──────────────────────────────────
  const zoomAt = useCallback((factor: number, cx: number, cy: number) => {
    setScale(z => {
      const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, z * factor))
      scaleRef.current = next
      setPan(p => ({
        x: cx - (cx - p.x) * (next / z),
        y: cy - (cy - p.y) * (next / z),
      }))
      return next
    })
  }, [])

  const zoomCenter = useCallback((factor: number) => {
    const el = viewportRef.current
    if (!el) return
    const { width: cW, height: cH } = el.getBoundingClientRect()
    zoomAt(factor, cW / 2, cH / 2)
  }, [zoomAt])

  // ── Wheel-to-zoom ────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return
    const el = viewportRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - rect.left, e.clientY - rect.top)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [open, zoomAt])

  // ── Touch: one-finger pan, two-finger pinch ─────────────────────────
  useEffect(() => {
    if (!open) return
    const el = viewportRef.current
    if (!el) return

    let touchPanning = false
    let lastTX = 0, lastTY = 0, lastDist = 0

    const onTouchStart = (e: TouchEvent) => {
      // Never start a pan on the vertex handles — let the SVG's pointerdown grab it.
      const target = e.target as Element
      if (target && target.closest('[data-vertex="1"]')) return
      if (e.touches.length === 1) {
        touchPanning = true
        lastTX = e.touches[0].clientX
        lastTY = e.touches[0].clientY
      } else if (e.touches.length === 2) {
        touchPanning = false
        const dx = e.touches[0].clientX - e.touches[1].clientX
        const dy = e.touches[0].clientY - e.touches[1].clientY
        lastDist = Math.sqrt(dx * dx + dy * dy)
      }
    }

    const onTouchMove = (e: TouchEvent) => {
      if (draggingVertex.current != null) return
      e.preventDefault()
      if (e.touches.length === 1 && touchPanning) {
        const dx = e.touches[0].clientX - lastTX
        const dy = e.touches[0].clientY - lastTY
        setPan(p => ({ x: p.x + dx, y: p.y + dy }))
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

    const onTouchEnd = () => { touchPanning = false; lastDist = 0 }

    el.addEventListener('touchstart', onTouchStart, { passive: false })
    el.addEventListener('touchmove', onTouchMove, { passive: false })
    el.addEventListener('touchend', onTouchEnd)
    return () => {
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
    }
  }, [open, zoomAt])

  // ── Pan via mouse drag on empty space ───────────────────────────────
  const onViewportMouseDown = (e: React.MouseEvent) => {
    if (draggingVertex.current != null) return
    // If the click landed on a vertex or edge, let those handlers take it.
    const t = e.target as Element
    if (t && (t.closest('[data-vertex="1"]') || t.closest('[data-edge="1"]'))) return
    panning.current = true
    panStart.current = { x: e.clientX, y: e.clientY }
    panOrigin.current = pan
    setSelectedIdx(null)
  }

  const onViewportMouseMove = (e: React.MouseEvent) => {
    if (!panning.current) return
    setPan({
      x: panOrigin.current.x + (e.clientX - panStart.current.x),
      y: panOrigin.current.y + (e.clientY - panStart.current.y),
    })
  }

  const onViewportMouseUp = () => { panning.current = false }

  // ── Vertex drag: uses the live image bounding rect so the drop lands where
  //    the pointer is, regardless of the current scale/pan transform. ─────
  const fromClient = useCallback((clientX: number, clientY: number): [number, number] => {
    const svg = svgRef.current
    if (!svg) return [0, 0]
    const rect = svg.getBoundingClientRect()
    // rect already reflects the transform (scale + pan). Map to 0..1.
    const x = (clientX - rect.left) / rect.width
    const y = (clientY - rect.top) / rect.height
    return [Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y))]
  }, [])

  const onVertexDown = (idx: number) => (e: React.PointerEvent) => {
    e.stopPropagation()
    e.preventDefault()
    draggingVertex.current = idx
    setSelectedIdx(idx)
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
  }

  const onSvgPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (draggingVertex.current == null) return
    const pt = fromClient(e.clientX, e.clientY)
    setPolygon(prev => {
      const next = [...prev]
      next[draggingVertex.current as number] = pt
      return next
    })
  }

  const onSvgPointerUp = () => { draggingVertex.current = null }

  // Click on an edge hit-target inserts a new vertex at the midpoint.
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
      setSelectedIdx(idx + 1)
      return next
    })
  }

  const removeSelected = useCallback(() => {
    if (selectedIdx == null) return
    if (polygon.length <= 3) return
    setPolygon(prev => prev.filter((_, i) => i !== selectedIdx))
    setSelectedIdx(null)
  }, [selectedIdx, polygon.length])

  // Delete / Backspace removes the selected vertex.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (selectedIdx != null) setSelectedIdx(null)
        else onClose()
        return
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIdx != null) {
        const target = e.target as HTMLElement
        // Don't swallow Backspace when typing in any future input.
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
        e.preventDefault()
        removeSelected()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, selectedIdx, removeSelected, onClose])

  const redetect = async () => {
    setDetecting(true)
    setError(null)
    try {
      const res = await api.roofing.detectOutline(imageUrl, lat, {
        imageWidthPx: NATIVE_W,
        imageHeightPx: NATIVE_H,
        zoom: ZOOM,
      })
      const aiPolygon = (res.polygon || []) as [number, number][]
      // Auto-thin: AI often returns 8-12 vertices on a simple rectangle and
      // contractors find the dot density distracting. Cut to ~half (with a
      // 4-vertex floor) — they can hit "+ Detail" to add corners back.
      const targetCount = aiPolygon.length > 6
        ? Math.max(4, Math.ceil(aiPolygon.length / 2))
        : aiPolygon.length
      const thinned = aiPolygon.length > 6
        ? simplifyToCount(aiPolygon, targetCount)
        : aiPolygon
      setPolygon(thinned)
      setConfidence(res.confidence || 0)
      setNotes(res.notes || '')
      setWarnings(res.warnings || [])
      setSelectedIdx(null)
    } catch (e) {
      setError((e as Error).message || 'Outline detection failed')
    }
    setDetecting(false)
  }

  // Side-toolbar handlers for vertex density. Operate on the current
  // polygon (preserves manual edits — does NOT re-fetch from AI).
  const addDetail = useCallback(() => {
    setPolygon(prev => {
      if (prev.length === 0) return prev
      // Cap at 24 vertices — beyond that the editor gets unusably busy
      if (prev.length >= 24) return prev
      return expandWithMidpoints(prev)
    })
    setSelectedIdx(null)
  }, [])

  const reduceDetail = useCallback(() => {
    setPolygon(prev => {
      // Floor at 4 vertices — minimum for a polygon
      if (prev.length <= 4) return prev
      const target = Math.max(4, Math.ceil(prev.length / 2))
      return simplifyToCount(prev, target)
    })
    setSelectedIdx(null)
  }, [])

  // Auto-detect on first open if we don't already have an outline.
  useEffect(() => {
    if (!open) return
    if (polygon.length > 0) return
    if (!imageUrl) return
    redetect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, imageUrl])

  if (!open) return null

  // Project image-fraction polygon into the SVG's coordinate space
  // (which is DISPLAY_W × DISPLAY_H — the *unzoomed* base pixels).
  const toDisplay = (pt: [number, number]): [number, number] => [
    pt[0] * DISPLAY_W,
    pt[1] * DISPLAY_H,
  ]
  const path =
    polygon.length >= 2
      ? polygon
          .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0] * DISPLAY_W} ${p[1] * DISPLAY_H}`)
          .join(' ') + ' Z'
      : ''

  // Counteract the container scale so vertex handles, labels and stroke widths
  // don't pixelate or balloon when zoomed in.
  const invS = 1 / scale

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
      onMouseUp={onViewportMouseUp}
      onMouseLeave={onViewportMouseUp}
      style={{ padding: 'clamp(0px, 2vw, 16px)' }}
    >
      <div
        className="bg-white shadow-2xl flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(98vw, 1400px)',
          height: 'min(96vh, 900px)',
          borderRadius: 'clamp(0px, 1.2vw, 18px)',
        }}
      >
        {/* ── Header ───────────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 flex-shrink-0">
          <div>
            <h3 className="text-base font-bold text-slate-900">Edit roof outline</h3>
            <p className="text-xs text-slate-500 hidden sm:block">
              Drag corners to adjust · Click an edge to add a point · Click a corner then press Delete to remove
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700 text-2xl leading-none w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-100"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* ── Body: viewport + sidebar ─────────────────────────────── */}
        <div className="flex-1 flex flex-col md:flex-row min-h-0">
          {/* ── Viewport ───────────────────────────────────────────── */}
          <div
            ref={viewportRef}
            className="relative flex-1 bg-slate-900 overflow-hidden select-none"
            style={{
              cursor: panning.current ? 'grabbing' : 'grab',
              touchAction: 'none',
              minHeight: 0,
            }}
            onMouseDown={onViewportMouseDown}
            onMouseMove={onViewportMouseMove}
          >
            {/* Transformed stage: image + SVG overlay share one transform */}
            <div
              ref={stageRef}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: DISPLAY_W,
                height: DISPLAY_H,
                transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${scale})`,
                transformOrigin: '0 0',
                willChange: 'transform',
                lineHeight: 0,
              }}
            >
              <img
                src={imageUrl}
                alt="Satellite"
                width={DISPLAY_W}
                height={DISPLAY_H}
                draggable={false}
                style={{
                  display: 'block',
                  width: DISPLAY_W,
                  height: DISPLAY_H,
                  userSelect: 'none',
                  // Prefer crisp pixel boundaries when the parent transform
                  // upscales past 100%. WebKit/Chromium keyword that picks
                  // a sharper interpolator than the default bilinear blur.
                  imageRendering: '-webkit-optimize-contrast',
                }}
              />

              {/* Render the SVG at 2x intrinsic resolution then display it
                  at base size — same trick as a retina image. When the
                  parent transform zooms in, browsers have more native
                  vector pixels to work with so polygon strokes and edge
                  labels stay sharp instead of pixelated. */}
              <svg
                ref={svgRef}
                width={DISPLAY_W * 2}
                height={DISPLAY_H * 2}
                viewBox={`0 0 ${DISPLAY_W} ${DISPLAY_H}`}
                shapeRendering="geometricPrecision"
                textRendering="geometricPrecision"
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: DISPLAY_W,
                  height: DISPLAY_H,
                  touchAction: 'none',
                  overflow: 'visible',
                }}
                onPointerMove={onSvgPointerMove}
                onPointerUp={onSvgPointerUp}
                onPointerLeave={onSvgPointerUp}
              >
                <defs>
                  {/* Mask dims everywhere EXCEPT inside the polygon */}
                  <mask id="roof-mask">
                    <rect x={0} y={0} width={DISPLAY_W} height={DISPLAY_H} fill="white" />
                    {path && <path d={path} fill="black" />}
                  </mask>
                  {/* Soft glow filter for the polygon stroke */}
                  <filter id="roof-glow" x="-20%" y="-20%" width="140%" height="140%">
                    <feGaussianBlur stdDeviation="3" result="b" />
                    <feMerge>
                      <feMergeNode in="b" />
                      <feMergeNode in="SourceGraphic" />
                    </feMerge>
                  </filter>
                  <filter id="vertex-shadow" x="-50%" y="-50%" width="200%" height="200%">
                    <feGaussianBlur in="SourceAlpha" stdDeviation="1.5" />
                    <feOffset dx="0" dy="1" />
                    <feComponentTransfer>
                      <feFuncA type="linear" slope="0.5" />
                    </feComponentTransfer>
                    <feMerge>
                      <feMergeNode />
                      <feMergeNode in="SourceGraphic" />
                    </feMerge>
                  </filter>
                </defs>

                {/* Dim overlay outside polygon */}
                {path && (
                  <rect
                    x={0}
                    y={0}
                    width={DISPLAY_W}
                    height={DISPLAY_H}
                    fill="rgba(0,0,0,0.5)"
                    mask="url(#roof-mask)"
                    pointerEvents="none"
                  />
                )}

                {/* Polygon fill + stroke (stroke width is scale-inverted so it stays crisp) */}
                {path && (
                  <>
                    <path
                      d={path}
                      fill="rgba(59, 130, 246, 0.15)"
                      stroke="#2563eb"
                      strokeWidth={2.5 * invS}
                      strokeLinejoin="round"
                      filter="url(#roof-glow)"
                      pointerEvents="none"
                    />
                  </>
                )}

                {/* Wide invisible edge hit-targets for midpoint insertion */}
                {polygon.map((_, i) => {
                  const [x1, y1] = toDisplay(polygon[i])
                  const [x2, y2] = toDisplay(polygon[(i + 1) % polygon.length])
                  return (
                    <line
                      key={`hit-${i}`}
                      data-edge="1"
                      x1={x1}
                      y1={y1}
                      x2={x2}
                      y2={y2}
                      stroke="transparent"
                      strokeWidth={Math.max(16, 16 * invS)}
                      strokeLinecap="round"
                      style={{ cursor: 'copy' }}
                      onClick={onEdgeClick(i)}
                    />
                  )
                })}

                {/* Edge length labels */}
                {polygon.map((_, i) => {
                  const [x1, y1] = toDisplay(polygon[i])
                  const [x2, y2] = toDisplay(polygon[(i + 1) % polygon.length])
                  const mx = (x1 + x2) / 2
                  const my = (y1 + y2) / 2
                  const len = edgeLengths[i]
                  if (len == null || len <= 0) return null
                  return (
                    <g key={`label-${i}`} pointerEvents="none" transform={`translate(${mx} ${my})`}>
                      <g transform={`scale(${invS})`}>
                        <rect
                          x={-26}
                          y={-10}
                          width={52}
                          height={20}
                          rx={5}
                          fill="rgba(15,23,42,0.92)"
                          stroke="rgba(255,255,255,0.25)"
                          strokeWidth={1}
                        />
                        <text
                          x={0}
                          y={4}
                          textAnchor="middle"
                          fill="#ffffff"
                          fontSize={12}
                          fontWeight={700}
                          style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}
                        >
                          {len} ft
                        </text>
                      </g>
                    </g>
                  )
                })}

                {/* Vertex handles */}
                {polygon.map((p, i) => {
                  const [x, y] = toDisplay(p)
                  const active = selectedIdx === i
                  const hover = hoverIdx === i
                  const big = active || hover
                  // Slightly smaller dots so adjacent vertices on a tight roof
                  // don't visually merge into a blob.
                  const rOuter = (big ? 9 : 7) * invS
                  const rInner = (big ? 4 : 3) * invS
                  return (
                    <g key={`v-${i}`} transform={`translate(${x} ${y})`}>
                      {/* Invisible hit target — generous on small displays
                          but doesn't balloon when zoomed out (which used to
                          cause overlapping hit zones on dense polygons). */}
                      <circle
                        data-vertex="1"
                        r={Math.max(12, 14 * invS)}
                        fill="rgba(0,0,0,0)"
                        style={{ cursor: 'grab' }}
                        onPointerDown={onVertexDown(i)}
                        onMouseEnter={() => setHoverIdx(i)}
                        onMouseLeave={() => setHoverIdx(prev => (prev === i ? null : prev))}
                      />
                      {/* Outer ring */}
                      <circle
                        r={rOuter}
                        fill="white"
                        stroke={active ? '#1d4ed8' : '#2563eb'}
                        strokeWidth={(active ? 2.5 : 2) * invS}
                        filter="url(#vertex-shadow)"
                        pointerEvents="none"
                      />
                      {/* Inner dot */}
                      <circle
                        r={rInner}
                        fill={active ? '#1d4ed8' : '#2563eb'}
                        pointerEvents="none"
                      />
                      {/* Selected: outer halo ring */}
                      {active && (
                        <circle
                          r={(rOuter + 4 * invS)}
                          fill="none"
                          stroke="#1d4ed8"
                          strokeWidth={1.5 * invS}
                          strokeOpacity={0.5}
                          pointerEvents="none"
                        />
                      )}
                    </g>
                  )
                })}
              </svg>
            </div>

            {/* ── Toolbar (fixed, outside transform) ─────────────── */}
            <div
              className="absolute top-3 left-3 flex items-center gap-1 rounded-lg p-1"
              style={{
                background: 'rgba(15,23,42,0.92)',
                backdropFilter: 'blur(8px)',
                WebkitBackdropFilter: 'blur(8px)',
                border: '1px solid rgba(255,255,255,0.1)',
              }}
              onMouseDown={e => e.stopPropagation()}
            >
              <button
                onClick={() => zoomCenter(1.4)}
                className="w-8 h-8 rounded-md flex items-center justify-center text-white font-bold text-lg hover:bg-white/15 transition-all"
                title="Zoom in"
              >+</button>
              <span className="text-slate-300 text-xs tabular-nums px-1 min-w-[44px] text-center font-semibold">
                {Math.round(scale * 100)}%
              </span>
              <button
                onClick={() => zoomCenter(1 / 1.4)}
                className="w-8 h-8 rounded-md flex items-center justify-center text-white font-bold text-lg hover:bg-white/15 transition-all"
                title="Zoom out"
              >−</button>
              <div className="w-px h-5 bg-white/15 mx-1" />
              <button
                onClick={() => fitToPolygon(polygon)}
                disabled={polygon.length < 3}
                className="px-2.5 h-8 rounded-md text-slate-200 hover:text-white hover:bg-white/15 transition-all text-xs font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
                title="Fit roof to viewport"
              >
                Fit roof
              </button>
              <button
                onClick={fitToViewport}
                className="px-2.5 h-8 rounded-md text-slate-200 hover:text-white hover:bg-white/15 transition-all text-xs font-semibold"
                title="Reset view to full tile"
              >
                Reset
              </button>
            </div>

            {/* Hint strip */}
            <div
              className="absolute bottom-3 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full text-[11px] text-slate-200 whitespace-nowrap max-w-[90%] overflow-hidden text-ellipsis"
              style={{
                background: 'rgba(15,23,42,0.88)',
                backdropFilter: 'blur(6px)',
                WebkitBackdropFilter: 'blur(6px)',
                border: '1px solid rgba(255,255,255,0.08)',
                pointerEvents: 'none',
              }}
            >
              <span className="hidden sm:inline">Drag corners to adjust · Click an edge to add a point · Select a corner + Delete to remove · Scroll/pinch to zoom</span>
              <span className="sm:hidden">Drag corners · Tap edge to add · Pinch to zoom</span>
            </div>

            {/* Side panel: vertex density controls */}
            {polygon.length > 0 && (
              <div
                className="absolute top-3 right-3 flex flex-col items-stretch gap-2 rounded-lg p-2"
                style={{
                  background: 'rgba(15,23,42,0.92)',
                  backdropFilter: 'blur(8px)',
                  WebkitBackdropFilter: 'blur(8px)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  minWidth: 88,
                }}
                onMouseDown={e => e.stopPropagation()}
              >
                <div className="text-[10px] font-bold text-slate-300 uppercase tracking-wider text-center pt-0.5">
                  Corners
                </div>
                <div className="text-white text-2xl font-bold text-center tabular-nums leading-none py-0.5">
                  {polygon.length}
                </div>
                <div className="w-full h-px bg-white/10 my-0.5" />
                <button
                  onClick={addDetail}
                  disabled={polygon.length >= 24}
                  className="px-2 h-8 rounded-md flex items-center justify-center gap-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-semibold transition-all"
                  title="Add a corner between every existing pair"
                >
                  <span className="text-base leading-none">+</span>
                  <span>Detail</span>
                </button>
                <button
                  onClick={reduceDetail}
                  disabled={polygon.length <= 4}
                  className="px-2 h-8 rounded-md flex items-center justify-center gap-1.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-semibold transition-all"
                  title="Cut roughly half the corners while keeping the shape"
                >
                  <span className="text-base leading-none">−</span>
                  <span>Detail</span>
                </button>
              </div>
            )}

            {/* Empty / loading states */}
            {detecting && (
              <div className="absolute inset-0 flex items-center justify-center bg-slate-900/70 text-blue-200 text-sm font-semibold pointer-events-none">
                <svg className="animate-spin w-5 h-5 mr-2" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                </svg>
                Tracing roof outline…
              </div>
            )}
            {!detecting && polygon.length === 0 && !error && (
              <div className="absolute inset-0 flex items-center justify-center text-slate-300 text-xs pointer-events-none">
                No outline detected yet — tap &ldquo;Re-detect&rdquo;.
              </div>
            )}
          </div>

          {/* ── Sidebar ──────────────────────────────────────────── */}
          <div
            className="md:w-[300px] md:border-l border-t md:border-t-0 border-slate-200 bg-slate-50 flex flex-col gap-3 p-4 flex-shrink-0 overflow-y-auto"
            style={{ maxHeight: '100%' }}
          >
            <div className="grid grid-cols-2 gap-2">
              <div className="bg-white rounded-lg p-2.5 border border-slate-200">
                <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Roof area</div>
                <div className="text-2xl font-black text-slate-900 tabular-nums leading-none mt-1">
                  {stats.sqft != null ? stats.sqft.toLocaleString() : '—'}
                </div>
                <div className="text-[10px] text-slate-500 mt-0.5">sqft</div>
              </div>
              <div className="bg-white rounded-lg p-2.5 border border-slate-200">
                <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Perimeter</div>
                <div className="text-2xl font-black text-slate-900 tabular-nums leading-none mt-1">
                  {stats.perimeter != null ? stats.perimeter.toLocaleString() : '—'}
                </div>
                <div className="text-[10px] text-slate-500 mt-0.5">ft</div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <div className="text-slate-500">
                Corners: <span className="font-semibold text-slate-700 tabular-nums">{polygon.length}</span>
              </div>
              {confidence > 0 && (
                <div className="text-slate-500">
                  AI: <span className="font-semibold text-slate-700">{Math.round(confidence * 100)}%</span>
                </div>
              )}
            </div>

            {notes && (
              <div className="text-[11px] text-slate-600 bg-white rounded-lg p-2 border border-slate-200 leading-relaxed">
                {notes}
              </div>
            )}

            {warnings.length > 0 && (
              <div className="text-[11px] text-amber-700 bg-amber-50 rounded-lg p-2 border border-amber-200 leading-relaxed space-y-1">
                {warnings.map((w, i) => (
                  <div key={i}>{w}</div>
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
                className="px-3 py-2.5 rounded-lg text-sm font-bold text-white shadow-sm disabled:opacity-50"
                style={{
                  background:
                    polygon.length < 3 || stats.sqft == null
                      ? '#94a3b8'
                      : 'linear-gradient(135deg, #2563eb, #1d4ed8)',
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
