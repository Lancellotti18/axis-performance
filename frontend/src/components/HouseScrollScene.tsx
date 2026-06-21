'use client'
/**
 * HouseScrollScene — Apple/Tesla-style scroll-driven frame sequence.
 *
 * Renders a sticky <canvas> that fills the viewport while the user scrolls
 * through a tall track. The scroll progress (0..1) maps to a frame index
 * into a pre-rendered image sequence (rotation + build stages of the house).
 *
 * Asset layout (see public/house-frames/README.md):
 *   public/house-frames/frame-0001.jpg ... frame-{TOTAL_FRAMES}.jpg
 *
 * Loading strategy:
 *   - Sparse priority load (every Nth frame) immediately so the canvas
 *     has something to draw even before the full sequence is in memory.
 *   - Fills in the gaps progressively in the background.
 *   - Falls back to the nearest already-loaded frame when scrolling
 *     past an un-loaded index — no blank flashes.
 */

import { useEffect, useRef, useState, useCallback } from 'react'

interface Props {
  /** Total number of frames in the sequence. Defaults to 240 — change to match your file count. */
  totalFrames?: number
  /** Frame path template — `{idx}` is replaced with the 1-based, zero-padded index. */
  framePathTemplate?: string
  /** Children render absolutely on top of the canvas (overlay content). */
  children?: React.ReactNode
  /** Height of the scroll track. Default 400vh = ~4 viewport-heights of scroll to play the sequence. */
  trackHeightVh?: number
  /**
   * Called every animation frame with the current scroll progress (0..1).
   * Use this to drive overlay opacity / parallax in the parent.
   */
  onProgress?: (progress: number) => void
}

const PAD = 4  // zero-padding for frame numbers
const PRELOAD_STRIDE = 8  // load every 8th frame first for fast initial paint
const VIEW_PORT_BUFFER = 24  // how many frames ahead to keep warm during scroll

