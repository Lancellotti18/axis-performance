'use client'

/**
 * FlashingPanel — Flashing Intelligence review.
 *
 * Calls /api/v1/roofing/v2/runs/{id}/flashing, which derives every flashing
 * requirement DETERMINISTICALLY from the contractor's confirmed facets, edges
 * (wall_intersection, valley), and penetrations (chimney, skylight). Each
 * requirement is explainable (shows the exact source) and reviewable — the
 * contractor accepts or dismisses each, and the confirmed set rolls up into a
 * flashing summary that feeds the report's material order.
 *
 * This realizes the "flashing intelligence" vision: the AI/geometry identifies
 * WHERE flashing is needed (roof-to-wall transitions, valleys, chimneys) and
 * the engine computes HOW MUCH — step, counter, apron, kickout, valley metal,
 * chimney/skylight kits, crickets — with zero hallucinated quantities.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '@/lib/api'

interface Props {
  runId: string
  /** notified with the confirmed flashing totals so the report can include them */
  onConfirmedChange?: (totals: Record<string, number>, confirmedIds: string[]) => void
}

type Req = Awaited<ReturnType<typeof api.roofing.v2.getFlashing>>['requirements'][number]

const TYPE_META: Record<string, { label: string; color: string; blurb: string }> = {
  step:     { label: 'Step flashing',    color: '#f59e0b', blurb: 'Sloped roof-to-wall — one piece per shingle course' },
  counter:  { label: 'Counter flashing', color: '#fbbf24', blurb: 'Caps step/apron, set into the wall' },
  apron:    { label: 'Apron flashing',   color: '#fb923c', blurb: 'Horizontal roof-to-wall (low side)' },
  headwall: { label: 'Headwall flashing',color: '#fb923c', blurb: 'Horizontal roof-to-wall (high side)' },
  kickout:  { label: 'Kickout',          color: '#ef4444', blurb: 'Diverts water off the wall at the base of a run' },
  valley:   { label: 'Valley metal',     color: '#3b82f6', blurb: 'Lines each valley' },
  chimney:  { label: 'Chimney kit',      color: '#a855f7', blurb: 'Apron + step sides + back' },
  skylight: { label: 'Skylight kit',     color: '#06b6d4', blurb: 'Head + sill + step sides' },
  cricket:  { label: 'Cricket / saddle', color: '#8b5cf6', blurb: 'Behind a wide chimney (code-required > 30")' },
}

function ft(v: number): string {
  const f = Math.floor(v); const inch = Math.round((v - f) * 12)
  return inch === 12 ? `${f + 1}' 0"` : `${f}' ${inch}"`
}

