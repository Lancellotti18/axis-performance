'use client'

/**
 * Dashboard card: booked crews facing rain or wind in the next week, each with
 * the dry day dispatch proposes. The briefing already flags the rain day; this
 * puts the proposed fix next to it. "Review & move" opens the board's one-click
 * reschedule on that day, where every move can be approved, skipped or undone.
 * Renders nothing when the week is clear.
 */
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { fetchWeatherImpact } from '@/app/(dashboard)/dispatch/lib/board'

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const day = (s: string | null) => s ? new Date(s + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : '—'
const jobType = (t: string | null) => (t || 'Job').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase())

export default function WeatherConflicts() {
  const now = new Date()
  const start = iso(now)
  const end = iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7))
  const { data } = useQuery({
    queryKey: ['weather-impact', start, end],
    queryFn: () => fetchWeatherImpact(start, end),
    staleTime: 5 * 60_000,
    retry: false,
  })
  if (!data || data.at_risk_count === 0) return null

  const why = new Map(data.risk_days.map(d => [d.date, d.worst?.summary || d.summary || (d.precip_probability != null ? `${Math.round(d.precip_probability)}% rain` : 'rain')]))
  const rows = data.suggestions.slice(0, 5)
  const firstDay = data.risk_days[0]?.date

  return (
    <div className="mb-6 rounded-2xl border border-sky-300/50 bg-sky-50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-sky-900">
            🌧 {data.at_risk_count} booked job{data.at_risk_count === 1 ? '' : 's'} facing bad weather this week
          </div>
          <div className="text-[11px] text-sky-800">Proposed dry days below — nothing moves until you approve it.</div>
        </div>
        {firstDay && (
          <Link href={`/dispatch?date=${firstDay}&reschedule=1`}
            className="rounded-lg bg-sky-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-800">Review &amp; move</Link>
        )}
      </div>
      <div className="mt-3 space-y-1.5">
        {rows.map(s => (
          <div key={s.appointment_id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-lg bg-white px-3 py-2 text-xs ring-1 ring-sky-200">
            <span className="font-semibold text-[#1a1a1a]">{jobType(s.job_type)}{s.job_number != null ? ` #${s.job_number}` : ''}</span>
            <span className="text-[#6b7280]">{day(s.from.date)} · {why.get(s.from.date || '') || 'bad weather'}</span>
            <span className="ml-auto font-semibold">
              {s.ok && s.to
                ? <span className="text-emerald-700">→ {day(s.to.date)}</span>
                : <span className="text-amber-700">No open dry day — {s.reason || 'move by hand'}</span>}
            </span>
          </div>
        ))}
        {data.suggestions.length > rows.length && (
          <div className="pl-1 text-[11px] text-sky-800">+{data.suggestions.length - rows.length} more on the board</div>
        )}
      </div>
    </div>
  )
}
