'use client'

/**
 * ProposalPanel — create + manage good/better/best proposals from this run.
 * One click prices three tiers off the measured squares; the contractor tweaks
 * prices, copies the share link, and watches for the homeowner's acceptance.
 */
import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'

import { api, type RoofProposal } from '@/lib/api'

interface Props {
  runId: string
  projectId?: string | null
}

const STATUS_TONE: Record<string, string> = {
  draft: 'bg-slate-600/30 text-slate-300 border-slate-500/40',
  sent: 'bg-blue-500/20 text-blue-300 border-blue-400/40',
  accepted: 'bg-emerald-500/20 text-emerald-300 border-emerald-400/40',
  declined: 'bg-rose-500/20 text-rose-300 border-rose-400/40',
  expired: 'bg-slate-600/30 text-slate-400 border-slate-500/40',
}

// Standard asphalt-shingle re-roof cost structure: the classic "10 and 10"
// (10% overhead + 10% profit) sits on top of the hard costs, which split into
// materials / labor / tear-off / permits. These are DEFAULTS to sanity-check
// Axis's price against — accuracy comes from the contractor confirming them,
// not from pretending to know every market. Computed on-screen and NEVER stored
// or sent to the customer (it would leak your margin), so the homeowner only
// ever sees the final price you choose.
const BREAKDOWN_SPLIT: { label: string; frac: number }[] = [
  { label: 'Materials — shingles, underlayment, flashing, fasteners', frac: 0.45 },
  { label: 'Labor — installation', frac: 0.38 },
  { label: 'Tear-off & disposal', frac: 0.14 },
  { label: 'Permits & misc.', frac: 0.03 },
]

function costBreakdown(price: number, squares?: number | null) {
  const sq = Math.max(0.1, (squares || 0) * 1.10)   // waste factor matches pricing
  const profit = 0.10 * price
  const overhead = 0.10 * price
  const hard = price - profit - overhead
  const lines = BREAKDOWN_SPLIT.map(s => ({ label: s.label, total: hard * s.frac }))
  lines.push({ label: 'Overhead — insurance, transport, supervision', total: overhead })
  lines.push({ label: 'Profit', total: profit })
  return { sq, lines }
}

