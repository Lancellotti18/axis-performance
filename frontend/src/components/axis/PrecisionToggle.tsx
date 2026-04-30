'use client'
import { useEffect, useState } from 'react'

const STORAGE_KEY = 'axis:precision-mode'

function readInitial(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function applyMode(on: boolean) {
  if (typeof document === 'undefined') return
  if (on) document.documentElement.setAttribute('data-mode', 'precision')
  else document.documentElement.removeAttribute('data-mode')
}

export function PrecisionToggle({ className = '' }: { className?: string }) {
  const [on, setOn] = useState(false)

  useEffect(() => {
    const initial = readInitial()
    setOn(initial)
    applyMode(initial)
  }, [])

  function toggle() {
    const next = !on
    setOn(next)
    applyMode(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0')
    } catch {}
  }

  return (
    <button
      type="button"
      onClick={toggle}
      title={on ? 'Precision Mode on — switch back to Daylight' : 'Switch to Precision Mode'}
      aria-pressed={on}
      className={`relative inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[11px] font-bold tracking-wide uppercase transition-all ${className}`}
      style={{
        background: on
          ? 'linear-gradient(180deg, #1B2433 0%, #0E1622 100%)'
          : 'linear-gradient(180deg, #FFFFFF 0%, #E5F2FB 100%)',
        color: on ? '#BFE6FF' : '#1E293B',
        border: `1px solid ${on ? 'rgba(127,201,244,0.55)' : 'rgba(127,201,244,0.45)'}`,
        boxShadow: on
          ? '0 0 0 1px rgba(127,201,244,0.35), 0 0 14px rgba(79,176,234,0.45)'
          : '0 1px 2px rgba(15,23,42,0.06), 0 0 0 1px rgba(127,201,244,0.20)',
      }}
    >
      <span
        className="inline-block w-1.5 h-1.5 rounded-full"
        style={{
          background: on ? '#BFE6FF' : '#7FC9F4',
          boxShadow: on ? '0 0 8px rgba(191,230,255,0.85)' : 'none',
        }}
      />
      {on ? 'Precision' : 'Daylight'}
    </button>
  )
}
