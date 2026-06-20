'use client'

/**
 * PreReportChecklist — a pre-report verification gate.
 *
 * Rolls every "needs review / estimated" signal into one compact checklist so
 * nothing ships to a report unverified: unlabeled edges (affect ridge / drip /
 * flashing), roof pitch still at the default, and flashing items the engine
 * flagged for on-site verification. Advisory, not blocking — the contractor
 * can proceed, but they see exactly what's unconfirmed first.
 */
import { useCallback, useEffect, useState } from 'react'

import { api } from '@/lib/api'
import type { Facet, LabeledEdge } from './RoofFacetEditor'

interface Props {
  runId: string
  facets: Facet[]
  edges: LabeledEdge[]
}

interface Check {
  ok: boolean
  label: string
  detail: string
}

export default function PreReportChecklist({ runId, facets, edges }: Props) {
  const [flashingReview, setFlashingReview] = useState<number | null>(null)

  const loadFlashing = useCallback(async () => {
    try {
      const res = await api.roofing.v2.getFlashing(runId)
      setFlashingReview(res.requirements.filter(r => r.needs_review).length)
    } catch {
      setFlashingReview(null)
    }
  }, [runId])

  useEffect(() => { void loadFlashing() }, [loadFlashing])

  const unlabeled = edges.filter(e => e.edgeType === 'unlabeled').length
  const allDefaultPitch = facets.length > 0 && facets.every(f => f.pitch === '6/12')

  const checks: Check[] = [
    {
      ok: facets.length > 0,
      label: `${facets.length} facet${facets.length === 1 ? '' : 's'} traced`,
      detail: facets.length > 0 ? 'Roof planes are drawn.' : 'Draw at least one roof facet.',
    },
    {
      ok: unlabeled === 0,
      label: unlabeled === 0 ? 'All edges labeled' : `${unlabeled} edge${unlabeled === 1 ? '' : 's'} unlabeled`,
      detail: unlabeled === 0 ? 'Ridge / drip / flashing lengths are complete.' : 'Unlabeled edges are excluded from ridge cap, drip edge, and flashing.',
    },
    {
      ok: !allDefaultPitch,
      label: allDefaultPitch ? 'Roof pitch still at default 6/12' : 'Roof pitch set',
      detail: allDefaultPitch ? 'Confirm the pitch (upload a gable photo, or edit a facet) — it drives area + flashing.' : 'Pitch has been adjusted from the default.',
    },
    {
      ok: flashingReview === null ? true : flashingReview === 0,
      label: flashingReview === null ? 'Flashing not analyzed yet'
        : flashingReview === 0 ? 'Flashing verified'
        : `${flashingReview} flashing item${flashingReview === 1 ? '' : 's'} to verify`,
      detail: flashingReview && flashingReview > 0
        ? 'Some flashing runs/penetrations were estimated from imagery — verify on-site.'
        : 'No flashing items flagged for review.',
    },
  ]

  const outstanding = checks.filter(c => !c.ok).length

  return (
    <section className="rounded-lg border border-white/10 bg-slate-900/40 p-3 text-sm">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-100">Before you generate the report</h3>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
          outstanding === 0 ? 'bg-emerald-900/40 text-emerald-300' : 'bg-amber-900/40 text-amber-300'
        }`}>
          {outstanding === 0 ? 'All clear' : `${outstanding} to review`}
        </span>
      </div>
      <ul className="space-y-1">
        {checks.map((c, i) => (
          <li key={i} className="flex items-start gap-2 text-xs">
            <span className={c.ok ? 'text-emerald-400' : 'text-amber-400'}>{c.ok ? '✓' : '⚠'}</span>
            <div>
              <span className={c.ok ? 'text-slate-200' : 'text-amber-200'}>{c.label}</span>
              <span className="text-slate-500"> — {c.detail}</span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
