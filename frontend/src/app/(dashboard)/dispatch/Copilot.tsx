'use client'

/**
 * Axis Copilot (M5.5) — the AI layer, kept to the guardrails in
 * docs/crew-scheduling-ai-layer.md: every number is engine-computed, the model
 * only narrates/ranks/compiles, and nothing applies without an approved dry-run.
 * Three surfaces:
 *   • Morning Brief — a 10-second read (Load / Gaps / Risk) pinned above the board.
 *   • Capacity flywheel — data-backed "this crew really lays 31/day" suggestions.
 *   • ⌘K command bar — type intent, get the exact dry-run, approve, one undo.
 * Every surface degrades to a clean "unavailable" and the board stays operable.
 */
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  bulkOp, bulkUndo, reschedule, fetchBrief, fetchThroughputReview, applyThroughput, planIntent,
  type AffectedMulti, type BriefItem, type Crew, type PlanResult, type ThroughputRow,
} from './lib/board'

const KIND_META: Record<string, { color: string; glyph: string }> = {
  LOAD_OVER: { color: 'var(--over)', glyph: '●' }, LOAD_IDLE: { color: 'var(--idle)', glyph: '○' },
  GAP: { color: 'var(--sky)', glyph: '◇' }, RISK_WEATHER: { color: 'var(--tight)', glyph: '⛈' },
  RISK_SERIES: { color: 'var(--tight)', glyph: '⧗' }, RISK_DEADLINE: { color: 'var(--over)', glyph: '⚑' },
}

export default function Copilot({
  start, end, crews, onApplied, onInvalidate,
}: {
  start: string; end: string; crews: Crew[]
  onApplied: (aff: AffectedMulti) => void
  onInvalidate: () => void
}) {
  const [barOpen, setBarOpen] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setBarOpen(true) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <>
      <BriefCard start={start} end={end} onOpenBar={() => setBarOpen(true)} onApplied={onApplied} onInvalidate={onInvalidate} />
      {barOpen && <CommandBar start={start} end={end} crews={crews} onClose={() => setBarOpen(false)} onApplied={onApplied} onInvalidate={onInvalidate} />}
    </>
  )
}