export default function FlashingPanel({ runId, onConfirmedChange }: Props) {
  const [reqs, setReqs] = useState<Req[]>([])
  const [totals, setTotals] = useState<Record<string, number>>({})
  const [message, setMessage] = useState<string | null>(null)
  const [gaps, setGaps] = useState<NonNullable<Awaited<ReturnType<typeof api.roofing.v2.getFlashing>>['gaps']>>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [ran, setRan] = useState(false)

  const run = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await api.roofing.v2.getFlashing(runId)
      setReqs(res.requirements)
      setTotals(res.totals)
      setMessage(res.message)
      setGaps(res.gaps || [])
      setDismissed(new Set())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Flashing analysis failed')
    } finally {
      setLoading(false); setRan(true)
    }
  }, [runId])

  const confirmed = useMemo(() => reqs.filter(r => !dismissed.has(r.id)), [reqs, dismissed])

  // Recompute confirmed totals from the non-dismissed requirements + notify parent.
  const confirmedTotals = useMemo(() => {
    const t: Record<string, number> = {
      step_flashing_ft: 0, counter_flashing_ft: 0, apron_flashing_ft: 0,
      headwall_flashing_ft: 0, valley_flashing_ft: 0, wall_flashing_ft: 0,
      kickout_qty: 0, step_pieces: 0, chimney_qty: 0, skylight_qty: 0, cricket_qty: 0,
    }
    for (const r of confirmed) {
      if (r.type === 'step') { t.step_flashing_ft += r.length_ft; t.wall_flashing_ft += r.length_ft; t.step_pieces += r.pieces || 0 }
      else if (r.type === 'counter') t.counter_flashing_ft += r.length_ft
      else if (r.type === 'apron') { t.apron_flashing_ft += r.length_ft; t.wall_flashing_ft += r.length_ft }
      else if (r.type === 'headwall') { t.headwall_flashing_ft += r.length_ft; t.wall_flashing_ft += r.length_ft }
      else if (r.type === 'valley') t.valley_flashing_ft += r.length_ft
      else if (r.type === 'kickout') t.kickout_qty += r.quantity
      else if (r.type === 'chimney') t.chimney_qty += r.quantity
      else if (r.type === 'skylight') t.skylight_qty += r.quantity
      else if (r.type === 'cricket') t.cricket_qty += r.quantity
    }
    Object.keys(t).forEach(k => { if (k.endsWith('_ft')) t[k] = Math.round(t[k] * 100) / 100 })
    return t
  }, [confirmed])

  useEffect(() => {
    onConfirmedChange?.(confirmedTotals, confirmed.map(r => r.id))
  }, [confirmedTotals, confirmed, onConfirmedChange])

  return (
    <section className="rounded-lg border border-white/10 bg-slate-900/40 p-4 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">Flashing intelligence</h3>
          <p className="text-xs text-slate-400">
            Auto-derived from your roof-to-wall edges, valleys, and penetrations. Every line shows
            <strong> why</strong> it was added — dismiss anything that doesn&apos;t apply.
          </p>
        </div>
        <button
          onClick={run}
          disabled={loading}
          className="rounded bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-500 disabled:opacity-50"
        >{loading ? 'Analyzing…' : ran ? 'Re-analyze' : 'Detect flashing'}</button>
      </div>

      {error && <p className="mt-2 text-xs text-rose-400">{error}</p>}
      {message && !error && <p className="mt-2 text-xs text-slate-400">{message}</p>}

      {/* Ground-photo completeness: conditions the photos detected but that
          aren't reflected on the roof yet — so the flashing order isn't short. */}
      {gaps.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {gaps.map((g, i) => (
            <li key={i} className="rounded-md border border-amber-400/30 bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-200">
              📷 {g.message}
            </li>
          ))}
        </ul>
      )}

      {/* Confirmed totals */}
      {confirmed.length > 0 && (
        <div className="mt-3 grid grid-cols-2 gap-2 rounded-md border border-white/10 bg-slate-900/60 p-2 text-xs md:grid-cols-4">
          <Tot label="Step" v={`${ft(confirmedTotals.step_flashing_ft)} (${confirmedTotals.step_pieces} pc)`} />
          <Tot label="Counter" v={ft(confirmedTotals.counter_flashing_ft)} />
          <Tot label="Apron/headwall" v={ft(confirmedTotals.apron_flashing_ft + confirmedTotals.headwall_flashing_ft)} />
          <Tot label="Valley" v={ft(confirmedTotals.valley_flashing_ft)} />
          <Tot label="Kickouts" v={String(confirmedTotals.kickout_qty)} />
          <Tot label="Chimney kits" v={String(confirmedTotals.chimney_qty)} />
          <Tot label="Skylight kits" v={String(confirmedTotals.skylight_qty)} />
          <Tot label="Crickets" v={String(confirmedTotals.cricket_qty)} />
        </div>
      )}

      {/* Requirements list */}
      {reqs.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {reqs.map(r => {
            const meta = TYPE_META[r.type] ?? { label: r.type, color: '#94a3b8', blurb: '' }
            const off = dismissed.has(r.id)
            return (
              <li
                key={r.id}
                className={`flex items-center gap-3 rounded-md border p-2 transition ${off ? 'opacity-40' : ''}`}
                style={{ borderColor: `${meta.color}55` }}
              >
                <span className="inline-block h-3 w-3 shrink-0 rounded-full" style={{ background: meta.color }} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-slate-100">{meta.label}</span>
                    <span className="text-xs text-slate-300">
                      {r.measure === 'linear' ? ft(r.length_ft) : `×${r.quantity}`}
                      {r.pieces ? ` · ${r.pieces} pc` : ''}
                    </span>
                    {r.needs_review && (
                      <span className="rounded bg-amber-900/40 px-1.5 py-0.5 text-[9px] font-semibold text-amber-300">VERIFY</span>
                    )}
                  </div>
                  <div className="truncate text-[11px] text-slate-400">{r.source}</div>
                </div>
                <button
                  onClick={() => setDismissed(prev => {
                    const n = new Set(prev); n.has(r.id) ? n.delete(r.id) : n.add(r.id); return n
                  })}
                  className="shrink-0 rounded px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
                >{off ? 'Restore' : 'Dismiss'}</button>
              </li>
            )
          })}
        </ul>
      )}

      {ran && !loading && reqs.length === 0 && !error && (
        <div className="mt-3 rounded-md border border-amber-400/20 bg-amber-500/5 p-3 text-xs text-amber-100/90">
          <p>
            <strong>No flashing conditions yet</strong> — flashing is built from what&apos;s on the roof.
            Add the conditions, then it fills in automatically:
          </p>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-slate-300">
            <li><strong>Chimney / skylight</strong> → upload a ground photo and tap <em>Add</em> (step ①) — flows in automatically.</li>
            <li><strong>Roof meets a taller wall, or a dormer</strong> → label that roof edge as <em>wall intersection</em>.</li>
          </ul>
          <button
            onClick={() => {
              document.getElementById('roof-to-wall-panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
            }}
            className="mt-2 rounded bg-amber-600/90 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-600"
          >Label roof-to-wall edges →</button>
        </div>
      )}
    </section>
  )
}

function Tot({ label, v }: { label: string; v: string }) {
  return (
    <div className="rounded bg-slate-900/60 p-1.5">
      <div className="text-[9px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-xs font-semibold text-slate-100">{v}</div>
    </div>
  )
}
