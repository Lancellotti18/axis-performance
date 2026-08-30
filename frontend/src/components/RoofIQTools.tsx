'use client'

/**
 * RoofIQTools — the contractor's RoofIQ command card, mounted on the CRM page
 * (leads live in ONE pipeline now; widget leads auto-import into the CRM).
 * Link + embed + settings + the 30-day funnel.
 */
import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'

import { api, type QuoteWidget } from '@/lib/api'

export default function RoofIQTools() {
  const [widget, setWidget] = useState<QuoteWidget | null>(null)
  const [analytics, setAnalytics] = useState<{ funnel: Record<string, number>; leads_30d: number; avg_score: number | null } | null>(null)
  useEffect(() => {
    api.instantQuote.myWidget().then(w => {
      setWidget(w)
    }).catch(() => {})
    api.instantQuote.analytics().then(setAnalytics).catch(() => {})
  }, [])






  if (!widget) return null
  const hostedUrl = `${typeof window !== 'undefined' ? window.location.origin : ''}/q/${widget.widget_key}`
  const embedCode = `<iframe src="${hostedUrl}?embed=1" style="width:100%;max-width:640px;height:720px;border:0;border-radius:16px;" title="Instant roof quote"></iframe>`
  const copy = (text: string, what: string) =>
    void navigator.clipboard.writeText(text).then(() => toast.success(`${what} copied`))

  const funnel = analytics?.funnel || {}
  const hasFunnel = Object.keys(funnel).length > 0


  return (
    <section className="rounded-xl border border-[#dededc] bg-[#f8f8f7] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-[#1a1a1a]">🎯 RoofIQ — your instant-quote lead machine</h2>
          <p className="text-xs text-[#6b7280]">
            Homeowners get an AI roof report from this link; every completion lands in your pipeline below, scored.
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        <code className="max-w-full truncate rounded bg-[#eeeeed] px-2 py-1.5 font-mono text-[11px] text-blue-200">{hostedUrl}</code>
        <button onClick={() => copy(hostedUrl, 'Link')} className="rounded bg-blue-600 px-2.5 py-1.5 font-semibold text-white hover:bg-blue-500">Copy link</button>
        <button onClick={() => copy(embedCode, 'Embed code')} className="rounded bg-[#e4e4e2] px-2.5 py-1.5 text-[#1a1a1a] hover:bg-[#d4d4d2]">Copy website embed</button>
        <a href={hostedUrl} target="_blank" rel="noreferrer" className="rounded bg-[#e4e4e2] px-2.5 py-1.5 text-[#1a1a1a] hover:bg-[#d4d4d2]">Preview ↗</a>
      </div>

      {hasFunnel && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[#dededc] pt-3 text-xs">
          <span className="mr-1 text-[10px] uppercase tracking-wide text-[#6b7280]">Last 30 days</span>
          {([
            ['view', 'Views'], ['address_entered', 'Addresses'], ['roof_confirmed', 'Confirmed'],
            ['qualified', 'Qualified'], ['lead_captured', 'Leads'],
          ] as [string, string][]).map(([k, label], i, arr) => (
            <span key={k} className="flex items-center gap-2">
              <span className="rounded bg-[#eeeeed] px-2 py-1 text-center">
                <strong className="text-[#1a1a1a]">{funnel[k] ?? 0}</strong>
                <span className="ml-1 text-[10px] text-[#6b7280]">{label}</span>
              </span>
              {i < arr.length - 1 && <span className="text-[#9ca3af]">→</span>}
            </span>
          ))}
          {(funnel.view ?? 0) > 0 && (
            <span className="text-[11px] text-[#6b7280]">
              · {Math.round(((funnel.lead_captured ?? 0) / (funnel.view || 1)) * 100)}% completion
            </span>
          )}
          {analytics?.avg_score != null && (
            <span className="text-[11px] text-[#6b7280]">· avg quality <strong className="text-[#2d2d2d]">{analytics.avg_score}</strong>/100</span>
          )}
        </div>
      )}
    </section>
  )
}
