/**
 * useMapPan — instant pan/zoom over a fixed-size stage via CSS transform.
 *
 * Replaces the "click an arrow → backend refetch → wait 1–90s" navigation with
 * a 16ms CSS transform. Provides every interaction a contractor expects from
 * pro mapping/CAD tools:
 *
 *   • Mouse / touch / pen drag to pan        (pointer events — all three free)
 *   • Two-finger pinch to zoom               (touch)
 *   • Scroll wheel to zoom, anchored at cursor
 *   • Arrow keys + WASD to pan, CONTINUOUS while held, with acceleration
 *   • + / − to zoom at viewport center
 *   • 0 or R to reset the view
 *
 * The transform is applied to a "stage" element; world content (image, SVG
 * overlays) lives inside the stage so it pans/zooms together. Coordinate math
 * that needs the post-transform rect can read the stage's getBoundingClientRect.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

export interface MapView {
  scale: number
  x: number
  y: number
}

export interface UseMapPanOptions {
  minScale?: number
  maxScale?: number
  /** keyboard pan ramps from this many px/frame … */
  panSpeedMin?: number
  /** … up to this many px/frame after holding ~700ms */
  panSpeedMax?: number
  /** disable keyboard handling (e.g. when a drawing tool owns the keys) */
  disableKeys?: boolean
}

export interface UseMapPan {
  view: MapView
  setView: React.Dispatch<React.SetStateAction<MapView>>
  /** ref for the clipping container (the viewport) */
  containerRef: React.RefObject<HTMLDivElement | null>
  /** ref for the transformed stage (holds the world content) */
  stageRef: React.RefObject<HTMLDivElement | null>
  /** CSS transform string for the stage */
  transform: string
  /** spread onto the container element */
  bind: {
    onPointerDown: (e: React.PointerEvent) => void
    onPointerMove: (e: React.PointerEvent) => void
    onPointerUp: (e: React.PointerEvent) => void
    onPointerLeave: (e: React.PointerEvent) => void
    onWheel: (e: React.WheelEvent) => void
  }
  panBy: (dx: number, dy: number) => void
  zoomIn: () => void
  zoomOut: () => void
  reset: () => void
  isPanning: boolean
}

