'use client'

/**
 * APIR Phase 6 — accuracy diagnostic for a single report.
 *
 * Shown inside ReportsPanel when the contractor expands a version row.
 * Surfaces:
 *   * Overall grade A-D (large badge)
 *   * Per-category confidence + sample counts
 *   * Flagged items the contractor should verify on-site
 *   * On-site verification checklist
 *
 * Server-derived (no AI cost) — re-computes from measurements_snapshot
 * every time, so the diagnostic always reflects current scoring logic.
 */
import { useEffect, useState } from 'react'

import { api } from '@/lib/api'


type AccuracyData = Awaited<ReturnType<typeof api.apir.accuracy>>


export default function AccuracyPanel({ reportId }: { reportId: string }) {
  const [data, setData] = useState<AccuracyData | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setErr(null)
    api.apir.accuracy(reportId)
      .then(d => { if (!cancelled) setData(d) })
      .catch(e => { if (!cancelled) setErr(e instanceof Error ? e.message : 'failed') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [reportId])

  if (loading) {
    return (
      <div className="rounded-md bg-slate-800/60 p-3 text-xs text-slate-400">
        Computing accuracy diagnostic…
      </div>
    )
  }
  if (err) {
    return (
      <div className="rounded-md bg-rose-900/30 p-3 text-xs text-rose-300">
        Accuracy check failed: {err}
      </div>
    )
  }
  if (!data) return null

  return (
    <div className="space-y-3 rounded-md bg-slate-800/40 p-4">
      {/* Overall grade + summary */}
      <header className="flex items-start gap-4">
        <GradeBadge grade={data.overall_grade} score={data.overall_score} />
        <div className="flex-1">
          <p className="text-sm text-slate-100">{data.summary}</p>
          <p className="mt-1 text-xs text-slate-400">
            Overall confidence: {data.overall_confidence.toUpperCase()} ·
            Score {(data.overall_score * 100).toFixed(0)}/100
          </p>
        </div>
      </header>

      {/* Per-category breakdown */}
      <div>
        <h5 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
          Per-category confidence
        </h5>
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {data.categories.map(c => (
            <div
              key={c.category}
              className="rounded border border-slate-700 bg-slate-900/60 p-2 text-xs"
            >
              <div className="mb-1 flex items-center justify-between">
                <span className="font-mono text-slate-200">
                  {c.category.replace('_', ' ')}
                </span>
                <ConfBadge confidence={c.confidence} />
              </div>
              <div className="text-slate-400">
                target ±{c.target_pct_error}% · {c.note}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Flagged items */}
      {data.flagged_items.length > 0 && (
        <div>
          <h5 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
            Items to verify ({data.flagged_items.length})
          </h5>
          <ul className="space-y-1.5">
            {data.flagged_items.map((f, i) => (
              <li
                key={`${f.category}-${i}`}
                className="rounded border border-slate-700 bg-slate-900/60 p-2 text-xs"
              >
                <div className="flex items-start gap-2">
                  <ConfBadge confidence={f.confidence} />
                  <div className="flex-1">
                    <p className="text-slate-100">{f.label}</p>
                    <p className="mt-0.5 text-slate-400">
                      {f.value && <span className="font-mono text-slate-300">{f.value}</span>}
                      {f.value && ' · '}
                      <span className="italic">{f.recommendation}</span>
                    </p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* On-site checklist */}
      <div>
        <h5 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
          On-site verification checklist
        </h5>
        <ul className="space-y-1 text-xs text-slate-200">
          {data.on_site_checks.map((check, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className="mt-0.5 text-emerald-400">☐</span>
              <span>{check}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}


// ─── Sub-components ──────────────────────────────────────────────────

function GradeBadge({ grade, score }: { grade: 'A' | 'B' | 'C' | 'D'; score: number }) {
  const tone = {
    A: 'bg-emerald-600 text-white',
    B: 'bg-blue-600 text-white',
    C: 'bg-amber-600 text-white',
    D: 'bg-rose-600 text-white',
  }[grade]
  return (
    <div className={`flex h-16 w-16 flex-col items-center justify-center rounded-lg ${tone}`}>
      <div className="text-3xl font-bold">{grade}</div>
      <div className="text-[10px] uppercase opacity-80">grade</div>
    </div>
  )
}


function ConfBadge({ confidence }: { confidence: 'high' | 'medium' | 'estimated' }) {
  const tone = (
    confidence === 'high'     ? 'bg-emerald-900/40 text-emerald-300'
    : confidence === 'medium' ? 'bg-amber-900/40 text-amber-300'
    :                          'bg-rose-900/40 text-rose-300'
  )
  return (
    <span className={`rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${tone}`}>
      {confidence}
    </span>
  )
}
