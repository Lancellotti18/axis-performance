'use client'

/**
 * Schedule — the contractor's inspection calendar. Homeowners book a free
 * inspection from their RoofIQ report (/r/[token]); each booking lands here on
 * its requested day. Month grid + a day panel to confirm / complete / cancel,
 * which keeps the linked CRM lead's stage in sync.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'

import { api, type Appointment, type AppointmentStatus } from '@/lib/api'

const STATUS_STYLE: Record<AppointmentStatus, { label: string; dot: string; chip: string }> = {
  requested: { label: 'Requested', dot: 'bg-amber-400',   chip: 'bg-amber-500/15 text-amber-300 ring-amber-500/30' },
  confirmed: { label: 'Confirmed', dot: 'bg-blue-400',    chip: 'bg-blue-500/15 text-blue-300 ring-blue-500/30' },
  completed: { label: 'Completed', dot: 'bg-emerald-400', chip: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30' },
  cancelled: { label: 'Cancelled', dot: 'bg-slate-500',   chip: 'bg-slate-500/15 text-slate-400 ring-slate-500/30' },
  no_show:   { label: 'No-show',   dot: 'bg-rose-400',    chip: 'bg-rose-500/15 text-rose-300 ring-rose-500/30' },
}
const WINDOW_LABEL: Record<string, string> = { morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening', anytime: 'Anytime' }
const ACTIONS: Record<AppointmentStatus, { to: AppointmentStatus; label: string }[]> = {
  requested: [{ to: 'confirmed', label: 'Confirm' }, { to: 'cancelled', label: 'Cancel' }],
  confirmed: [{ to: 'completed', label: 'Completed' }, { to: 'no_show', label: 'No-show' }, { to: 'cancelled', label: 'Cancel' }],
  completed: [],
  cancelled: [{ to: 'confirmed', label: 'Re-open' }],
  no_show:   [{ to: 'confirmed', label: 'Reschedule' }],
}
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const toKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export default function SchedulePage() {
  const [appts, setAppts] = useState<Appointment[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [cursor, setCursor] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1) })
  const todayKey = toKey(new Date())
  const [selected, setSelected] = useState<string>(todayKey)

  useEffect(() => {
    api.appointments.list().then(r => setAppts(r.appointments)).catch(() => setAppts([]))
  }, [])

  const byDay = useMemo(() => {
    const m = new Map<string, Appointment[]>()
    for (const a of appts || []) {
      if (!m.has(a.preferred_date)) m.set(a.preferred_date, [])
      m.get(a.preferred_date)!.push(a)
    }
    return m
  }, [appts])

  const setStatus = useCallback((id: string, to: AppointmentStatus) => {
    setBusyId(id)
    api.appointments.update(id, { status: to })
      .then(updated => { setAppts(prev => (prev || []).map(a => a.id === id ? updated : a)); toast.success(`Marked ${STATUS_STYLE[to].label.toLowerCase()}`) })
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not update'))
      .finally(() => setBusyId(null))
  }, [])

  // Build the month grid (weeks × 7), padded to whole weeks.
  const cells = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1)
    const start = new Date(first); start.setDate(1 - first.getDay())
    const out: Date[] = []
    for (let i = 0; i < 42; i++) { const d = new Date(start); d.setDate(start.getDate() + i); out.push(d) }
    // Trim trailing empty week if the month fits in 5 rows.
    return out.slice(0, out[35].getMonth() === cursor.getMonth() ? 42 : 35)
  }, [cursor])

  const monthLabel = cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
  const dayAppts = (byDay.get(selected) || []).slice().sort((a, b) => a.time_window.localeCompare(b.time_window))
  const upcoming = (appts || [])
    .filter(a => a.preferred_date >= todayKey && a.status !== 'cancelled' && a.status !== 'completed' && a.status !== 'no_show')

  return (
    <div className="min-h-full p-6" style={{ background: '#040810' }}>
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-black text-white">Schedule</h1>
          <p className="mt-0.5 text-xs text-slate-400">Inspections homeowners booked from their roof reports.</p>
        </div>
        {upcoming.length > 0 && (
          <span className="rounded-full bg-blue-500/20 px-3 py-1 text-xs font-semibold text-blue-300 ring-1 ring-blue-500/30">
            {upcoming.length} upcoming
          </span>
        )}
      </div>

      {appts === null ? (
        <div className="flex h-64 items-center justify-center text-slate-400">Loading…</div>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
          {/* Calendar */}
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-sm font-semibold text-white">{monthLabel}</div>
              <div className="flex items-center gap-1">
                <button onClick={() => setCursor(c => new Date(c.getFullYear(), c.getMonth() - 1, 1))}
                  className="rounded-lg bg-white/5 px-2.5 py-1 text-sm text-slate-300 ring-1 ring-white/10 hover:bg-white/10">‹</button>
                <button onClick={() => { const d = new Date(); setCursor(new Date(d.getFullYear(), d.getMonth(), 1)); setSelected(todayKey) }}
                  className="rounded-lg bg-white/5 px-2.5 py-1 text-xs font-medium text-slate-300 ring-1 ring-white/10 hover:bg-white/10">Today</button>
                <button onClick={() => setCursor(c => new Date(c.getFullYear(), c.getMonth() + 1, 1))}
                  className="rounded-lg bg-white/5 px-2.5 py-1 text-sm text-slate-300 ring-1 ring-white/10 hover:bg-white/10">›</button>
              </div>
            </div>
            <div className="grid grid-cols-7 gap-1">
              {DOW.map(d => <div key={d} className="pb-1 text-center text-[10px] font-semibold uppercase tracking-wide text-slate-500">{d}</div>)}
              {cells.map(d => {
                const key = toKey(d)
                const inMonth = d.getMonth() === cursor.getMonth()
                const items = byDay.get(key) || []
                const isToday = key === todayKey
                const isSel = key === selected
                return (
                  <button key={key} onClick={() => setSelected(key)}
                    className={`flex min-h-[64px] flex-col rounded-lg border p-1.5 text-left transition ${
                      isSel ? 'border-blue-400/60 bg-blue-500/10' : 'border-white/5 hover:border-white/15 hover:bg-white/[0.03]'
                    } ${inMonth ? '' : 'opacity-40'}`}>
                    <span className={`text-[11px] font-semibold ${isToday ? 'text-blue-300' : 'text-slate-300'}`}>{d.getDate()}</span>
                    <div className="mt-auto flex flex-wrap gap-0.5">
                      {items.slice(0, 4).map(a => <span key={a.id} className={`h-1.5 w-1.5 rounded-full ${STATUS_STYLE[a.status].dot}`} />)}
                      {items.length > 4 && <span className="text-[9px] text-slate-500">+{items.length - 4}</span>}
                    </div>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Day panel */}
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <div className="mb-3 text-sm font-semibold text-white">
              {new Date(selected + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
            </div>
            {dayAppts.length === 0 ? (
              <p className="py-8 text-center text-xs text-slate-500">No inspections booked this day.</p>
            ) : (
              <div className="space-y-2.5">
                {dayAppts.map(a => {
                  const st = STATUS_STYLE[a.status]
                  return (
                    <div key={a.id} className="rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-white">{a.homeowner_name || 'Homeowner'}</span>
                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ${st.chip}`}>{st.label}</span>
                      </div>
                      <div className="mt-1 text-[11px] text-slate-400">{WINDOW_LABEL[a.time_window] || a.time_window}{a.address && <> · {a.address}</>}</div>
                      {a.homeowner_note && <div className="mt-1 text-[11px] italic text-slate-500">“{a.homeowner_note}”</div>}
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        {a.homeowner_phone && (
                          <a href={`tel:${a.homeowner_phone}`} className="rounded-lg bg-emerald-500/15 px-2 py-1 text-[11px] font-medium text-emerald-300 ring-1 ring-emerald-500/30 hover:bg-emerald-500/25">Call</a>
                        )}
                        {a.report_token && (
                          <a href={`/r/${a.report_token}`} target="_blank" rel="noreferrer" className="rounded-lg bg-white/5 px-2 py-1 text-[11px] font-medium text-slate-300 ring-1 ring-white/10 hover:bg-white/10">Report</a>
                        )}
                        {ACTIONS[a.status].map(act => (
                          <button key={act.to} onClick={() => setStatus(a.id, act.to)} disabled={busyId === a.id}
                            className="rounded-lg bg-white/5 px-2 py-1 text-[11px] font-medium text-slate-200 ring-1 ring-white/10 hover:bg-white/10 disabled:opacity-40">{act.label}</button>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