export default function HouseScrollScene({
  totalFrames = 240,
  framePathTemplate = '/house-frames/frame-{idx}.jpg',
  children,
  trackHeightVh = 400,
  onProgress,
}: Props) {
  const trackRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const framesRef = useRef<(HTMLImageElement | null)[]>([])
  const loadedRef = useRef<Set<number>>(new Set())
  const currentFrameRef = useRef(0)
  const rafRef = useRef<number | null>(null)
  const [bootstrapLoaded, setBootstrapLoaded] = useState(false)
  const [loadedCount, setLoadedCount] = useState(0)

  // ── Frame path helper ───────────────────────────────────────────────────
  const pathFor = useCallback((i: number) => {
    const padded = String(i + 1).padStart(PAD, '0')
    return framePathTemplate.replace('{idx}', padded)
  }, [framePathTemplate])

  // ── Image loader (idempotent — caches loaded images in framesRef) ──────
  const loadFrame = useCallback((i: number, priority = false): Promise<void> => {
    if (i < 0 || i >= totalFrames) return Promise.resolve()
    if (loadedRef.current.has(i)) return Promise.resolve()
    return new Promise<void>(resolve => {
      const img = new Image()
      img.decoding = priority ? 'sync' : 'async'
      img.fetchPriority = priority ? 'high' : 'auto'
      img.onload = () => {
        framesRef.current[i] = img
        loadedRef.current.add(i)
        setLoadedCount(loadedRef.current.size)
        resolve()
      }
      img.onerror = () => {
        // Silently mark as "attempted" so we don't loop forever on a missing frame
        loadedRef.current.add(i)
        resolve()
      }
      img.src = pathFor(i)
    })
  }, [pathFor, totalFrames])

  // ── Canvas draw: pick the nearest-loaded frame for the target index ────
  const drawFrame = useCallback((targetIdx: number) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return

    // Find the closest loaded frame to targetIdx so we never draw blank.
    let frame = framesRef.current[targetIdx]
    if (!frame) {
      let best = -1
      let bestDist = Infinity
      framesRef.current.forEach((f, i) => {
        if (!f) return
        const d = Math.abs(i - targetIdx)
        if (d < bestDist) { bestDist = d; best = i }
      })
      if (best === -1) return  // nothing loaded yet
      frame = framesRef.current[best]
    }
    if (!frame) return

    // Render the backing store at full device resolution (capped at 2× — the
    // source frames are 1920×1080, so there's no detail to gain beyond that and
    // a 3× buffer just costs performance). Setting canvas.width resets the
    // transform + smoothing flags, so we (re)apply them on every resize.
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    // object-fit: cover — scale to fill, crop the long side. Round the draw rect
    // to whole device pixels so the image isn't resampled across a sub-pixel
    // boundary (a real, if subtle, source of softness).
    const fw = frame.naturalWidth
    const fh = frame.naturalHeight
    const scale = Math.max(w / fw, h / fh)
    const dw = Math.ceil(fw * scale)
    const dh = Math.ceil(fh * scale)
    const dx = Math.round((w - dw) / 2)
    const dy = Math.round((h - dh) / 2)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(frame, dx, dy, dw, dh)
  }, [])

  // ── Scroll → frame index, throttled to rAF ─────────────────────────────
  const onScroll = useCallback(() => {
    if (rafRef.current != null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      const track = trackRef.current
      if (!track) return
      const rect = track.getBoundingClientRect()
      const trackH = track.offsetHeight - window.innerHeight
      // Progress 0..1 as the top of the track passes through the viewport.
      const progress = Math.max(0, Math.min(1, -rect.top / trackH))
      const idx = Math.min(totalFrames - 1, Math.max(0, Math.floor(progress * (totalFrames - 1))))
      currentFrameRef.current = idx
      drawFrame(idx)
      onProgress?.(progress)

      // Keep nearby frames warm — load the window around the current frame
      for (let off = -2; off <= VIEW_PORT_BUFFER; off++) {
        const target = idx + off
        if (target >= 0 && target < totalFrames && !loadedRef.current.has(target)) {
          loadFrame(target)
        }
      }
    })
  }, [drawFrame, loadFrame, onProgress, totalFrames])

  // ── Bootstrap: priority-load sparse frames, then start scroll listener ─
  useEffect(() => {
    let cancelled = false

    async function bootstrap() {
      // First, load frame 0 with priority so the canvas isn't blank.
      await loadFrame(0, true)
      if (cancelled) return
      drawFrame(0)
      setBootstrapLoaded(true)

      // Sparse pass — every PRELOAD_STRIDE-th frame for instant scrubbing.
      const priorityIndices: number[] = []
      for (let i = PRELOAD_STRIDE; i < totalFrames; i += PRELOAD_STRIDE) {
        priorityIndices.push(i)
      }
      // Always include the very last frame so the end-state never pops in.
      if (priorityIndices[priorityIndices.length - 1] !== totalFrames - 1) {
        priorityIndices.push(totalFrames - 1)
      }
      // Load these in parallel with limited concurrency
      const CONCURRENCY = 4
      let cursor = 0
      const workers = Array.from({ length: CONCURRENCY }, async () => {
        while (cursor < priorityIndices.length && !cancelled) {
          const i = priorityIndices[cursor++]
          await loadFrame(i)
        }
      })
      await Promise.all(workers)

      if (cancelled) return

      // Fill-in pass — load remaining frames in order, low priority.
      for (let i = 1; i < totalFrames && !cancelled; i++) {
        if (!loadedRef.current.has(i)) {
          await loadFrame(i)
        }
      }
    }

    bootstrap()

    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll, { passive: true })
    // Trigger an initial draw based on current scroll position
    onScroll()

    return () => {
      cancelled = true
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    }
  }, [drawFrame, loadFrame, onScroll, totalFrames])

  // Loading hint — fraction of sequence loaded (for an optional indicator)
  const loadProgress = Math.min(1, loadedCount / totalFrames)

  return (
    <div ref={trackRef} className="relative" style={{ height: `${trackHeightVh}vh` }}>
      {/* Sticky stage — pinned to the viewport while the track scrolls past */}
      <div className="sticky top-0 h-screen w-full overflow-hidden">
        {/* Canvas (the house) */}
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full"
          style={{
            display: 'block',
            // Light, GPU-cheap perceptual sharpening — counters the softness
            // from upscaling/JPEG so the house reads crisp without artifacts.
            filter: 'contrast(1.06) saturate(1.07) brightness(1.02)',
          }}
          aria-hidden
        />

        {/* Premium ambient lighting — a gentle vignette ONLY at the far corners,
            so the house stays crisp and clean (no fog over the subject). */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(ellipse 90% 80% at 50% 50%, transparent 0%, transparent 72%, rgba(2,6,18,0.34) 100%)',
          }}
        />
        {/* Top + bottom edge fades blending the canvas into the dark page chrome */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-[#02060f] via-[#02060f]/40 to-transparent" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-[#02060f] via-[#02060f]/40 to-transparent" />

        {/* Brand glow accents — kept faint + pushed to the corners so they add
            depth without hazing the subject. */}
        <div
          className="pointer-events-none absolute -top-40 -left-40 w-[560px] h-[560px] rounded-full opacity-20 blur-3xl"
          style={{ background: 'radial-gradient(circle, rgba(74,144,226,0.28), transparent 60%)' }}
        />
        <div
          className="pointer-events-none absolute -bottom-40 -right-40 w-[560px] h-[560px] rounded-full opacity-[0.14] blur-3xl"
          style={{ background: 'radial-gradient(circle, rgba(120,180,255,0.22), transparent 60%)' }}
        />

        {/* Initial-load curtain — only while the first frame is being fetched */}
        {!bootstrapLoaded && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#02060f]">
            <div className="flex flex-col items-center gap-3">
              <svg className="animate-spin text-blue-400" width="28" height="28" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
              </svg>
              <div className="text-blue-200/60 text-xs tracking-widest uppercase font-mono">Initializing</div>
            </div>
          </div>
        )}

        {/* Overlay content rendered by the parent */}
        {children}

        {/* Hairline progress strip — only shows while loading */}
        {bootstrapLoaded && loadProgress < 1 && (
          <div className="absolute top-0 left-0 right-0 h-px bg-white/5">
            <div
              className="h-full bg-gradient-to-r from-blue-400/0 via-blue-300/80 to-blue-400/0 transition-all duration-300"
              style={{ width: `${loadProgress * 100}%` }}
            />
          </div>
        )}
      </div>
    </div>
  )
}
