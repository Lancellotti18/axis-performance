'use client'

/**
 * The morning briefing — the first thing on the dashboard.
 *
 * Written for an owner-operator: someone who sells AND runs the crews, reading
 * this on a phone at 6:30am. Their question is "what do I do first, and who do
 * I call", so every line is a decision. Ordering is by how fast the opportunity
 * decays, not by how interesting it is — an accepted proposal nobody has called
 * back outranks a lead going quiet, which outranks half-finished paperwork.
 *
 * Two parts, doing different jobs. The figures across the top are the money
 * glance — pipeline, won, how many leads are slipping — which an owner-operator
 * wants before anything else. Under them is the action list, where every line
 * is a decision.
 *
 * The distinction that matters: a compact header of three numbers is a glance,
 * and glances are fine. What isn't fine is mixing STATUS into the action list
 * itself — crew utilization, funnel counts, win-rate history. That's what turns
 * a briefing into wallpaper, and once it's wallpaper the urgent lines stop
 * landing too. Those live on the pages that own them.
 *
 * The whole thing is one request (`/briefing/today`), assembled and capped
 * server-side, with each source failing independently — see services/briefing.py.
 */
import { useCallback, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api, type BriefingItem, type CRMPulse } from '@/lib/api'

const money = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)

const KIND_STYLE: Record<BriefingItem['kind'], { dot: string; label: string }> = {
  accepted:   { dot: 'bg-emerald-400', label: 'Accepted' },
  new_client: { dot: 'bg-blue-400',    label: 'New lead' },
  waiting:  { dot: 'bg-amber-400',   label: 'Waiting on you' },
  weather:  { dot: 'bg-sky-400',     label: 'Weather' },
  cold:     { dot: 'bg-rose-400',    label: 'Going cold' },
  stuck:    { dot: 'bg-slate-400',   label: 'Unfinished' },
}

export default function MorningBriefing() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['briefing-today'],
    queryFn: () => api.briefing.today(),
    staleTime: 5 * 60_000,
  })

  // Snoozing is per-user state, not a rendering preference, so it lives on the
  // server — a line put away in the truck stays away at the office.
  // The money glance. Separate call from the action list on purpose: if the
  // briefing assembly is slow or down, these numbers still paint.
  const { data: pulse } = useQuery<CRMPulse>({
    queryKey: ['crm-pulse'],
    queryFn: () => api.crm.pulse(),
    staleTime: 5 * 60_000,
  })

  const qc = useQueryClient()
  const [pending, setPending] = useState<string[]>([])
  const { mutate: snoozeItem } = useMutation({
    mutationFn: (key: string) => api.briefing.snooze(key),
    onSettled: () => { qc.invalidateQueries({ queryKey: ['briefing-today'] }) },
  })
  const snooze = useCallback((key: string) => {
    // Hide it immediately; the refetch confirms it.
    setPending(p => [...p, key])
    snoozeItem(key)
  }, [snoozeItem])

  const items = useMemo(
    () => (data?.items || []).filter(i => !pending.includes(i.key)),
    [data, pending],
  )

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
        {items.length > 0 && (
          <span className="text-[11px] text-slate-400">{items.length} to action</span>
        )}
      </div>

      {pulse && pulse.total > 0 && (
        <div className="grid gap-3 border-b border-white/[0.07] px-5 py-4 sm:grid-cols-3">
          <Figure label="Open pipeline" value={money(pulse.open_value)}
            sub={`${pulse.open_count} live lead${pulse.open_count === 1 ? '' : 's'}`} />
          <Figure label="Won" value={money(pulse.won_value)}
            sub={pulse.win_rate_pct != null ? `${pulse.win_rate_pct}% win rate` : 'no closed leads yet'} />
          <Figure label="Needs chasing" value={String(pulse.stale_count)}
            sub={pulse.stale_count === 0 ? 'all leads are current' : 'gone quiet too long'}
            tone={pulse.stale_count > 0 ? 'warn' : 'ok'} />
        </div>
      )}

      <div className="p-5">
        {isLoading ? (
          <div className="space-y-2">
            <div className="h-3.5 w-2/3 animate-pulse rounded bg-white/10" />
            <div className="h-3.5 w-1/2 animate-pulse rounded bg-white/[0.07]" />
          </div>
        ) : isError ? (
          // Never imply an empty business when we simply couldn't read it.
          <p className="text-sm text-slate-400">
            Couldn&apos;t put your briefing together just now — the numbers below are still accurate.
          </p>
        ) : items.length === 0 ? (
          // A quiet morning is a real answer and worth saying plainly.
          <p className="text-sm text-slate-300">
            ✅ Nothing needs your attention this morning. Nobody&apos;s waiting on a reply, no leads have gone quiet,
            and tomorrow&apos;s weather is clear for the crews that are booked.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {items.map(item => {
              const style = KIND_STYLE[item.kind] || KIND_STYLE.stuck
              const body = (
                <>
                  <span className={`mt-[7px] h-1.5 w-1.5 flex-shrink-0 rounded-full ${style.dot}`} />
                  <span className="min-w-0 flex-1 text-[13px] leading-relaxed text-slate-200">{item.text}</span>
                </>
              )
              return (
                <li key={item.key} className="group flex items-start gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-white/[0.04]">
                  {item.href
                    ? <Link href={item.href} className="flex min-w-0 flex-1 items-start gap-2">{body}</Link>
                    : <span className="flex min-w-0 flex-1 items-start gap-2">{body}</span>}
                  <button
                    onClick={() => snooze(item.key)}
                    title="Snooze for a week"
                    aria-label={`Snooze: ${item.text}`}
                    className="flex-shrink-0 rounded px-1.5 py-0.5 text-[11px] text-slate-500 opacity-0 transition-opacity hover:bg-white/10 hover:text-slate-200 group-hover:opacity-100"
                  >snooze</button>
                </li>
              )
            })}
          </ul>
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
