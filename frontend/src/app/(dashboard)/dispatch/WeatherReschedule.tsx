'use client'

/**
 * Weather reschedule — the "clear a rain day in one click" flow. Polls the visible
 * range for jobs sitting on a high-risk rain day and, if any, shows a banner. Open
 * it to see each job's proposed dry-day home (earliest slot that fits, spread so the
 * day's work doesn't all stack onto one crew). Approve/skip per job, then Apply runs
 * one transaction (all-or-nothing on a block) with a single Undo.
 */
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { bulkUndo, fetchWeatherImpact, reschedule, type AffectedMulti, type Crew, type LoadState, type RescheduleSuggestion } from './lib/board'

const jobTypeLabel = (t: string) => t.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase())
const STATE_COLOR: Record<LoadState, string> = {
  IDLE: 'var(--idle)', LIGHT: 'var(--sky)', BALANCED: 'var(--balanced)', TIGHT: 'var(--tight)', OVERBOOKED: 'var(--over)',
}
const fmtDate = (d: string | null) => (d ? d.slice(5) : '—')

export default function WeatherReschedule({
  start, end, crews, onApplied, onInvalidate, autoOpen,
}: {
  start: string; end: string; crews: Crew[]
  onApplied: (aff: AffectedMulti) => void
  onInvalidate: () => void
  /** Opened straight from the morning briefing's rain line. */
  autoOpen?: boolean
}) {
  const [open, setOpen] = useState(!!autoOpen)
  const [skip, setSkip] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const { data } = useQuery({ queryKey: ['weather-impact', start, end], queryFn: () => fetchWeatherImpact(start, end), staleTime: 60_000 })

  const crewName = (id: string | null) => (id ? crews.find(c => c.id === id)?.name ?? 'crew' : '—')
  const resolvable = useMemo(() => (data?.suggestions ?? []).filter(s => s.ok), [data])
  const chosen = useMemo(() => resolvable.filter(s => !skip.has(s.appointment_id)), [resolvable, skip])

  const rank: Record<string, number> = { light: 1, wind: 2, steady: 3, heavy: 4 }
  const worst = (data?.risk_days ?? [])
    .map(d => d.worst)
    .filter(Boolean)
    .sort((a, b) => (rank[b!.band] ?? 0) - (rank[a!.band] ?? 0))[0]
  const worstBand = worst?.band
  const headline = worst?.summary

  if (!data || data.at_risk_count === 0) return null

  async function apply() {
    const moves = chosen.filter(s => s.to).map(s => ({ appointment_id: s.appointment_id, crew_id: s.to!.crew_id, date: s.to!.date }))
    if (moves.length === 0) return
    setBusy(true)
    try {
      const res = await reschedule(moves, false)
      if (!res.applied) { toast.error('Blocked — a slot conflicts. Adjust and retry.'); return }
      if (res.affected) onApplied(res.affected)
      const batch = res.batch_id
      setOpen(false); onInvalidate()
      toast((t) => (
        <span className="flex items-center gap-3 text-[13px]">
          Rescheduled {moves.length} job{moves.length === 1 ? '' : 's'} off the rain.
          <button className="font-bold underline" onClick={async () => {
            toast.dismiss(t.id)
            if (!batch) return
            try { const u = await bulkUndo(batch); onApplied(u.affected); onInvalidate() }
            catch { toast.error('Undo failed.') }
          }}>Undo</button>
        </span>
      ), { duration: 15000 })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not reschedule')
    } finally { setBusy(false) }
  }

  return (
    <>
      {/* Banner */}
      <button onClick={() => setOpen(true)}
        className="flex w-full items-center gap-3 border-b px-4 py-2 text-left transition-colors hover:bg-[#eeeeed]"
        style={{ borderColor: 'var(--line)', background: 'color-mix(in srgb, var(--tight) 10%, var(--ink))' }}>
        <span className="text-[15px]">{worstBand === 'heavy' ? '⛈' : worstBand === 'wind' ? '💨' : '🌧'}</span>
        <span className="text-[13px] font-semibold">
          {data.at_risk_count} job{data.at_risk_count === 1 ? '' : 's'} facing weather
          {headline && <span className="ml-2 font-normal" style={{ color: 'var(--muted)' }}>— {headline}</span>}
          <span className="ml-2 font-normal" style={{ color: 'var(--muted)' }}>
            {data.resolvable === data.at_risk_count
              ? `· ${data.resolvable} could move to a clear day`
              : `· ${data.resolvable} movable, ${data.at_risk_count - data.resolvable} need a manual call`}
          </span>
        </span>
        <span className="ml-auto rounded-full px-3 py-1 text-[12px] font-bold" style={{ background: 'var(--dawn)', color: '#ffffff' }}>See options</span>
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={() => setOpen(false)}>
          <div className="flex h-full w-full max-w-lg flex-col border-l shadow-2xl" onClick={e => e.stopPropagation()}
            style={{ background: 'var(--panel)', borderColor: 'var(--line)' }}>
            <div className="flex items-center justify-between border-b px-5 py-3" style={{ borderColor: 'var(--line)' }}>
              <div>
                <div className="text-[15px] font-bold">Weather on the schedule</div>
                <div className="text-[12px]" style={{ color: 'var(--muted)' }}>
                  {data.risk_days.map(d => `${fmtDate(d.date)} · ${d.summary ?? `${d.precip_probability ?? '—'}%`}`).join('   ')}
                </div>
                <div className="mt-0.5 text-[11px]" style={{ color: 'var(--muted)' }}>
                  Forecast at each job&apos;s own address. Nothing moves until you confirm.
                </div>
              </div>
              <button onClick={() => setOpen(false)} className="rounded-md px-2 py-1 text-sm hover:bg-[#eeeeed]">✕</button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <div className="space-y-1.5">
                {(data.suggestions).map(s => <PlanRow key={s.appointment_id} s={s} crewName={crewName}
                  skipped={skip.has(s.appointment_id)} onToggle={() => setSkip(prev => { const n = new Set(prev); n.has(s.appointment_id) ? n.delete(s.appointment_id) : n.add(s.appointment_id); return n })} />)}
              </div>
            </div>

            <div className="flex items-center justify-between border-t px-5 py-3" style={{ borderColor: 'var(--line)' }}>
              <span className="text-[12px]" style={{ color: 'var(--muted)' }}>{chosen.length} of {resolvable.length} selected</span>
              <div className="flex gap-2">
                <button onClick={() => setOpen(false)} className="rounded-md px-3 py-1.5 text-[12px] font-semibold hover:bg-[#eeeeed]" style={{ color: 'var(--muted)' }}>Cancel</button>
                <button onClick={apply} disabled={busy || chosen.length === 0}
                  className="rounded-md px-4 py-1.5 text-[12px] font-bold disabled:opacity-40"
                  style={{ background: 'var(--dawn)', color: '#ffffff' }}>
                  Reschedule {chosen.length} job{chosen.length === 1 ? '' : 's'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function PlanRow({ s, crewName, skipped, onToggle }: { s: RescheduleSuggestion; crewName: (id: string | null) => string; skipped: boolean; onToggle: () => void }) {
  const stColor = s.resulting_state ? STATE_COLOR[s.resulting_state] : 'var(--muted)'
  return (
    <div className="flex items-center gap-3 rounded-md px-3 py-2 text-[12px]" style={{ background: 'var(--panel2)', opacity: skipped ? 0.5 : 1 }}>
      {s.ok ? (
        <button onClick={onToggle} title={skipped ? 'Include' : 'Skip'}
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] border text-[9px] font-bold leading-none"
          style={{ borderColor: skipped ? 'var(--line)' : 'var(--dawn)', background: skipped ? 'transparent' : 'var(--dawn)', color: skipped ? 'transparent' : '#ffffff' }}>✓</button>
      ) : <span className="flex h-4 w-4 shrink-0 items-center justify-center text-[11px]" style={{ color: 'var(--over)' }}>⃠</span>}

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px]" style={{ color: 'var(--muted)' }}>#{s.job_number ?? '—'}</span>
          <span className="truncate font-semibold">{s.job_type ? jobTypeLabel(s.job_type) : ''}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5" style={{ color: 'var(--muted)' }}>
          <span>{crewName(s.from.crew_id)} {fmtDate(s.from.date)}</span>
          {s.to ? (
            <>
              <span style={{ color: 'var(--sky)' }}>→</span>
              <span className="font-semibold" style={{ color: 'var(--text)' }}>{crewName(s.to.crew_id)} {fmtDate(s.to.date)}</span>
            </>
          ) : <span style={{ color: 'var(--over)' }}> · {s.reason}</span>}
        </div>
      </div>

      {s.to && s.resulting_state && (
        <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold tabular-nums" style={{ background: `color-mix(in srgb, ${stColor} 18%, transparent)`, color: stColor }} title={s.reason}>
          {s.resulting_pct}%
        </span>
      )}
    </div>
  )
}
