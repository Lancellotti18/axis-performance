'use client'

/**
 * Schedule — the contractor's inspection calendar. Homeowners book a free
 * inspection from their RoofIQ report (/r/[token]); each booking lands here on
 * its requested day. Big month grid + an upcoming-reminders rail + a rich day
 * panel that shows the roof intelligence the homeowner provided, so the rep
 * walks in already knowing the age, the problems, and the estimate.
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
const ACTIONS: Record<AppointmentStatus, { to: AppointmentStatus; label: string; tone?: string }[]> = {
  requested: [{ to: 'confirmed', label: 'Confirm', tone: 'emerald' }, { to: 'cancelled', label: 'Decline' }],
  confirmed: [{ to: 'completed', label: 'Completed', tone: 'emerald' }, { to: 'no_show', label: 'No-show' }, { to: 'cancelled', label: 'Cancel' }],
  completed: [],
  cancelled: [{ to: 'confirmed', label: 'Re-open' }],
  no_show:   [{ to: 'confirmed', label: 'Reschedule' }],
}
const WORK_LABEL: Record<string, string> = { replace: '🏠 Full replacement', repair: '🔧 Repair', unsure: '🤔 Deciding' }
const COND_LABEL: Record<string, string> = { no_damage: '✅ No visible damage', visible_damage: '⚠️ Visible damage', unsure: '🤔 Unsure' }
const ISSUE_LABEL: Record<string, string> = { leak: '💧 Active leak', storm_damage: '⛈ Storm damage', missing_shingles: '🍂 Missing shingles', sagging: '📉 Sagging', planning: '📋 Planning ahead' }
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const toKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const money = (v?: number | null) => v == null ? '—' : v.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
function relDay(iso: string): string {
  const days = Math.round((new Date(iso + 'T00:00:00').getTime() - new Date(toKey(new Date()) + 'T00:00:00').getTime()) / 86400000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  if (days > 1 && days < 7) return `In ${days} days`
  return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

export default function SchedulePage() {
  const [appts, setAppts] = useState<Appointment[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [cursor, setCursor] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1) })
  const todayKey = toKey(new Date())
  const [selected, setSelected] = useState<string>(todayKey)
  const [proposeFor, setProposeFor] = useState<string | null>(null)
  const [proposeDates, setProposeDates] = useState<string[]>(['', '', ''])

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
      .then(updated => {
        setAppts(prev => (prev || []).map(a => a.id === id ? { ...updated, lead: a.lead } : a))
        toast.success(to === 'confirmed' ? 'Confirmed — homeowner texted' : `Marked ${STATUS_STYLE[to].label.toLowerCase()}`)
      })
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not update'))
      .finally(() => setBusyId(null))
  }, [])

  const sendPropose = useCallback((id: string) => {
    const dates = proposeDates.filter(Boolean)
    if (dates.length === 0) { toast.error('Pick at least one day that works for you'); return }
    setBusyId(id)
    api.appointments.propose(id, dates)
      .then(r => {
        toast.success(r.texted ? 'Sent your available days to the homeowner' : 'Saved — no phone on file to text')
        setProposeFor(null); setProposeDates(['', '', ''])
      })
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not send'))
      .finally(() => setBusyId(null))
  }, [proposeDates])

  const cells = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1)
    const start = new Date(first); start.setDate(1 - first.getDay())
    const out: Date[] = []
    for (let i = 0; i < 42; i++) { const d = new Date(start); d.setDate(start.getDate() + i); out.push(d) }
    return out.slice(0, out[35].getMonth() === cursor.getMonth() ? 42 : 35)
  }, [cursor])

  const monthLabel = cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
  const dayAppts = (byDay.get(selected) || []).slice().sort((a, b) => a.time_window.localeCompare(b.time_window))
  const upcoming = (appts || [])
    .filter(a => a.preferred_date >= todayKey && a.status !== 'cancelled' && a.status !== 'completed' && a.status !== 'no_show')
    .sort((a, b) => a.preferred_date.localeCompare(b.preferred_date))
    .slice(0, 6)

  return (
    <div className="min-h-full p-6" style={{ background: '#040810' }}>
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black text-white">Schedule</h1>
          <p className="mt-0.5 text-xs text-slate-400">Free inspections your homeowners booked from their roof reports.</p>
        </div>
      </div>

      {appts === null ? (
        <div className="flex h-64 items-center justify-center text-slate-400">Loading…</div>
      ) : (
        <div className="grid gap-5 xl:grid-cols-[1.7fr_1fr]">
          {/* Calendar */}
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5"
            style={{ boxShadow: '0 8px 40px rgba(0,0,0,0.35)' }}>
            <div className="mb-4 flex items-center justify-between">
              <div className="text-lg font-bold text-white">{monthLabel}</div>
              <div className="flex items-center gap-1.5">
                <button onClick={() => setCursor(c => new Date(c.getFullYear(), c.getMonth() - 1, 1))}
                  className="rounded-lg bg-white/5 px-3 py-1.5 text-sm text-slate-300 ring-1 ring-white/10 hover:bg-white/10">‹</button>
                <button onClick={() => { const d = new Date(); setCursor(new Date(d.getFullYear(), d.getMonth(), 1)); setSelected(todayKey) }}
                  className="rounded-lg bg-blue-600/20 px-3 py-1.5 text-xs font-semibold text-blue-300 ring-1 ring-blue-500/30 hover:bg-blue-600/30">Today</button>
                <button onClick={() => setCursor(c => new Date(c.getFullYear(), c.getMonth() + 1, 1))}
                  className="rounded-lg bg-white/5 px-3 py-1.5 text-sm text-slate-300 ring-1 ring-white/10 hover:bg-white/10">›</button>
              </div>
            </div>
            <div className="grid grid-cols-7 gap-1.5">
              {DOW.map(d => <div key={d} className="pb-1.5 text-center text-[11px] font-semibold uppercase tracking-wider text-slate-500">{d}</div>)}
              {cells.map(d => {
                const key = toKey(d)
                const inMonth = d.getMonth() === cursor.getMonth()
                const items = byDay.get(key) || []
                const active = items.filter(a => a.status !== 'cancelled')
                const isToday = key === todayKey
                const isSel = key === selected
                return (
                  <button key={key} onClick={() => setSelected(key)}
                    className={`flex h-[120px] flex-col overflow-hidden rounded-xl border p-2 text-left transition ${
                      isSel ? 'border-blue-400/70 bg-blue-500/15 ring-1 ring-blue-400/40'
                        : 'border-white/5 hover:border-white/20 hover:bg-white/[0.04]'
                    } ${inMonth ? '' : 'opacity-35'}`}>
                    <span className={`text-sm font-bold ${isToday ? 'flex h-6 w-6 items-center justify-center rounded-full bg-blue-600 text-white' : 'text-slate-300'}`}>{d.getDate()}</span>
                    {/* Fixed-height cell: show a few condensed one-line chips, then
                        a "+N more" so a busy day never grows or spills into its
                        neighbours. Full list is in the day panel on the right. */}
                    <div className="mt-1 flex min-h-0 flex-1 flex-col gap-0.5">
                      {active.slice(0, 3).map(a => (
                        <div key={a.id} className={`flex items-center gap-1 rounded px-1.5 py-0.5 ring-1 ${STATUS_STYLE[a.status].chip}`}>
                          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_STYLE[a.status].dot}`} />
                          <span className="truncate text-[10.5px] font-semibold leading-tight">{a.homeowner_name || 'Homeowner'}</span>
                        </div>
                      ))}
                      {active.length > 3 && (
                        <span className="pl-1 text-[10px] font-semibold text-slate-400">+{active.length - 3} more</span>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Right rail: reminders + day panel */}
          <div className="space-y-5">
            {/* Upcoming reminders widget */}
            <div className="rounded-2xl border border-blue-400/20 bg-blue-500/[0.06] p-4">
              <div className="mb-2 flex items-center gap-2">
                <span className="text-sm font-semibold text-white">🔔 Upcoming inspections</span>
                {upcoming.length > 0 && <span className="rounded-full bg-blue-500/20 px-2 py-0.5 text-[11px] font-semibold text-blue-300">{upcoming.length}</span>}
              </div>
              {upcoming.length === 0 ? (
                <p className="py-2 text-xs text-slate-400">No upcoming inspections booked.</p>
              ) : (
                <div className="space-y-1.5">
                  {upcoming.map(a => (
                    <button key={a.id} onClick={() => { setSelected(a.preferred_date); setCursor(new Date(new Date(a.preferred_date + 'T00:00:00').getFullYear(), new Date(a.preferred_date + 'T00:00:00').getMonth(), 1)) }}
                      className="flex w-full items-center gap-2 rounded-lg bg-white/[0.03] px-2.5 py-2 text-left ring-1 ring-white/5 hover:bg-white/[0.06]">
                      <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_STYLE[a.status].dot}`} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs font-semibold text-white">{a.homeowner_name || 'Homeowner'}</div>
                        <div className="truncate text-[11px] text-slate-400">{a.address || '—'}</div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="text-[11px] font-semibold text-blue-300">{relDay(a.preferred_date)}</div>
                        <div className="text-[10px] text-slate-500">{WINDOW_LABEL[a.time_window]}</div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Selected-day detail */}
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
              <div className="mb-3 text-sm font-semibold text-white">
                {new Date(selected + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
              </div>
              {dayAppts.length === 0 ? (
                <p className="py-8 text-center text-xs text-slate-500">No inspections booked this day.</p>
              ) : (
                <div className="space-y-3">
                  {dayAppts.map(a => {
                    const st = STATUS_STYLE[a.status]
                    const L = a.lead
                    return (
                      <div key={a.id} className="rounded-xl bg-white/[0.03] p-3.5 ring-1 ring-white/5">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-bold text-white">{a.homeowner_name || 'Homeowner'}</span>
                              {L?.lead_score != null && (
                                <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${L.lead_score >= 70 ? 'bg-orange-500/15 text-orange-300' : L.lead_score >= 40 ? 'bg-amber-500/15 text-amber-300' : 'bg-white/10 text-slate-400'}`}>
                                  {L.lead_score >= 70 ? '🔥 ' : ''}{L.lead_score}
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] text-slate-400">🕑 {WINDOW_LABEL[a.time_window] || a.time_window}{a.address && <> · {a.address}</>}</div>
                          </div>
                          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ${st.chip}`}>{st.label}</span>
                        </div>

                        {/* Roof intelligence from the homeowner's report */}
                        {L && (L.work_type || L.condition || L.roof_age || (L.issues?.length ?? 0) > 0 || L.squares || L.price_low) && (
                          <div className="mt-2.5 rounded-lg bg-black/20 p-2.5">
                            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">What the homeowner told us</div>
                            <div className="flex flex-wrap gap-1.5">
                              {L.work_type && <span className="rounded-full bg-blue-500/15 px-2 py-0.5 text-[11px] text-blue-200">{WORK_LABEL[L.work_type] || L.work_type}</span>}
                              {L.condition && <span className={`rounded-full px-2 py-0.5 text-[11px] ${L.condition === 'visible_damage' ? 'bg-rose-500/15 text-rose-300' : 'bg-white/10 text-slate-300'}`}>{COND_LABEL[L.condition] || L.condition}</span>}
                              {L.roof_age && <span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-slate-300">Age: {L.roof_age} yrs</span>}
                              {L.stories != null && <span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-slate-300">{L.stories} stor{L.stories === 1 ? 'y' : 'ies'}</span>}
                              {(L.issues || []).map(i => (
                                <span key={i} className={`rounded-full px-2 py-0.5 text-[11px] ${i === 'leak' || i === 'storm_damage' ? 'bg-rose-500/15 text-rose-300' : 'bg-white/10 text-slate-300'}`}>{ISSUE_LABEL[i] || i}</span>
                              ))}
                              {L.chimney_skylights && <span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-slate-300">🧱 Chimney/skylights</span>}
                            </div>
                            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-400">
                              {L.squares != null && <span>📐 <strong className="text-slate-200">{L.squares}</strong> squares{L.roof_sqft ? ` · ${Math.round(L.roof_sqft).toLocaleString()} ft²` : ''}</span>}
                              {L.price_low != null && L.price_high != null && <span>💵 Quoted <strong className="text-slate-200">{money(L.price_low)}–{money(L.price_high)}</strong></span>}
                            </div>
                          </div>
                        )}
                        {a.homeowner_note && <div className="mt-2 text-[11px] italic text-slate-400">“{a.homeowner_note}”</div>}
                        {a.contractor_note && <div className="mt-1 text-[11px] text-blue-300/80">{a.contractor_note}</div>}

                        {/* Actions */}
                        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                          {a.homeowner_phone && (
                            <a href={`tel:${a.homeowner_phone}`} className="rounded-lg bg-emerald-500/15 px-2.5 py-1 text-[11px] font-medium text-emerald-300 ring-1 ring-emerald-500/30 hover:bg-emerald-500/25">Call</a>
                          )}
                          {(L?.report_token || a.report_token) && (
                            <a href={`/r/${L?.report_token || a.report_token}`} target="_blank" rel="noreferrer" className="rounded-lg bg-white/5 px-2.5 py-1 text-[11px] font-medium text-slate-300 ring-1 ring-white/10 hover:bg-white/10">Report</a>
                          )}
                          {ACTIONS[a.status].map(act => (
                            <button key={act.to} onClick={() => setStatus(a.id, act.to)} disabled={busyId === a.id}
                              className={`rounded-lg px-2.5 py-1 text-[11px] font-medium ring-1 disabled:opacity-40 ${act.tone === 'emerald' ? 'bg-emerald-600/20 text-emerald-300 ring-emerald-500/30 hover:bg-emerald-600/30' : 'bg-white/5 text-slate-200 ring-white/10 hover:bg-white/10'}`}>
                              {act.label}
                            </button>
                          ))}
                          {(a.status === 'requested' || a.status === 'confirmed') && (
                            <button onClick={() => { setProposeFor(proposeFor === a.id ? null : a.id); setProposeDates(['', '', '']) }}
                              className="rounded-lg bg-white/5 px-2.5 py-1 text-[11px] font-medium text-slate-300 ring-1 ring-white/10 hover:bg-white/10">
                              Can’t make it?
                            </button>
                          )}
                        </div>

                        {/* Propose alternative days */}
                        {proposeFor === a.id && (
                          <div className="mt-2.5 rounded-lg border border-blue-400/20 bg-blue-500/[0.06] p-2.5">
                            <div className="mb-1.5 text-[11px] font-semibold text-blue-200">Propose days that work for you — we’ll text them to {(a.homeowner_name || 'the homeowner').split(' ')[0]}</div>
                            <div className="flex flex-wrap gap-1.5">
                              {proposeDates.map((d, i) => (
                                <input key={i} type="date" value={d} min={todayKey}
                                  onChange={e => setProposeDates(prev => prev.map((x, j) => j === i ? e.target.value : x))}
                                  className="rounded-lg border border-slate-600 bg-slate-800 px-2 py-1.5 text-[11px] text-white [color-scheme:dark]" />
                              ))}
                            </div>
                            <button onClick={() => sendPropose(a.id)} disabled={busyId === a.id}
                              className="mt-2 rounded-lg bg-blue-600 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-blue-500 disabled:opacity-50">
                              {busyId === a.id ? 'Sending…' : '📲 Text these days to homeowner'}
                            </button>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