export default function ProposalPanel({ runId, projectId }: Props) {
  const [proposals, setProposals] = useState<RoofProposal[]>([])
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editingPrices, setEditingPrices] = useState<Record<string, string[]>>({})
  const [openBreakdown, setOpenBreakdown] = useState<Record<string, boolean>>({})

  const refresh = useCallback(async () => {
    try {
      const res = await api.roofProposals.list(projectId || undefined)
      setProposals(res.proposals.filter(p => !projectId || p.project_id === projectId))
    } catch { /* transient */ }
  }, [projectId])

  useEffect(() => { void refresh() }, [refresh])

  const create = useCallback(async () => {
    setCreating(true)
    setError(null)
    try {
      await api.roofProposals.createFromRun(runId)
      await refresh()
      toast.success('Proposal created — adjust prices, then copy the link for your customer.')
    } catch (e) {
      const msg = e instanceof Error ? e.message.replace(/\[HTTP \d+\]\s*/, '') : 'Could not create proposal'
      setError(msg)      // inline too — a toast alone is easy to miss
      toast.error(msg)
    } finally {
      setCreating(false)
    }
  }, [runId, refresh])

  const money = (v?: number | null) => v == null ? '—' : v.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

  const copyLink = (p: RoofProposal) => {
    const url = `${window.location.origin}/p/${p.token}`
    void navigator.clipboard.writeText(url).then(() => toast.success('Proposal link copied — text or email it to your customer'))
  }

  const savePrices = useCallback(async (p: RoofProposal) => {
    const drafts = editingPrices[p.id]
    if (!drafts) return
    const tiers = p.tiers.map((t, i) => ({ ...t, price: Math.max(0, parseFloat(drafts[i]) || t.price) }))
    try {
      await api.roofProposals.update(p.id, { tiers })
      setEditingPrices(prev => { const n = { ...prev }; delete n[p.id]; return n })
      await refresh()
      toast.success('Prices updated')
    } catch { toast.error('Could not update prices') }
  }, [editingPrices, refresh])

  return (
    <section className="rounded-lg border border-white/10 bg-slate-900/40 p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">💼 Customer proposal</h3>
          <p className="text-xs text-slate-400">
            Turn this measurement into a <strong>Good / Better / Best</strong> proposal your customer
            accepts online. Axis suggests a price from the roof&apos;s squares — open the cost breakdown
            to check it against your real costs and set your own before sending.
          </p>
        </div>
        <button
          onClick={create}
          disabled={creating}
          className="rounded bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-500 disabled:opacity-50"
        >{creating ? 'Creating…' : '+ Create proposal'}</button>
      </div>

      {error && <p className="mt-2 rounded border border-rose-400/30 bg-rose-500/10 px-2 py-1.5 text-xs text-rose-300">{error}</p>}

      {proposals.length > 0 && (
        <ul className="mt-3 space-y-2">
          {proposals.map(p => {
            const drafts = editingPrices[p.id]
            return (
              <li key={p.id} className="rounded-lg border border-white/10 bg-slate-800/40 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase ${STATUS_TONE[p.status] || STATUS_TONE.draft}`}>
                      {p.status}
                    </span>
                    <span className="text-slate-300">{p.address || 'Proposal'}</span>
                    <span className="text-slate-500">· {p.squares ?? '—'} sq</span>
                    {p.status === 'accepted' && p.accepted_tier && (
                      <span className="font-semibold text-emerald-300">
                        ✓ {p.accepted_by_name} accepted “{p.accepted_tier}”
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button onClick={() => copyLink(p)} className="rounded bg-blue-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-blue-500">Copy link</button>
                    <a href={`/p/${p.token}`} target="_blank" rel="noreferrer" className="rounded bg-slate-700 px-2.5 py-1 text-[11px] text-slate-200 hover:bg-slate-600">Preview ↗</a>
                  </div>
                </div>
                {/* Tier prices — inline edit */}
                <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
                  {p.tiers.map((t, i) => (
                    <span key={t.name} className="flex items-center gap-1 rounded bg-slate-900/60 px-2 py-1">
                      <span className="text-slate-400">{t.name}:</span>
                      {drafts ? (
                        <input
                          type="number"
                          value={drafts[i]}
                          onChange={e => setEditingPrices(prev => ({
                            ...prev, [p.id]: prev[p.id].map((v, k) => k === i ? e.target.value : v),
                          }))}
                          className="w-20 rounded border border-slate-700 bg-slate-800 px-1 py-0.5 text-white"
                        />
                      ) : (
                        <strong className="text-white">{money(t.price)}</strong>
                      )}
                    </span>
                  ))}
                  {p.status !== 'accepted' && (drafts ? (
                    <>
                      <button onClick={() => savePrices(p)} className="rounded bg-emerald-600 px-2 py-1 font-semibold text-white hover:bg-emerald-500">Save</button>
                      <button onClick={() => setEditingPrices(prev => { const n = { ...prev }; delete n[p.id]; return n })}
                        className="rounded bg-slate-700 px-2 py-1 text-slate-300 hover:bg-slate-600">Cancel</button>
                    </>
                  ) : (
                    <button
                      onClick={() => setEditingPrices(prev => ({ ...prev, [p.id]: p.tiers.map(t => String(t.price)) }))}
                      className="rounded bg-slate-700 px-2 py-1 text-slate-300 hover:bg-slate-600"
                    >Edit prices</button>
                  ))}
                </div>

                {/* Internal cost breakdown — contractor-only. Lets you see how
                    Axis's suggested price is built (materials/labor/tear-off/
                    overhead/profit) and check it against your real numbers before
                    the customer ever sees a price. Never sent to the homeowner. */}
                <div className="mt-2">
                  <button
                    onClick={() => setOpenBreakdown(prev => ({ ...prev, [p.id]: !prev[p.id] }))}
                    className="text-[11px] text-slate-400 underline decoration-dotted underline-offset-2 hover:text-slate-200"
                  >
                    {openBreakdown[p.id] ? 'Hide' : 'Show'} cost breakdown 🔒 (only you see this)
                  </button>
                  {openBreakdown[p.id] && (() => {
                    const prices = p.tiers.map((t, i) => drafts ? (parseFloat(drafts[i]) || t.price) : t.price)
                    const bds = prices.map(pr => costBreakdown(pr, p.squares))
                    return (
                      <div className="mt-2 overflow-x-auto rounded-lg border border-white/10 bg-slate-900/60 p-2">
                        <table className="w-full text-[11px]">
                          <thead>
                            <tr className="text-slate-500">
                              <th className="py-1 text-left font-medium">Where the money goes</th>
                              {p.tiers.map(t => <th key={t.name} className="px-2 py-1 text-right font-medium">{t.name}</th>)}
                            </tr>
                          </thead>
                          <tbody>
                            {bds[0].lines.map((ln, ri) => (
                              <tr key={ln.label} className="text-slate-300">
                                <td className="py-0.5 pr-2">{ln.label}</td>
                                {bds.map((bd, ci) => <td key={ci} className="px-2 py-0.5 text-right tabular-nums">{money(bd.lines[ri].total)}</td>)}
                              </tr>
                            ))}
                            <tr className="border-t border-white/10 font-semibold text-white">
                              <td className="py-1 pr-2">Customer price</td>
                              {prices.map((pr, ci) => <td key={ci} className="px-2 py-1 text-right tabular-nums">{money(pr)}</td>)}
                            </tr>
                          </tbody>
                        </table>
                        <p className="mt-1.5 text-[10px] leading-relaxed text-slate-500">
                          Typical asphalt re-roof structure (standard 10% overhead + 10% profit). These are estimates to check against —
                          your customer never sees this. Use <strong>Edit prices</strong> above to set your own number.
                        </p>
                      </div>
                    )
                  })()}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
