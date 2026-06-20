'use client'

/**
 * CollapsibleSection — a titled, collapsible container.
 *
 * The editor step stacks many AI-assist panels (facet detection, edge labels,
 * penetrations, ground photos, wall transitions, flashing). Grouping them under
 * one collapsible section lets a contractor focus on the canvas + measurements
 * and expand the AI tools only when they want them — instead of scrolling a
 * wall of panels.
 */
import { useState } from 'react'

interface Props {
  title: string
  subtitle?: string
  defaultOpen?: boolean
  /** small right-aligned hint, e.g. "6 tools" */
  badge?: string
  children: React.ReactNode
}

export default function CollapsibleSection({
  title, subtitle, defaultOpen = true, badge, children,
}: Props) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="overflow-hidden rounded-lg border border-white/10 bg-slate-900/30">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition hover:bg-slate-800/40"
      >
        <span className={`text-slate-400 transition-transform ${open ? 'rotate-90' : ''}`}>▸</span>
        <div className="flex-1">
          <div className="text-sm font-semibold text-slate-100">{title}</div>
          {subtitle && <div className="text-xs text-slate-400">{subtitle}</div>}
        </div>
        {badge && <span className="rounded bg-slate-800 px-2 py-0.5 text-[10px] text-slate-300">{badge}</span>}
        <span className="text-[10px] text-slate-500">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && <div className="space-y-3 border-t border-white/10 p-3">{children}</div>}
    </div>
  )
}