// ── Morning Brief + capacity flywheel ────────────────────────────────────────
function BriefCard({
  start, end, onOpenBar, onApplied, onInvalidate,
}: {
  start: string; end: string; onOpenBar: () => void
  onApplied: (aff: AffectedMulti) => void; onInvalidate: () => void
}) {
  const [dismissed, setDismissed] = useState(false)
  const { data: brief } = useQuery({ queryKey: ['ai-brief', start, end], queryFn: () => fetchBrief(start, end), staleTime: 5 * 60_000 })
  const { data: flywheel } = useQuery({ queryKey: ['ai-throughput'], queryFn: fetchThroughputReview, staleTime: 10 * 60_000 })
  const suggestions = flywheel?.suggestions ?? []

  if (dismissed || (!brief && suggestions.length === 0)) return null

  const items = brief ? [...brief.risk, ...brief.gaps, ...brief.load] : []

  return (
    <div className="border-b px-4 py-3" style={{ borderColor: 'var(--line)', background: 'color-mix(in srgb, var(--dawn) 5%, var(--ink))' }}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[12px] font-bold" style={{ background: 'var(--dawn)', color: '#1a0e05' }}>✦</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--dawn)' }}>Morning brief</span>
            {brief && !brief.narrated && <span className="text-[10px]" style={{ color: 'var(--muted)' }}>· offline summary</span>}
            <button onClick={onOpenBar} className="ml-auto rounded-md border px-2 py-0.5 text-[11px] font-semibold hover:bg-white/5" style={{ borderColor: 'var(--line)', color: 'var(--muted)' }}>⌘K to dispatch by voice</button>
            <button onClick={() => setDismissed(true)} className="rounded-md px-1.5 py-0.5 text-[12px]" style={{ color: 'var(--muted)' }}>✕</button>
          </div>
          <p className="mt-1 text-[13px] leading-snug" style={{ color: 'var(--text)' }}>{brief?.prose ?? 'The board’s clean for this range.'}</p>

          {items.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {items.slice(0, 8).map((it, i) => <BriefChip key={i} item={it} />)}
            </div>
          )}

          {suggestions.length > 0 && (
            <div className="mt-3 rounded-lg border p-2.5" style={{ borderColor: 'var(--line)', background: 'var(--panel)' }}>
              <div className="mb-1.5 flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--balanced)' }}>
                <span>⟳ Capacity flywheel</span>
                <span className="font-normal normal-case" style={{ color: 'var(--muted)' }}>learned from completed jobs</span>
              </div>
              <div className="space-y-1.5">
                {suggestions.map(s => <FlywheelRow key={s.crew_id} row={s} onInvalidate={onInvalidate} />)}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function BriefChip({ item }: { item: BriefItem }) {
  const m = KIND_META[item.kind] || { color: 'var(--muted)', glyph: '·' }
  return (
    <span className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px]" style={{ background: 'var(--panel)', color: 'var(--text)' }}>
      <span style={{ color: m.color }}>{m.glyph}</span>{item.text}
    </span>
  )
}

function FlywheelRow({ row, onInvalidate }: { row: ThroughputRow; onInvalidate: () => void }) {
  const [applying, setApplying] = useState(false)
  const [done, setDone] = useState(false)
  async function apply() {
    if (row.suggested_sqpd == null) return
    setApplying(true)
    try {
      await applyThroughput(row.crew_id, row.suggested_sqpd)
      setDone(true)
      toast.success(`${row.crew_name} capacity → ${row.suggested_sqpd} sq/day`)
      onInvalidate()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not update capacity') }
    finally { setApplying(false) }
  }
  return (
    <div className="flex items-center gap-3 text-[12px]">
      <span className="min-w-0 flex-1">{row.rationale}</span>
      {done ? <span className="shrink-0 text-[11px] font-semibold" style={{ color: 'var(--balanced)' }}>✓ updated</span> : (
        <button onClick={apply} disabled={applying} className="shrink-0 rounded-md px-2.5 py-1 text-[11px] font-bold disabled:opacity-50" style={{ background: 'var(--balanced)', color: '#04121f' }}>
          {row.configured_sqpd} → {row.suggested_sqpd}
        </button>
      )}
    </div>
  )
}

// ── ⌘K command bar ───────────────────────────────────────────────────────────
const EXAMPLES = [
  'Move everything off Thursday’s rain to the soonest dry day',
  'Reassign job 104 to the steep-slope crew',
  'Put Kevin’s Tuesday jobs on hold',
]

function CommandBar({
  start, end, crews, onClose, onApplied, onInvalidate,
}: {
  start: string; end: string; crews: Crew[]; onClose: () => void
  onApplied: (aff: AffectedMulti) => void; onInvalidate: () => void
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [applying, setApplying] = useState(false)
  const [plan, setPlan] = useState<PlanResult | null>(null)
  const crewName = (id: string | null | undefined) => (id ? crews.find(c => c.id === id)?.name ?? 'crew' : '—')

  async function submit() {
    if (!text.trim()) return
    setBusy(true); setPlan(null)
    try { setPlan(await planIntent(text.trim(), start, end)) }
    catch (e) { setPlan({ ok: false, reason: e instanceof Error ? e.message : 'The Copilot is unavailable right now.' }) }
    finally { setBusy(false) }
  }

  async function apply() {
    if (!plan || !plan.ok) return
    setApplying(true)
    try {
      const res = plan.kind === 'reschedule' && plan.moves
        ? await reschedule(plan.moves, false)
        : await bulkOp(plan.ids || [], plan.op || '', plan.payload || {}, false)
      if (!res.applied) { toast.error('Blocked — a conflict stopped it. Adjust and retry.'); return }
      if (res.affected) onApplied(res.affected)
      const batch = res.batch_id
      onInvalidate(); onClose()
      const n = plan.ids?.length ?? plan.moves?.length ?? 0
      toast((t) => (
        <span className="flex items-center gap-3 text-[13px]">
          Done · {n} job{n === 1 ? '' : 's'}.
          <button className="font-bold underline" onClick={async () => {
            toast.dismiss(t.id); if (!batch) return
            try { const u = await bulkUndo(batch); onApplied(u.affected); onInvalidate() } catch { toast.error('Undo failed.') }
          }}>Undo</button>
        </span>
      ), { duration: 15000 })
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not apply') }
    finally { setApplying(false) }
  }

  const hasBlocks = plan?.conflicts && Object.keys(plan.conflicts).length > 0

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[12vh]" onClick={onClose}>
      <div className="w-full max-w-xl overflow-hidden rounded-xl border shadow-2xl" onClick={e => e.stopPropagation()} style={{ background: 'var(--panel)', borderColor: 'var(--line)' }}>
        <div className="flex items-center gap-3 border-b px-4 py-3" style={{ borderColor: 'var(--line)' }}>
          <span className="text-[15px]" style={{ color: 'var(--dawn)' }}>✦</span>
          <input autoFocus value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') submit() }}
            placeholder="Tell the Copilot what to do…" className="flex-1 bg-transparent text-[14px] outline-none" style={{ color: 'var(--text)' }} />
          <button onClick={submit} disabled={busy || !text.trim()} className="rounded-md px-3 py-1 text-[12px] font-bold disabled:opacity-40" style={{ background: 'var(--dawn)', color: '#1a0e05' }}>{busy ? '…' : 'Plan'}</button>
        </div>

        <div className="max-h-[50vh] overflow-y-auto p-4">
          {!plan && !busy && (
            <div className="space-y-1.5">
              <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--muted)' }}>Try</div>
              {EXAMPLES.map(ex => (
                <button key={ex} onClick={() => setText(ex)} className="block w-full rounded-md px-2.5 py-1.5 text-left text-[12px] hover:bg-white/5" style={{ color: 'var(--text)' }}>“{ex}”</button>
              ))}
              <div className="pt-1 text-[11px]" style={{ color: 'var(--muted)' }}>The Copilot only proposes — you approve every change, and it’s one undo.</div>
            </div>
          )}

          {busy && <div className="py-6 text-center text-[13px]" style={{ color: 'var(--muted)' }}>Reading the board…</div>}

          {plan && !plan.ok && (
            <div className="rounded-lg p-3 text-[13px]" style={{ background: 'var(--panel2)', color: 'var(--tight)' }}>{plan.reason}</div>
          )}

          {plan && plan.ok && (
            <div className="space-y-3">
              <div className="text-[13px] font-semibold">{plan.summary}</div>
              {hasBlocks && <div className="text-[12px] font-semibold" style={{ color: 'var(--over)' }}>Some moves are blocked — nothing applies until they clear.</div>}
              <div className="space-y-1">
                {(plan.changes || []).map((c, i) => {
                  const blocks = plan.conflicts?.[c.id] || []
                  return (
                    <div key={i} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px]" style={{ background: 'var(--panel2)' }}>
                      <span className="w-10 shrink-0 font-mono text-[11px]" style={{ color: 'var(--muted)' }}>#{c.job_number ?? '—'}</span>
                      {c.from?.crew_id !== undefined && (
                        <>
                          <span style={{ color: 'var(--muted)' }}>{crewName(c.from.crew_id)} {c.from.date?.slice(5) ?? ''}</span>
                          <span style={{ color: 'var(--sky)' }}>→</span>
                          <span className="font-semibold">{crewName(c.to?.crew_id)} {c.to?.date?.slice(5) ?? ''}</span>
                        </>
                      )}
                      {blocks.length > 0 && <span className="ml-auto rounded px-1 py-0.5 text-[9px] font-bold" style={{ background: 'color-mix(in srgb, var(--over) 20%, transparent)', color: 'var(--over)' }} title={blocks.map(b => b.message).join(' · ')}>⃠ {blocks[0].message}</span>}
                    </div>
                  )
                })}
              </div>
              <div className="flex justify-end gap-2">
                <button onClick={() => setPlan(null)} className="rounded-md px-3 py-1.5 text-[12px] font-semibold hover:bg-white/5" style={{ color: 'var(--muted)' }}>Back</button>
                <button onClick={apply} disabled={applying || hasBlocks} className="rounded-md px-4 py-1.5 text-[12px] font-bold disabled:opacity-40" style={{ background: hasBlocks ? 'var(--panel2)' : 'var(--dawn)', color: hasBlocks ? 'var(--muted)' : '#1a0e05' }}>
                  {hasBlocks ? 'Resolve conflicts' : 'Approve & apply'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
