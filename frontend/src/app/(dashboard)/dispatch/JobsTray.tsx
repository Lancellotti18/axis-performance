'use client'

/**
 * Jobs tray — a bottom sheet of everything that needs a dispatcher's attention but
 * isn't on the grid yet: unassigned work, jobs missing measurements, holds, live
 * conflicts, and cancellations. Unassigned rows are draggable straight onto a
 * crew-day (drops call POST /appointments). Collapsed to a handle by default.
 */
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useDraggable } from '@dnd-kit/core'
import { fetchTray, type TrayRow } from './lib/board'

const jobTypeLabel = (t: string) => t.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase())
type TabKey = 'unassigned' | 'needs_measurements' | 'conflicts' | 'on_hold' | 'canceled'
const TABS: { key: TabKey; label: string; draggable: boolean }[] = [
  { key: 'unassigned', label: 'Unassigned', draggable: true },
  { key: 'needs_measurements', label: 'Needs measurements', draggable: true },
  { key: 'conflicts', label: 'Conflicts', draggable: false },
  { key: 'on_hold', label: 'On hold', draggable: false },
  { key: 'canceled', label: 'Canceled', draggable: false },
]

export default function JobsTray() {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<TabKey>('unassigned')
  const { data } = useQuery({ queryKey: ['tray'], queryFn: fetchTray, staleTime: 30_000 })

  const counts = useMemo(() => ({
    unassigned: data?.unassigned.length ?? 0,
    needs_measurements: data?.needs_measurements.length ?? 0,
    conflicts: data?.conflicts.length ?? 0,
    on_hold: data?.on_hold.length ?? 0,
    canceled: data?.canceled.length ?? 0,
  }), [data])

  const rows: TrayRow[] = data ? data[tab] : []
  const draggable = TABS.find(t => t.key === tab)?.draggable ?? false
  const attention = counts.unassigned + counts.needs_measurements + counts.conflicts

  return (
    <div className="fixed inset-x-0 bottom-0 z-30 flex flex-col border-t shadow-2xl"
      style={{ background: 'var(--panel)', borderColor: 'var(--line)', maxHeight: open ? '42vh' : '38px' }}>
      {/* Handle */}
      <button onClick={() => setOpen(o => !o)} className="flex h-[38px] shrink-0 items-center gap-3 px-4 text-left">
        <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--muted)' }}>Jobs tray</span>
        {attention > 0 && (
          <span className="rounded-full px-2 py-0.5 text-[10px] font-bold" style={{ background: 'var(--dawn)', color: '#1a0e05' }}>
            {attention} need{attention === 1 ? 's' : ''} scheduling
          </span>
        )}
        <span className="ml-auto text-[12px]" style={{ color: 'var(--muted)' }}>{open ? '▾ close' : '▴ open'}</span>
      </button>

      {open && (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Tabs */}
          <div className="flex gap-1 border-b px-3 py-1.5" style={{ borderColor: 'var(--line)' }}>
            {TABS.map(t => (
              <button key={t.key} onClick={() => setTab(t.key)}
                className="rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors"
                style={{ background: tab === t.key ? 'var(--panel2)' : 'transparent', color: tab === t.key ? 'var(--text)' : 'var(--muted)' }}>
                {t.label}
                <span className="ml-1.5 rounded px-1 text-[10px]" style={{ background: 'rgba(255,255,255,0.07)', color: counts[t.key] ? 'var(--dawn)' : 'var(--muted)' }}>{counts[t.key]}</span>
              </button>
            ))}
          </div>

          {/* Rows */}
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
            {rows.length === 0 ? (
              <div className="py-8 text-center text-[12px]" style={{ color: 'var(--muted)' }}>Nothing here — this queue is clear.</div>
            ) : (
              <div className="space-y-1">
                {draggable && <div className="pb-1 text-[10px]" style={{ color: 'var(--muted)' }}>Drag a job onto any crew-day to schedule it.</div>}
                {rows.map(r => draggable
                  ? <TrayDrag key={r.job_id} row={r}><Row row={r} tab={tab} /></TrayDrag>
                  : <Row key={r.job_id} row={r} tab={tab} />)}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function TrayDrag({ row, children }: { row: TrayRow; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `tray:${row.job_id}`,
    data: { type: 'tray', label: `${jobTypeLabel(row.job_type)} #${row.job_number}`, squares: row.squares },
  })
  return (
    <div ref={setNodeRef} {...listeners} {...attributes} className="cursor-grab active:cursor-grabbing" style={{ opacity: isDragging ? 0.4 : 1 }}>
      {children}
    </div>
  )
}

function Row({ row, tab }: { row: TrayRow; tab: TabKey }) {
  const blocks = (row.conflicts || []).filter(c => c.severity === 'BLOCK')
  const warns = (row.conflicts || []).filter(c => c.severity === 'WARN')
  return (
    <div className="flex items-center gap-3 rounded-md px-2.5 py-1.5 text-[12px] hover:bg-[#eeeeed]" style={{ background: 'var(--panel2)' }}>
      <span className="w-10 shrink-0 font-mono text-[11px]" style={{ color: 'var(--muted)' }}>#{row.job_number}</span>
      <span className="w-32 shrink-0 truncate font-semibold">{jobTypeLabel(row.job_type)}</span>
      <span className="w-40 shrink-0 truncate" style={{ color: 'var(--muted)' }}>{[row.customer, row.city].filter(Boolean).join(' · ')}</span>
      <span className="w-24 shrink-0 tabular-nums">
        {row.squares != null
          ? <span style={{ color: 'var(--dawn)' }}>{row.squares} sq</span>
          : <span style={{ color: 'var(--tight)' }}>no measure</span>}
        <span style={{ color: 'var(--muted)' }}> · {row.est_crew_days}d{row.is_estimated ? '*' : ''}</span>
      </span>
      {row.priority === 'URGENT' && <span className="rounded px-1 py-0.5 text-[9px] font-bold" style={{ background: 'color-mix(in srgb, var(--over) 20%, transparent)', color: 'var(--over)' }}>Urgent</span>}
      {row.tags.slice(0, 2).map((t, i) => <span key={i} className="rounded px-1 py-0.5 text-[9px] font-semibold" style={{ background: 'rgba(255,255,255,0.07)', color: 'var(--muted)' }}>{t}</span>)}
      {tab === 'conflicts' && blocks.length > 0 && <span className="rounded px-1 py-0.5 text-[9px] font-bold" style={{ background: 'color-mix(in srgb, var(--over) 20%, transparent)', color: 'var(--over)' }} title={blocks.map(b => b.message).join(' · ')}>⃠ {blocks.length} block</span>}
      {tab === 'conflicts' && warns.length > 0 && <span className="rounded px-1 py-0.5 text-[9px] font-bold" style={{ background: 'color-mix(in srgb, var(--tight) 20%, transparent)', color: 'var(--tight)' }} title={warns.map(w => w.message).join(' · ')}>⚠ {warns.length}</span>}
      <span className="ml-auto shrink-0 text-[10px]" style={{ color: 'var(--muted)' }}>
        {row.deadline ? `due ${row.deadline.slice(5)}` : row.age_days != null ? `${row.age_days}d old` : ''}
        {row.sold_amount != null ? ` · $${row.sold_amount.toLocaleString()}` : ''}
      </span>
    </div>
  )
}
