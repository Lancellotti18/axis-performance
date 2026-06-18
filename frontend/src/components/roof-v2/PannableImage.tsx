'use client'

/**
 * PannableImage — instant pan/zoom satellite preview.
 *
 * Replaces the static <img> + refetch-keypad on the imagery step. Drag to pan,
 * scroll to zoom, arrow/WASD to pan, +/−/0 to zoom/reset. Everything is a CSS
 * transform (16ms) — no backend round-trip. On-canvas controls (zoom cluster +
 * pan keypad + reset) live in the corners. `children` render as fixed overlays
 * on top of the viewport (e.g. the "Center on house" button).
 */
import { useMapPan } from '@/lib/useMapPan'

interface Props {
  src: string
  alt?: string
  /** max viewport height in px */
  maxHeight?: number
  className?: string
  /** fixed overlays (not transformed) — e.g. center-on-house button */
  children?: React.ReactNode
}

export default function PannableImage({
  src, alt = 'satellite tile', maxHeight = 520, className = '', children,
}: Props) {
  const map = useMapPan({ minScale: 1, maxScale: 14 })

  return (
    <div
      ref={map.containerRef}
      {...map.bind}
      tabIndex={0}
      className={`relative select-none overflow-hidden rounded border border-white/10 bg-black outline-none focus:ring-1 focus:ring-blue-500/40 ${map.isPanning ? 'cursor-grabbing' : 'cursor-grab'} ${className}`}
      style={{ height: maxHeight, touchAction: 'none' }}
    >
      {/* Transformed stage holds the world content */}
      <div
        ref={map.stageRef}
        className="absolute inset-0 flex items-center justify-center"
        style={{ transform: map.transform, transformOrigin: '0 0', willChange: 'transform' }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt}
          draggable={false}
          className="block h-full w-full object-contain"
        />
      </div>

      {/* Zoom cluster (bottom-right) */}
      <div className="absolute bottom-2 right-2 flex flex-col gap-1">
        <button
          onClick={map.zoomIn}
          title="Zoom in (+)"
          className="flex h-8 w-8 items-center justify-center rounded bg-slate-900/85 text-lg text-white shadow-lg backdrop-blur hover:bg-blue-600"
        >+</button>
        <button
          onClick={map.zoomOut}
          title="Zoom out (−)"
          className="flex h-8 w-8 items-center justify-center rounded bg-slate-900/85 text-lg text-white shadow-lg backdrop-blur hover:bg-blue-600"
        >−</button>
        <button
          onClick={map.reset}
          title="Reset view (0 or R)"
          className="flex h-8 w-8 items-center justify-center rounded bg-slate-900/85 text-xs text-white shadow-lg backdrop-blur hover:bg-blue-600"
        >⟲</button>
      </div>

      {/* Instant pan keypad (top-right) — CSS transform, no refetch */}
      <div className="absolute right-2 top-2 grid grid-cols-3 gap-0.5 rounded-md border border-white/20 bg-slate-900/85 p-1 shadow-lg backdrop-blur">
        <div></div>
        <button onClick={() => map.panBy(0, 60)} title="Pan up (↑ / W)"
          className="flex h-7 w-7 items-center justify-center rounded bg-slate-800 text-white hover:bg-blue-600">↑</button>
        <div></div>
        <button onClick={() => map.panBy(60, 0)} title="Pan left (← / A)"
          className="flex h-7 w-7 items-center justify-center rounded bg-slate-800 text-white hover:bg-blue-600">←</button>
        <div className="flex h-7 w-7 items-center justify-center text-[9px] text-slate-500">pan</div>
        <button onClick={() => map.panBy(-60, 0)} title="Pan right (→ / D)"
          className="flex h-7 w-7 items-center justify-center rounded bg-slate-800 text-white hover:bg-blue-600">→</button>
        <div></div>
        <button onClick={() => map.panBy(0, -60)} title="Pan down (↓ / S)"
          className="flex h-7 w-7 items-center justify-center rounded bg-slate-800 text-white hover:bg-blue-600">↓</button>
        <div></div>
      </div>

      {/* Hint */}
      <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-black/70 px-2 py-1 text-[10px] text-white">
        Drag to pan · scroll to zoom · arrows / WASD · 0 resets
      </div>

      {children}
    </div>
  )
}
