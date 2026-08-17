'use client'

/**
 * The morning briefing — the first thing on the dashboard.
 *
 * This lived inside Dispatch, which meant it only spoke for the board: crews,
 * capacity, weather. That's half a contractor's morning, and it was buried a
 * click away from where anyone starts their day. It now leads the dashboard and
 * covers both halves of the business — the work that's booked, and the money
 * that hasn't been chased.
 *
 * Every number here is engine-computed (`crm_pulse.py`, the dispatch brief
 * endpoint). Nothing is invented client-side, and each half degrades on its own:
 * if the board is unreachable the CRM read still renders, and vice versa.
 */
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { api, type CRMPulse } from '@/lib/api'

const money = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)

const STAGE_LABEL: Record<string, string> = {
  new: 'new', contacted: 'contacted', site_visit: 'site visit',
  estimate_sent: 'estimate sent', won: 'won', lost: 'lost',
}

export default function MorningBriefing() {
  const { data: pulse, isLoading, isError } = useQuery<CRMPulse>({
    queryKey: ['crm-pulse'],
    queryFn: () => api.crm.pulse(),
    // Fresh enough for a morning read; the app-wide cache keeps it painted
    // instantly when the user comes back to the dashboard.
    staleTime: 5 * 60_000,
  })

  const greeting = (() => {
    const h = new Date().getHours()
    if (h < 12) return 'This morning'
    if (h < 17) return 'This afternoon'
    return 'Tonight'
  })()

  return (
    <section
      className="mb-8 overflow-hidden rounded-2xl border border-white/10"
      style={{ background: 'linear-gradient(135deg, rgba(59,130,246,0.10) 0%, rgba(255,255,255,0.03) 55%)' }}
    >
      <div className="flex items-center justify-between gap-3 border-b border-white/[0.07] px-5 py-3">
        <div className="flex items-center gap-2">
          <span className="text-base leading-none">☀</span>
          <h2 className="text-sm font-bold text-white">{greeting}</h2>
          <span className="rounded-full bg-blue-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-300">
            Briefing
          </span>
        </div>
        <Link href="/crm" className="text-xs font-medium text-blue-400 transition-colors hover:text-blue-300">
          Open CRM →
        </Link>
      </div>

      <div className="p-5">
        {isLoading ? (
          <div className="space-y-2">
            <div className="h-3.5 w-2/3 animate-pulse rounded bg-white/10" />
            <div className="h-3.5 w-1/2 animate-pulse rounded bg-white/[0.07]" />
          </div>
        ) : isError || !pulse ? (
          // A briefing that can't load must not look like a business with no work.
          <p className="text-sm text-slate-400">
            Couldn&apos;t reach your pipeline just now — the numbers below are still accurate.
          </p>
        ) : pulse.total === 0 ? (
          <p className="text-sm text-slate-300">
            No leads in the CRM yet.{' '}
            <Link href="/crm" className="font-semibold text-blue-400 hover:text-blue-300">Add your first lead</Link>{' '}
            and this briefing will start tracking what needs chasing.
          </p>
        ) : (
          <>
            <div className="mb-4 grid gap-3 sm:grid-cols-3">
              <Figure label="Open pipeline" value={money(pulse.open_value)} sub={`${pulse.open_count} live lead${pulse.open_count === 1 ? '' : 's'}`} />
              <Figure label="Won" value={money(pulse.won_value)} sub={pulse.win_rate_pct != null ? `${pulse.win_rate_pct}% win rate` : 'no closed leads yet'} />
              <Figure
                label="Needs chasing"
                value={String(pulse.stale_count)}
                sub={pulse.stale_count === 0 ? 'all leads are current' : 'gone quiet too long'}
                tone={pulse.stale_count > 0 ? 'warn' : 'ok'}
              />
            </div>

            {pulse.lines.length > 0 && (
              <ul className="mb-3 space-y-1.5">
                {pulse.lines.map((line, i) => (
                  <li key={i} className="flex gap-2 text-[13px] leading-relaxed text-slate-300">
                    <span className="mt-[7px] h-1 w-1 flex-shrink-0 rounded-full bg-blue-400" />
                    {line}
                  </li>
                ))}
              </ul>
            )}

            {pulse.stale.length > 0 && (
              <div className="rounded-xl border border-amber-400/20 bg-amber-500/[0.06] p-3">
                <div className="mb-2 text-[11px] font-bold uppercase tracking-wide text-amber-300">
                  Call these first
                </div>
                <ul className="space-y-1">
                  {pulse.stale.map(lead => (
                    <li key={lead.id} className="flex items-center justify-between gap-3 text-[13px]">
                      <span className="min-w-0 truncate text-slate-200">{lead.name}</span>
                      <span className="flex-shrink-0 text-[11px] text-slate-400">
                        {lead.value > 0 && <span className="mr-2 font-semibold text-emerald-400">{money(lead.value)}</span>}
                        {lead.days}d in {STAGE_LABEL[lead.stage] || lead.stage}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  )
}

function Figure({ label, value, sub, tone = 'ok' }: {
  label: string; value: string; sub: string; tone?: 'ok' | 'warn'
}) {
  return (
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.03] px-4 py-3">
      <div className="text-[11px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`mt-0.5 text-xl font-bold leading-none ${tone === 'warn' ? 'text-amber-300' : 'text-white'}`}>
        {value}
      </div>
      <div className="mt-1 text-[11px] text-slate-500">{sub}</div>
    </div>
  )
}
