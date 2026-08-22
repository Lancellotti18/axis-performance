'use client'

/**
 * SavedMeasurements — the roof numbers, on the project page.
 *
 * Everything here was already persisted; it just had nowhere to be seen. A
 * contractor coming back to a project got a name, an address and two buttons,
 * which reads as "nothing was saved" even though the facets, edges and
 * materials were all sitting in the run. Reading them here means the work is
 * visible without reopening the measurement tool.
 */
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { api } from '@/lib/api'

type Agg = {
  squares?: number
  total_roof_sqft?: number
  predominant_pitch?: string
  facet_count?: number
  ridges_ft?: number
  hips_ft?: number
  valleys_ft?: number
  eaves_ft?: number
  rakes_ft?: number
  perimeter_ft?: number
  waste_pct_default?: number
  confidence?: number
}

const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : null)

export default function SavedMeasurements({
  runId, projectId, cardStyle,
}: { runId: string; projectId: string; cardStyle?: React.CSSProperties }) {
  const [agg, setAgg] = useState<Agg | null>(null)
  const [state, setState] = useState<'loading' | 'ok' | 'empty'>('loading')

  useEffect(() => {
    let cancelled = false
    api.roofing.v2.recompute(runId)
      .then(r => {
        if (cancelled) return
        const a = ((r as Record<string, unknown>).aggregates ?? r) as Agg
        setAgg(a)
        setState(num(a?.squares) ? 'ok' : 'empty')
      })
      .catch(() => { if (!cancelled) setState('empty') })
    return () => { cancelled = true }
  }, [runId])

  if (state === 'loading') {
    return (
      <div className="rounded-2xl bg-[#f8f8f7] p-5" style={cardStyle}>
        <div className="h-4 w-40 animate-pulse rounded bg-[#e4e4e2]" />
        <div className="mt-3 h-8 w-28 animate-pulse rounded bg-[#e4e4e2]" />
      </div>
    )
  }
  if (state === 'empty' || !agg) return null

  const lines: [string, number | null, string][] = [
    ['Eaves', num(agg.eaves_ft), 'ft'],
    ['Rakes', num(agg.rakes_ft), 'ft'],
    ['Ridges', num(agg.ridges_ft), 'ft'],
    ['Hips', num(agg.hips_ft), 'ft'],
    ['Valleys', num(agg.valleys_ft), 'ft'],
    ['Perimeter', num(agg.perimeter_ft), 'ft'],
  ]

  return (
    <div className="rounded-2xl bg-[#f8f8f7] p-5" style={cardStyle}>
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-bold text-[#1a1a1a]">Saved measurements</h3>
        <Link href="/roof-v2" className="text-xs font-semibold text-[#0068d6] hover:text-[#01498f]">
          Open measurement tool →
        </Link>
      </div>

      <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
        <div>
          <div className="text-3xl font-bold leading-none tabular-nums text-[#1a1a1a]">
            {num(agg.squares)?.toFixed(1) ?? '—'}
            <span className="ml-1 text-sm font-semibold text-[#6b7280]">squares</span>
          </div>
          {num(agg.total_roof_sqft) != null && (
            <div className="mt-1 text-xs text-[#6b7280] tabular-nums">
              {Math.round(agg.total_roof_sqft as number).toLocaleString()} ft² of roof surface
            </div>
          )}
        </div>
        <div className="text-sm">
          <div className="text-[#6b7280]">Pitch</div>
          <div className="font-semibold text-[#1a1a1a]">{agg.predominant_pitch || '—'}</div>
        </div>
        <div className="text-sm">
          <div className="text-[#6b7280]">Planes</div>
          <div className="font-semibold tabular-nums text-[#1a1a1a]">{agg.facet_count ?? '—'}</div>
        </div>
        {num(agg.waste_pct_default) != null && (
          <div className="text-sm">
            <div className="text-[#6b7280]">Waste</div>
            <div className="font-semibold tabular-nums text-[#1a1a1a]">{agg.waste_pct_default}%</div>
          </div>
        )}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1.5 border-t border-[#dededc] pt-3 sm:grid-cols-3">
        {lines.filter(([, v]) => v != null && v > 0).map(([label, v, unit]) => (
          <div key={label} className="flex items-baseline justify-between gap-2 text-xs">
            <span className="text-[#6b7280]">{label}</span>
            <span className="font-semibold tabular-nums text-[#1a1a1a]">{v!.toFixed(1)} {unit}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
