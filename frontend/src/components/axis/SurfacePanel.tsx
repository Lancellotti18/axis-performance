'use client'
import { HTMLAttributes, MouseEvent, ReactNode, useRef } from 'react'

export interface SurfacePanelProps extends HTMLAttributes<HTMLDivElement> {
  /** Adds a faint diamond-plate texture inside the panel */
  plate?: boolean
  /** Adds the animated AI-insight outline trace + sweep */
  insight?: boolean
  /** Disables the cursor-tracking light reflection (use for dense list rows) */
  staticSurface?: boolean
  children?: ReactNode
}

export function SurfacePanel({
  plate,
  insight,
  staticSurface,
  className = '',
  children,
  onMouseMove,
  ...rest
}: SurfacePanelProps) {
  const ref = useRef<HTMLDivElement>(null)

  function handleMove(e: MouseEvent<HTMLDivElement>) {
    if (!staticSurface && ref.current) {
      const r = ref.current.getBoundingClientRect()
      ref.current.style.setProperty('--mx', `${e.clientX - r.left}px`)
      ref.current.style.setProperty('--my', `${e.clientY - r.top}px`)
    }
    onMouseMove?.(e)
  }

  const cls = [
    'axis-surface',
    plate ? 'axis-plate axis-plate-soft' : '',
    insight ? 'axis-insight' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div ref={ref} className={cls} onMouseMove={handleMove} {...rest}>
      {children}
    </div>
  )
}