export function useMapPan(opts: UseMapPanOptions = {}): UseMapPan {
  const minScale = opts.minScale ?? 1
  const maxScale = opts.maxScale ?? 12
  const panSpeedMin = opts.panSpeedMin ?? 7
  const panSpeedMax = opts.panSpeedMax ?? 26

  const [view, setView] = useState<MapView>({ scale: 1, x: 0, y: 0 })
  const [isPanning, setIsPanning] = useState(false)

  const containerRef = useRef<HTMLDivElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)

  // Drag state
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; origX: number; origY: number } | null>(null)
  // Active pointers for pinch
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map())
  const pinchRef = useRef<{ dist: number; scale: number; cx: number; cy: number } | null>(null)

  const viewRef = useRef(view)
  viewRef.current = view

  // ── Core zoom-at-point ──────────────────────────────────────────────
  const zoomAt = useCallback((nextScale: number, anchorX: number, anchorY: number) => {
    setView(prev => {
      const clamped = Math.max(minScale, Math.min(maxScale, nextScale))
      const worldX = (anchorX - prev.x) / prev.scale
      const worldY = (anchorY - prev.y) / prev.scale
      let nx = anchorX - worldX * clamped
      let ny = anchorY - worldY * clamped
      if (clamped <= minScale) { nx = 0; ny = 0 }   // snap to fit when fully out
      return { scale: clamped, x: nx, y: ny }
    })
  }, [minScale, maxScale])

  const panBy = useCallback((dx: number, dy: number) => {
    setView(prev => (prev.scale <= minScale
      ? prev   // no room to pan when fully zoomed out
      : { ...prev, x: prev.x + dx, y: prev.y + dy }))
  }, [minScale])

  const centerAnchor = useCallback((): [number, number] => {
    const r = containerRef.current?.getBoundingClientRect()
    return r ? [r.width / 2, r.height / 2] : [0, 0]
  }, [])

  const zoomIn = useCallback(() => {
    const [cx, cy] = centerAnchor()
    zoomAt(viewRef.current.scale * 1.4, cx, cy)
  }, [zoomAt, centerAnchor])
  const zoomOut = useCallback(() => {
    const [cx, cy] = centerAnchor()
    zoomAt(viewRef.current.scale / 1.4, cx, cy)
  }, [zoomAt, centerAnchor])
  const reset = useCallback(() => setView({ scale: 1, x: 0, y: 0 }), [])

  // ── Wheel zoom ──────────────────────────────────────────────────────
  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    const r = containerRef.current?.getBoundingClientRect()
    if (!r) return
    const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18
    zoomAt(viewRef.current.scale * factor, e.clientX - r.left, e.clientY - r.top)
  }, [zoomAt])

  // ── Pointer drag + pinch ────────────────────────────────────────────
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    // Let drawing tools handle their own clicks; only pan on primary drag of
    // the background. The consumer can stopPropagation on interactive children.
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointersRef.current.size === 2) {
      // Begin pinch
      const pts = Array.from(pointersRef.current.values())
      const dx = pts[0].x - pts[1].x
      const dy = pts[0].y - pts[1].y
      const r = containerRef.current?.getBoundingClientRect()
      pinchRef.current = {
        dist: Math.hypot(dx, dy),
        scale: viewRef.current.scale,
        cx: r ? (pts[0].x + pts[1].x) / 2 - r.left : 0,
        cy: r ? (pts[0].y + pts[1].y) / 2 - r.top : 0,
      }
      dragRef.current = null
      return
    }
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX, startY: e.clientY,
      origX: viewRef.current.x, origY: viewRef.current.y,
    }
    setIsPanning(true)
  }, [])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (pointersRef.current.has(e.pointerId)) {
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    }
    // Pinch zoom
    if (pinchRef.current && pointersRef.current.size >= 2) {
      const pts = Array.from(pointersRef.current.values())
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)
      const ratio = dist / (pinchRef.current.dist || 1)
      zoomAt(pinchRef.current.scale * ratio, pinchRef.current.cx, pinchRef.current.cy)
      return
    }
    const d = dragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    setView(prev => ({
      ...prev,
      x: d.origX + (e.clientX - d.startX),
      y: d.origY + (e.clientY - d.startY),
    }))
  }, [zoomAt])

  const endPointer = useCallback((e: React.PointerEvent) => {
    pointersRef.current.delete(e.pointerId)
    if (pointersRef.current.size < 2) pinchRef.current = null
    if (dragRef.current?.pointerId === e.pointerId) {
      dragRef.current = null
      setIsPanning(false)
    }
  }, [])

  // ── Continuous keyboard pan (held) with acceleration ────────────────
  const heldKeys = useRef<Set<string>>(new Set())
  const keyHoldStart = useRef<number>(0)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    if (opts.disableKeys) return

    const PAN_KEYS: Record<string, [number, number]> = {
      ArrowUp: [0, 1], ArrowDown: [0, -1], ArrowLeft: [1, 0], ArrowRight: [-1, 0],
      w: [0, 1], s: [0, -1], a: [1, 0], d: [-1, 0],
      W: [0, 1], S: [0, -1], A: [1, 0], D: [-1, 0],
    }

    const isTypingTarget = (t: EventTarget | null) => {
      const tag = (t as HTMLElement | null)?.tagName
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
    }

    const step = () => {
      if (heldKeys.current.size === 0) { rafRef.current = null; return }
      const heldMs = performance.now() - keyHoldStart.current
      const speed = Math.min(panSpeedMax, panSpeedMin + heldMs / 45)
      let dx = 0, dy = 0
      for (const k of heldKeys.current) {
        const v = PAN_KEYS[k]
        if (v) { dx += v[0]; dy += v[1] }
      }
      if (dx !== 0 || dy !== 0) panBy(dx * speed, dy * speed)
      rafRef.current = requestAnimationFrame(step)
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return
      if (e.key === '0' || e.key === 'r' || e.key === 'R') { reset(); return }
      if (e.key === '+' || e.key === '=') { zoomIn(); return }
      if (e.key === '-' || e.key === '_') { zoomOut(); return }
      if (!(e.key in PAN_KEYS)) return
      e.preventDefault()
      if (heldKeys.current.size === 0) keyHoldStart.current = performance.now()
      heldKeys.current.add(e.key)
      if (rafRef.current == null) rafRef.current = requestAnimationFrame(step)
    }
    const onKeyUp = (e: KeyboardEvent) => {
      heldKeys.current.delete(e.key)
    }
    const onBlur = () => { heldKeys.current.clear() }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      heldKeys.current.clear()
    }
  }, [opts.disableKeys, panBy, panSpeedMin, panSpeedMax, reset, zoomIn, zoomOut])

  const transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`

  return {
    view, setView,
    containerRef, stageRef,
    transform,
    bind: { onPointerDown, onPointerMove, onPointerUp: endPointer, onPointerLeave: endPointer, onWheel },
    panBy, zoomIn, zoomOut, reset, isPanning,
  }
}
