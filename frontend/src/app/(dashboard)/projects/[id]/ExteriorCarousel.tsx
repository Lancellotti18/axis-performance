'use client'
/**
 * ExteriorCarousel — 360° exterior view navigator
 * Shows 4 angle views (front, left-side, right-side, rear) with
 * arrow navigation, dot indicators, and keyboard support.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react'

interface ExteriorView {
  angle: string
  label?: string
  url:   string | null
}

interface Props {
  views: ExteriorView[]
}

const ANGLE_LABEL: Record<string, string> = {
  'front':      'Front',
  'left-side':  'Left Side',
  'right-side': 'Right Side',
  'rear':       'Rear',
}

export default function ExteriorCarousel({ views }: Props) {
  const [idx, setIdx] = useState(0)
  const [imgErrors,  setImgErrors]  = useState<Record<number, boolean>>({})
  const [imgLoaded,  setImgLoaded]  = useState<Record<number, boolean>>({})
  const imgRef = useRef<HTMLDivElement>(null)

  const prev = useCallback(() => setIdx(i => (i === 0 ? views.length - 1 : i - 1)), [views.length])
  const next = useCallback(() => setIdx(i => (i === views.length - 1 ? 0 : i + 1)), [views.length])

  // Keyboard navigation (all browsers)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft')  prev()
      if (e.key === 'ArrowRight') next()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [prev, next])

  // Touch swipe navigation (iOS Safari, Android Chrome)
  useEffect(() => {
    const el = imgRef.current
    if (!el) return
    let startX = 0
    const onTouchStart = (e: TouchEvent) => { startX = e.touches[0].clientX }
    const onTouchEnd   = (e: TouchEvent) => {
      const dx = e.changedTouches[0].clientX - startX
      if (Math.abs(dx) > 40) dx < 0 ? next() : prev()
    }
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchend',   onTouchEnd,   { passive: true })
    return () => {
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchend',   onTouchEnd)
    }
  }, [prev, next])

  if (!views.length) return null

  const current = views[idx]
  const label   = ANGLE_LABEL[current.angle] ?? current.label ?? current.angle

  return (
    <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid rgba(219,234,254,0.8)', background: '#fff', boxShadow: '0 2px 12px rgba(59,130,246,0.08)' }}>

      {/* Header */}
      <div className="px-5 py-3 border-b flex items-center justify-between" style={{ borderColor: 'rgba(219,234,254,0.8)' }}>
        <div className="flex items-center gap-2">
          <span className="text-slate-700 font-bold text-sm">360° Exterior View</span>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-600 border border-indigo-100 font-semibold">
            ← → keys
          </span>
        </div>
        <span className="text-slate-400 text-xs">{idx + 1} / {views.length}</span>
      </div>

      {/* Image */}
      <div ref={imgRef} className="relative bg-slate-100 select-none" style={{ aspectRatio: '16/9' }}>
        {/* Loading spinner — shown until image resolves or errors */}
        {current.url && !imgLoaded[idx] && !imgErrors[idx] && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-slate-900">
            <svg className="animate-spin text-indigo-400" width="28" height="28" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/>
            </svg>
            <span className="text-slate-400 text-xs">Generating {label.toLowerCase()} view…</span>
          </div>
        )}

        {current.url && !imgErrors[idx] ? (
          <img
            src={current.url}
            alt={`Exterior ${label}`}
            className="absolute inset-0 w-full h-full object-cover"
            style={{ opacity: imgLoaded[idx] ? 1 : 0, transition: 'opacity 0.4s' }}
            draggable={false}
            onLoad={() => setImgLoaded(prev => ({ ...prev, [idx]: true }))}
            onError={() => setImgErrors(prev => ({ ...prev, [idx]: true }))}
          />
        ) : !current.url || imgErrors[idx] ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-slate-900 text-slate-400">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <rect x="3" y="3" width="18" height="14" rx="2"/>
              <path d="M3 9l4-4 4 4 4-4 4 4"/>
            </svg>
            <span className="text-sm">{label} — render unavailable</span>
            {imgErrors[idx] && (
              <button
                onClick={() => setImgErrors(prev => { const n = {...prev}; delete n[idx]; return n })}
                className="mt-1 px-3 py-1 rounded-lg text-xs font-semibold text-white"
                style={{ background: 'linear-gradient(135deg,#6366f1,#4f46e5)' }}
              >
                ↺ Retry
              </button>
            )}
          </div>
        ) : null}

        {/* Angle badge */}
        <div
          className="absolute bottom-3 left-3 px-3 py-1 rounded-full text-xs font-bold text-white"
          style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)' }}
        >
          {label}
        </div>

        {/* Download */}
        {current.url && (
          <a
            href={current.url}
            target="_blank"
            rel="noreferrer"
            download={`exterior_${current.angle}.jpg`}
            className="absolute bottom-3 right-3 px-2.5 py-1 rounded-full text-xs font-semibold text-white"
            style={{ background: 'rgba(0,0,0,0.50)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)' }}
            onClick={e => e.stopPropagation()}
          >
            ↓ Save
          </a>
        )}

        {/* Prev arrow */}
        <button
          onClick={prev}
          aria-label="Previous view"
          className="absolute left-3 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full flex items-center justify-center text-white text-xl font-bold transition-all hover:scale-110"
          style={{ background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)' }}
        >
          ‹
        </button>

        {/* Next arrow */}
        <button
          onClick={next}
          aria-label="Next view"
          className="absolute right-3 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full flex items-center justify-center text-white text-xl font-bold transition-all hover:scale-110"
          style={{ background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)' }}
        >
          ›
        </button>
      </div>

      {/* Angle selector tabs */}
      <div className="flex border-t" style={{ borderColor: 'rgba(219,234,254,0.8)' }}>
        {views.map((v, i) => {
          const lbl = ANGLE_LABEL[v.angle] ?? v.label ?? v.angle
          const active = i === idx
          return (
            <button
              key={i}
              onClick={() => setIdx(i)}
              className="flex-1 py-2.5 text-xs font-semibold transition-all border-r last:border-r-0 relative"
              style={{
                borderColor:     'rgba(219,234,254,0.8)',
                color:           active ? '#6366f1' : '#94a3b8',
                background:      active ? '#f5f3ff' : 'transparent',
              }}
            >
              {lbl}
              {active && (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-indigo-400" />
              )}
              {!v.url && (
                <span className="ml-1 text-[9px] text-slate-300">●</span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
