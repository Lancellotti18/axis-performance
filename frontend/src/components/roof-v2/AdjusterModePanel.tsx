'use client'

/**
 * Adjuster Mode — the insurance-claim view of a run.
 *
 * Shows the Xactimate-style quantity survey (RFG line codes + units + quantities,
 * all derived from the confirmed geometry) and an RCV/ACV claim summary. Unit
 * pricing is the adjuster's Xactimate price list, so we ask for depreciation +
 * deductible and compute the claim over whatever the adjuster prices — we never
 * fabricate a dollar figure. Quantities copy to clipboard for pasting into a
 * claim, and the whole survey exports to CSV.
 */
import { useCallback, useState } from 'react'
import { api } from '@/lib/api'

type Line = {
  code: string; description: string; unit: string; quantity: number
  category: string; trace: string; unit_price: number | null; rcv: number | null
}
type ClaimSummary = {
  rcv: number | null; depreciation_pct: number | null; depreciation_amount: number | null
  acv: number | null; deductible: number | null; net_claim: number | null
  recoverable_depreciation: number | null; priced_line_count: number
  unpriced_line_count: number; notes: string[]
}

const money = (n: number | null) =>
  n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

export default function AdjusterModePanel({ runId }: { runId: string }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lines, setLines] = useState<Line[]>([])
  const [summary, setSummary] = useState<ClaimSummary | null>(null)

  const [wastePct, setWastePct] = useState(15)
  const [depreciationPct, setDepreciationPct] = useState<string>('')
  const [deductible, setDeductible] = useState<string>('')

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await api.roofing.v2.getAdjusterEstimate(runId, {
        wastePct,
        depreciationPct: depreciationPct === '' ? undefined : Number(depreciationPct),
        deductible: deductible === '' ? undefined : Number(deductible),
      })
      setLines(res.lines)
      setSummary(res.claim_summary)
      setOpen(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not build the adjuster estimate.')
    } finally {
      setLoading(false)
    }
  }, [runId, wastePct, depreciationPct, deductible])

  const exportCsv = useCallback(() => {
    const header = ['Code', 'Description', 'Unit', 'Quantity', 'Unit Price', 'RCV', 'Derivation']
    const rows = lines.map(l => [
      l.code, l.description, l.unit, l.quantity.toFixed(2),
      l.unit_price == null ? '' : l.unit_price.toFixed(2),
      l.rcv == null ? '' : l.rcv.toFixed(2), l.trace,
    ])
    const esc = (s: string) => `"${String(s).replace(/"/g, '""')}"`
    const csv = [header, ...rows].map(r => r.map(esc).join(',')).join('\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url; a.download = `axis-adjuster-estimate-${runId.slice(0, 8)}.csv`
    document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  }, [lines, runId])

  return (
    <section className="rounded-xl border border-white/10 bg-slate-900/50 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-slate-100">Adjuster Mode</h3>
          <p className="text-xs text-slate-400">
            Xactimate line codes + quantities from the confirmed geometry, with an RCV/ACV claim summary.
          </p>
        </div>
      </div>

      {/* Inputs */}
      <div className="mb-3 grid grid-cols-3 gap-3 text-xs">
        <label className="flex flex-col gap-1">
          <span className="text-slate-400">Waste %</span>
          <input type="number" min={0} max={50} value={wastePct}
            onChange={e => setWastePct(Number(e.target.value))}
            className="rounded bg-slate-800 px-2 py-1 text-slate-100" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-slate-400">Depreciation % <span className="text-slate-600">(adjuster)</span></span>
          <input type="number" min={0} max={100} value={depreciationPct} placeholder="e.g. 20"
            onChange={e => setDepreciationPct(e.target.value)}
            className="rounded bg-slate-800 px-2 py-1 text-slate-100" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-slate-400">Deductible $</span>
          <input type="number" min={0} value={deductible} placeholder="e.g. 1000"
            onChange={e => setDeductible(e.target.value)}
            className="rounded bg-slate-800 px-2 py-1 text-slate-100" />
        </label>
      </div>

      <div className="flex gap-2">
        <button onClick={load} disabled={loading}
          className="rounded bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50">
          {loading ? 'Building…' : open ? 'Recalculate' : 'Build adjuster estimate'}
        </button>
        {open && lines.length > 0 && (
          <button onClick={exportCsv}
            className="rounded border border-white/15 px-3 py-1.5 text-sm text-slate-200 hover:bg-white/5">
            Export CSV
          </button>
        )}
      </div>

      {error && <p className="mt-3 text-sm text-rose-400">{error}</p>}

      {open && summary && (
        <div className="mt-4 space-y-4">
          {/* Claim summary */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ['RCV', money(summary.rcv)],
              ['Depreciation', summary.depreciation_amount == null ? '—' : `−${money(summary.depreciation_amount)}`],
              ['ACV', money(summary.acv)],
              ['Net claim', money(summary.net_claim)],
            ].map(([label, val]) => (
              <div key={label} className="rounded-lg border border-white/10 bg-slate-950/40 p-3">
                <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
                <div className="text-lg font-semibold text-slate-100 tabular-nums">{val}</div>
              </div>
            ))}
          </div>

          {summary.notes.length > 0 && (
            <ul className="space-y-1 text-xs text-amber-400">
              {summary.notes.map((n, i) => <li key={i}>⚠ {n}</li>)}
            </ul>
          )}

          {/* Line items */}
          <div className="overflow-x-auto rounded-lg border border-white/10">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-800/60 text-slate-400">
                <tr>
                  <th className="px-3 py-2">Code</th>
                  <th className="px-3 py-2">Description</th>
                  <th className="px-3 py-2 text-right">Qty</th>
                  <th className="px-3 py-2">Unit</th>
                  <th className="px-3 py-2 text-right">Unit $</th>
                  <th className="px-3 py-2 text-right">RCV</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5 text-slate-200">
                {lines.map((l, i) => (
                  <tr key={i} title={l.trace}>
                    <td className="px-3 py-2 font-mono text-sky-300">{l.code}</td>
                    <td className="px-3 py-2">{l.description}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{l.quantity.toFixed(2)}</td>
                    <td className="px-3 py-2 text-slate-400">{l.unit}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-400">
                      {l.unit_price == null ? '—' : money(l.unit_price)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{l.rcv == null ? '—' : money(l.rcv)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-[11px] leading-relaxed text-slate-500">
            Quantities are measured from the confirmed roof geometry. Line codes follow the standard
            RFG category — verify against your active Xactimate price list. Unit pricing, depreciation,
            and deductible are provided by the adjuster.
          </p>
        </div>
      )}
    </section>
  )
}
