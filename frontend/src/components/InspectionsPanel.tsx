'use client'

/**
 * InspectionsPanel — the contractor's booked-inspection calendar.
 * Homeowners book a free inspection from their RoofIQ report (/r/[token]);
 * each booking lands here and advances the linked CRM lead to "site_visit".
 * Renders nothing until at least one inspection exists, so it stays out of
 * the way for contractors who haven't received a booking yet.
 */
import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'

import { api, type Appointment, type AppointmentStatus } from '@/lib/api'

const STATUS_STYLE: Record<AppointmentStatus, { label: string; cls: string }> = {
  requested: { label: 'Requested', cls: 'bg-amber-500/15 text-amber-300 ring-amber-500/30' },
  confirmed: { label: 'Confirmed', cls: 'bg-blue-500/15 text-blue-300 ring-blue-500/30' },
  completed: { label: 'Completed', cls: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30' },
  cancelled: { label: 'Cancelled', cls: 'bg-slate-500/15 text-slate-400 ring-slate-500/30' },
  no_show: { label: 'No-show', cls: 'bg-rose-500/15 text-rose-300 ring-rose-500/30' },
}
const WINDOW_LABEL: Record<string, string> = { morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening', anytime: 'Anytime' }

// Contextual next-actions per current status.
const ACTIONS: Record<AppointmentStatus, { to: AppointmentStatus; label: string }[]> = {
  requested: [{ to: 'confirmed', label: 'Confirm' }, { to: 'cancelled', label: 'Cancel' }],
  confirmed: [{ to: 'completed', label: 'Completed' }, { to: 'no_show', label: 'No-show' }, { to: 'cancelled', label: 'Cancel' }],
  completed: [],
  cancelled: [{ to: 'confirmed', label: 'Re-open' }],
  no_show: [{ to: 'confirmed', label: 'Reschedule' }],
}

function fmtDay(iso: string) {
  const d = new Date(iso + 'T00:00:00')
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

export default function InspectionsPanel() {
  const [appts, setAppts] = useState<Appointment[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    api.appointments.list().then(r => setAppts(r.appointments)).catch(() => setAppts([]))
  }, [])

  const setStatus = useCallback((id: string, to: AppointmentStatus) => {
    setBusyId(id)
    api.appointments.update(id, { status: to })
      .then(updated => {
        setAppts(prev => (prev || []).map(a => a.id === id ? updated : a))
        toast.success(to === 'confirmed' ? 'Confirmed — homeowner texted' : to === 'cancelled' ? 'Declined — homeowner texted' : `Marked ${STATUS_STYLE[to].label.toLowerCase()}`)
      })
      .catch(e => toast.error(e instanceof Error ? e.message : 'Could not update'))
      .finally(() => setBusyId(null))
  }, [])

  const removeOne = useCallback((id: string) => {
    setBusyId(id)
    api.appointments.remove(id)
      .then(() => setAppts(prev => (prev || []).filter(a => a.id !== id)))
      .catch(e => toast.error(e instanceof Error ? e.message : 'Could not remove'))
      .finally(() => setBusyId(null))
  }, [])

  const clearDone = useCallback(() => {
    api.appointments.clearDone()
      .then(r => {
        api.appointments.list().then(res => setAppts(res.appointments)).catch(() => {})
        toast.success(r.removed ? `Cleared ${r.removed} old inspection${r.removed === 1 ? '' : 's'}` : 'Nothing to clear')
      })
      .catch(e => toast.error(e instanceof Error ? e.message : 'Could not clear'))
  }, [])

  if (!appts || appts.length === 0) return null

  const today = new Date().toISOString().slice(0, 10)
  const active = appts.filter(a => a.status !== 'cancelled' && a.status !== 'completed' && a.status !== 'no_show' && a.preferred_date >= today)
  const upcomingCount = active.length
  const hasDone = appts.some(a => a.status === 'cancelled' || a.status === 'completed' || a.status === 'no_show' || a.preferred_date < today)

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-white">📅 Inspections</span>
          {upcomingCount > 0 && (
            <span className="rounded-full bg-blue-500/20 px-2 py-0.5 text-[11px] font-semibold text-blue-300 ring-1 ring-blue-500/30">{upcomingCount} upcoming</span>
          )}
        </div>
        {hasDone && (
          <button onClick={clearDone}
            className="rounded-lg bg-white/5 px-2.5 py-1 text-[11px] font-medium text-slate-300 ring-1 ring-white/10 hover:bg-white/10">
            🧹 Clear old
          </button>
        )}
      </div>

      <div className="space-y-2">
        {appts.map(a => {
          const st = STATUS_STYLE[a.status]
          return (
            <div key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-white/[0.03] px-3 py-2.5 ring-1 ring-white/5">
              <div className="min-w-[92px] shrink-0">
                <div className="text-sm font-semibold text-white">{fmtDay(a.preferred_date)}</div>
                <div className="text-[11px] text-slate-400">{WINDOW_LABEL[a.time_window] || a.time_window}</div>
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-white">{a.homeowner_name || 'Homeowner'}</div>
                <div className="truncate text-[11px] text-slate-400">
                  {a.address || '—'}
                  {a.homeowner_phone && <> · {a.homeowner_phone}</>}
                </div>
                {a.homeowner_note && <div className="mt-0.5 truncate text-[11px] italic text-slate-500">“{a.homeowner_note}”</div>}
              </div>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ${st.cls}`}>{st.label}</span>
              <div className="flex shrink-0 items-center gap-1.5">
                {a.report_token && (
                  <a href={`/r/${a.report_token}`} target="_blank" rel="noreferrer"
                    className="rounded-lg bg-white/5 px-2 py-1 text-[11px] font-medium text-slate-300 ring-1 ring-white/10 hover:bg-white/10">Report</a>
                )}
                {ACTIONS[a.status].map(act => (
                  <button key={act.to} onClick={() => setStatus(a.id, act.to)} disabled={busyId === a.id}
                    className="rounded-lg bg-white/5 px-2 py-1 text-[11px] font-medium text-slate-200 ring-1 ring-white/10 transition hover:bg-white/10 disabled:opacity-40">
                    {act.label}
                  </button>
                ))}
                <button onClick={() => removeOne(a.id)} disabled={busyId === a.id} title="Remove from calendar"
                  className="rounded-lg bg-white/5 px-2 py-1 text-[11px] font-medium text-slate-500 ring-1 ring-white/10 transition hover:bg-rose-500/15 hover:text-rose-300 disabled:opacity-40">
                  ✕
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
