'use client'

/**
 * Live measurement summary for an Axis Performance v2 measurement run.
 *
 * Calls `/runs/{id}/recompute` whenever the parent says facets/edges changed
 * (debounced 600ms) and renders:
 *   - Roof totals (area, squares, predominant pitch, perimeter)
 *   - Roof line lengths (ridge / hip / valley / eave / rake), color-coded
 *   - Materials table at the selected waste %, with the full waste table
 *   - Confidence indicator
 *
 * Server is the source of truth for every number shown. Client only triggers
 * the recompute and renders results — no math happens here.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '@/lib/api'

interface Aggregates {
  total_plan_sqft?: number
  total_roof_sqft?: number
  squares?: number
  predominant_pitch?: string
  predominant_pitch_degrees?: number
  facet_count?: number
  ridges_ft?: number
  hips_ft?: number
  valleys_ft?: number
  eaves_ft?: number
  rakes_ft?: number
  perimeter_ft?: number
  ridge_total_ft?: number
  complexity_score?: number
  waste_pct_default?: number
  confidence?: number
  wall_intersection_ft?: number
}

interface MaterialsResponse {
  lines: Array<{
    sku: string
    item_name: string
    category: string
    unit: string
    base_quantity: number
    waste_quantities: Record<string, number>
    unit_cost: number
    total_cost_at_default_waste: number
    computation_trace: string
  }>
  summary: {
    per_waste_totals: Record<string, number>
    per_category: Record<string, { items: number; subtotal: number }>
    line_count: number
  }
  grand_total_at_selected_waste: number
  totals_input: Record<string, number | string>
  waste_table: number[]
  waste_pct: number
}

interface Props {
  runId: string
  geometryStamp: number       // bump to trigger a recompute (debounced)
  onConfidenceChange?: (c: number) => void
}

const COLORS: Record<string, string> = {
  ridges: '#a78bfa',
  hips: '#34d399',
  valleys: '#f87171',
  eaves: '#fb923c',
  rakes: '#60a5fa',
  perimeter: '#fbbf24',
}

function fmtFt(v: number | undefined): string {
  return v == null ? '—' : `${v.toLocaleString(undefined, { maximumFractionDigits: 1 })} lf`
}
function fmtSf(v: number | undefined): string {
  return v == null ? '—' : `${v.toLocaleString(undefined, { maximumFractionDigits: 0 })} sf`
}
function fmt$(v: number | undefined): string {
  return v == null ? '—' : v.toLocaleString(undefined, { style: 'currency', currency: 'USD' })
}

function confidenceTag(c: number | undefined) {
  const v = (c ?? 0) * 100
  if (v >= 80) return { label: 'High', cls: 'bg-emerald-500/20 text-emerald-300 border-emerald-400/40' }
  if (v >= 55) return { label: 'Moderate', cls: 'bg-amber-500/20 text-amber-300 border-amber-400/40' }
  return { label: 'Low', cls: 'bg-rose-500/20 text-rose-300 border-rose-400/40' }
}

export function MeasurementsSummary({ runId, geometryStamp, onConfidenceChange }: Props) {
  const [aggregates, setAggregates] = useState<Aggregates | null>(null)
  const [materials, setMaterials] = useState<MaterialsResponse | null>(null)
  const [wastePct, setWastePct] = useState<number>(12)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lastStampRef = useRef<number>(-1)

  const fetchAll = useCallback(async (waste: number) => {
    if (!runId) return
    setLoading(true)
    setError(null)
    try {
      const agg = await api.roofing.v2.recompute(runId)
      setAggregates(agg as Aggregates)
      const conf = (agg as Aggregates).confidence
      if (conf !== undefined) onConfidenceChange?.(conf)
      try {
        const mats = await api.roofing.v2.getMaterials(runId, waste)
        setMaterials(mats as MaterialsResponse)
      } catch (err) {
        // Materials require non-zero totals; that's fine before edges are labeled.
        setMaterials(null)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to recompute')
    } finally {
      setLoading(false)
    }
  }, [runId, onConfidenceChange])

  // Debounced recompute on geometry change
  useEffect(() => {
    if (geometryStamp === lastStampRef.current) return
    lastStampRef.current = geometryStamp
    const handle = setTimeout(() => { void fetchAll(wastePct) }, 600)
    return () => clearTimeout(handle)
  }, [geometryStamp, wastePct, fetchAll])

  // When waste % changes, refetch materials only (cheaper than recompute)
  const onWasteChange = useCallback(async (pct: number) => {
    setWastePct(pct)
    if (!runId) return
    setLoading(true)
    try {
      const mats = await api.roofing.v2.getMaterials(runId, pct)
      setMaterials(mats as MaterialsResponse)
    } catch {
      setMaterials(null)
    } finally {
      setLoading(false)
    }
  }, [runId])

  const conf = confidenceTag(aggregates?.confidence)
  const hasNoData = aggregates && (aggregates.facet_count ?? 0) === 0 && !loading

  const lineBars = useMemo(() => {
    if (!aggregates) return null
    const items: Array<{ key: keyof typeof COLORS; label: string; value: number | undefined }> = [
      { key: 'ridges', label: 'Ridges', value: aggregates.ridges_ft },
      { key: 'hips', label: 'Hips', value: aggregates.hips_ft },
      { key: 'valleys', label: 'Valleys', value: aggregates.valleys_ft },
      { key: 'eaves', label: 'Eaves', value: aggregates.eaves_ft },
      { key: 'rakes', label: 'Rakes', value: aggregates.rakes_ft },
    ]
    const max = Math.max(1, ...items.map(i => i.value || 0))
    return (
      <ul className="space-y-2">
        {items.map(item => {
          const pct = ((item.value || 0) / max) * 100
          return (
            <li key={item.key}>
              <div className="flex justify-between text-xs text-slate-300">
                <span className="flex items-center gap-2">
                  <span className="inline-block h-2 w-3 rounded" style={{ background: COLORS[item.key] }} />
                  {item.label}
                </span>
                <span className="font-mono">{fmtFt(item.value)}</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-slate-800">
                <div className="h-full rounded-full" style={{ width: `${pct}%`, background: COLORS[item.key] }} />
              </div>
            </li>
          )
        })}
      </ul>
    )
  }, [aggregates])

  return (
    <div className="space-y-4">
      {hasNoData && (
        <div className="rounded-lg border border-amber-400/40 bg-amber-500/10 p-3 text-sm text-amber-200">
          <strong>No facets saved to the database yet.</strong>
          {' '}
          Draw at least one polygon in the editor above — the panel will auto-update within a second once the save completes. If you've drawn polygons and still see this message, check the browser DevTools Network tab for failing requests to <code>/api/v1/roofing/v2/runs/.../facets</code>.
        </div>
      )}
      {/* Top totals */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card label="True roof area" value={fmtSf(aggregates?.total_roof_sqft)} sub="(slope-adjusted)" />
        <Card label="Roofing squares" value={aggregates?.squares != null ? `${aggregates.squares.toFixed(2)} sq` : '—'} sub="area ÷ 100" />
        <Card label="Predominant pitch" value={aggregates?.predominant_pitch ?? '—'} sub={aggregates?.predominant_pitch_degrees ? `${aggregates.predominant_pitch_degrees.toFixed(1)}°` : ''} />
        <Card label="Confidence" value={<span className={`inline-block rounded border px-2 py-0.5 text-xs ${conf.cls}`}>{conf.label} ({((aggregates?.confidence ?? 0) * 100).toFixed(0)}%)</span>} sub="area-weighted across facets" />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* Roof lines */}
        <section className="rounded-lg border border-white/10 bg-slate-900/60 p-4">
          <h3 className="mb-3 text-sm font-semibold text-slate-200">Roof line measurements</h3>
          {lineBars || <p className="text-xs text-slate-500">Draw and label facet edges to see roof lines.</p>}
          {aggregates && (
            <div className="mt-3 border-t border-white/10 pt-3 text-xs text-slate-400">
              Perimeter: <span className="font-mono text-slate-200">{fmtFt(aggregates.perimeter_ft)}</span> &nbsp;·&nbsp;
              Ridge total: <span className="font-mono text-slate-200">{fmtFt(aggregates.ridge_total_ft)}</span>
              {aggregates.wall_intersection_ft ? (
                <> &nbsp;·&nbsp; Wall: <span className="font-mono text-slate-200">{fmtFt(aggregates.wall_intersection_ft)}</span></>
              ) : null}
            </div>
          )}
        </section>

        {/* Waste & complexity */}
        <section className="rounded-lg border border-white/10 bg-slate-900/60 p-4">
          <h3 className="mb-3 text-sm font-semibold text-slate-200">Waste calculation</h3>
          <div className="mb-3 text-xs text-slate-400">
            Complexity score: <span className="font-mono text-slate-200">{aggregates?.complexity_score?.toFixed(2) ?? '—'}</span>
            &nbsp;·&nbsp; Recommended: <span className="font-mono text-slate-200">{aggregates?.waste_pct_default ?? '—'}%</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {(materials?.waste_table ?? [5, 10, 12, 15, 18, 20, 25]).map(pct => (
              <button
                key={pct}
                onClick={() => onWasteChange(pct)}
                className={`rounded-md border px-3 py-1.5 text-xs font-medium transition ${
                  wastePct === pct
                    ? 'border-blue-400 bg-blue-500/30 text-white'
                    : 'border-white/10 bg-slate-800 text-slate-300 hover:bg-slate-700'
                }`}
              >
                {pct}%
                {materials?.summary.per_waste_totals?.[pct] !== undefined && (
                  <span className="ml-1 text-slate-400">→ {fmt$(materials.summary.per_waste_totals[pct])}</span>
                )}
              </button>
            ))}
          </div>
        </section>
      </div>

      {/* Materials */}
      <section className="rounded-lg border border-white/10 bg-slate-900/60 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-200">Material ordering list ({wastePct}% waste)</h3>
          <span className="text-sm font-semibold text-emerald-300">{fmt$(materials?.grand_total_at_selected_waste)}</span>
        </div>
        {!materials && (
          <p className="text-xs text-slate-500">
            Once facet edges are labeled and totals are non-zero, materials appear here.
          </p>
        )}
        {materials && materials.lines.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-white/10 text-slate-400">
                  <th className="px-2 py-2 text-left">SKU</th>
                  <th className="px-2 py-2 text-left">Item</th>
                  <th className="px-2 py-2 text-right">Base qty</th>
                  <th className="px-2 py-2 text-right">Qty @ {wastePct}%</th>
                  <th className="px-2 py-2 text-left">Unit</th>
                  <th className="px-2 py-2 text-right">Unit $</th>
                  <th className="px-2 py-2 text-right">Subtotal</th>
                </tr>
              </thead>
              <tbody>
                {materials.lines.map(line => (
                  <tr key={line.sku} className="border-b border-white/5 text-slate-200">
                    <td className="px-2 py-2 font-mono text-[10px] text-slate-400">{line.sku}</td>
                    <td className="px-2 py-2">
                      <div>{line.item_name}</div>
                      <div className="text-[10px] text-slate-500">{line.computation_trace}</div>
                    </td>
                    <td className="px-2 py-2 text-right font-mono">{line.base_quantity.toFixed(2)}</td>
                    <td className="px-2 py-2 text-right font-mono">{line.waste_quantities[wastePct] ?? '—'}</td>
                    <td className="px-2 py-2">{line.unit}</td>
                    <td className="px-2 py-2 text-right font-mono">{fmt$(line.unit_cost)}</td>
                    <td className="px-2 py-2 text-right font-mono">{fmt$((line.waste_quantities[wastePct] ?? 0) * line.unit_cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {loading && <p className="text-xs text-slate-500">Recomputing…</p>}
      {error && <p className="text-xs text-rose-400">{error}</p>}
    </div>
  )
}

function Card({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-slate-900/60 p-3">
      <div className="text-[10px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-1 text-lg font-semibold text-slate-100">{value}</div>
      {sub && <div className="text-[10px] text-slate-500">{sub}</div>}
    </div>
  )
}

export default MeasurementsSummary
