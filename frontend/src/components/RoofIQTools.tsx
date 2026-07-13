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
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [priceLow, setPriceLow] = useState('450')
  const [priceHigh, setPriceHigh] = useState('650')
  const [catalog, setCatalog] = useState<{ key: string; name: string; tier: string }[]>([])
  const [palette, setPalette] = useState<string[]>([])

  useEffect(() => {
    api.instantQuote.myWidget().then(w => {
      setWidget(w)
      setPriceLow(String(w.price_low)); setPriceHigh(String(w.price_high))
      setPalette(w.roofvision_palette || [])
    }).catch(() => {})
    api.instantQuote.analytics().then(setAnalytics).catch(() => {})
    api.instantQuote.roofvisionCatalog().then(r => setCatalog(r.catalog)).catch(() => {})
  }, [])

  const toggleColor = (key: string) =>
    setPalette(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key])

  const savePalette = useCallback(async () => {
    try {
      const w = await api.instantQuote.updateWidget({ roofvision_palette: palette })
      setWidget(w); setPalette(w.roofvision_palette || palette)
      toast.success('RoofVision colors saved')
    } catch { toast.error('Could not save colors') }
  }, [palette])

  const saveSettings = useCallback(async () => {
    const lo = parseFloat(priceLow), hi = parseFloat(priceHigh)
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo <= 0 || hi < lo) {
      toast.error('Enter a valid price range (low ≤ high)'); return
    }
    try {
      const w = await api.instantQuote.updateWidget({ price_low: lo, price_high: hi })
      setWidget(w)
      toast.success('RoofIQ settings saved')
    } catch { toast.error('Could not save settings') }
  }, [priceLow, priceHigh])

  if (!widget) return null
  const hostedUrl = `${typeof window !== 'undefined' ? window.location.origin : ''}/q/${widget.widget_key}`
  const embedCode = `<iframe src="${hostedUrl}?embed=1" style="width:100%;max-width:640px;height:720px;border:0;border-radius:16px;" title="Instant roof quote"></iframe>`
  const copy = (text: string, what: string) =>
    void navigator.clipboard.writeText(text).then(() => toast.success(`${what} copied`))

  const funnel = analytics?.funnel || {}
  const hasFunnel = Object.keys(funnel).length > 0

  return (
    <section className="rounded-xl border border-white/10 bg-slate-900/50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">🎯 RoofIQ — your instant-quote lead machine</h2>
          <p className="text-xs text-slate-400">
            Homeowners get an AI roof report from this link; every completion lands in your pipeline below, scored.
          </p>
        </div>
        <button onClick={() => setSettingsOpen(o => !o)} className="rounded bg-slate-800 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-700">
          {settingsOpen ? 'Hide settings' : '⚙ Settings'}
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        <code className="max-w-full truncate rounded bg-slate-800 px-2 py-1.5 font-mono text-[11px] text-blue-200">{hostedUrl}</code>
        <button onClick={() => copy(hostedUrl, 'Link')} className="rounded bg-blue-600 px-2.5 py-1.5 font-semibold text-white hover:bg-blue-500">Copy link</button>
        <button onClick={() => copy(embedCode, 'Embed code')} className="rounded bg-slate-700 px-2.5 py-1.5 text-slate-200 hover:bg-slate-600">Copy website embed</button>
        <a href={hostedUrl} target="_blank" rel="noreferrer" className="rounded bg-slate-700 px-2.5 py-1.5 text-slate-200 hover:bg-slate-600">Preview ↗</a>
      </div>

      {settingsOpen && (
        <div className="mt-3 flex flex-wrap items-end gap-3 rounded-lg border border-white/10 bg-slate-800/40 p-3 text-xs">
          <label className="text-slate-400">
            Price / square — low
            <input type="number" value={priceLow} onChange={e => setPriceLow(e.target.value)}
              className="mt-1 block w-28 rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-white" />
          </label>
          <label className="text-slate-400">
            Price / square — high
            <input type="number" value={priceHigh} onChange={e => setPriceHigh(e.target.value)}
              className="mt-1 block w-28 rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-white" />
          </label>
          <button onClick={saveSettings} className="rounded bg-emerald-600 px-3 py-1.5 font-semibold text-white hover:bg-emerald-500">Save</button>
          <span className="text-slate-500">A 25-square roof at $450–650/sq shows ≈ $12,400–17,900.</span>

          {catalog.length > 0 && (
            <div className="mt-1 w-full border-t border-white/10 pt-3">
              <div className="mb-1 font-semibold text-slate-300">✨ RoofVision shingle colors</div>
              <p className="mb-2 text-[11px] text-slate-500">
                Pick the colors homeowners see their own roof rendered in — only the shingles you install.
                {palette.length === 0 && ' None selected uses a default palette.'}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {catalog.map(c => {
                  const on = palette.includes(c.key)
                  return (
                    <button key={c.key} onClick={() => toggleColor(c.key)}
                      className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition ${on ? 'border-emerald-500 bg-emerald-500/15 text-emerald-300' : 'border-slate-700 bg-slate-800 text-slate-400 hover:border-slate-600'}`}>
                      {on ? '✓ ' : ''}{c.name} <span className="text-slate-500">· {c.tier}</span>
                    </button>
                  )
                })}
              </div>
              <button onClick={savePalette} className="mt-2 rounded bg-emerald-600 px-3 py-1.5 font-semibold text-white hover:bg-emerald-500">Save colors</button>
            </div>
          )}
        </div>
      )}

      {hasFunnel && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/10 pt-3 text-xs">
          <span className="mr-1 text-[10px] uppercase tracking-wide text-slate-500">Last 30 days</span>
          {([
            ['view', 'Views'], ['address_entered', 'Addresses'], ['roof_confirmed', 'Confirmed'],
            ['qualified', 'Qualified'], ['lead_captured', 'Leads'],
          ] as [string, string][]).map(([k, label], i, arr) => (
            <span key={k} className="flex items-center gap-2">
              <span className="rounded bg-slate-800/70 px-2 py-1 text-center">
                <strong className="text-white">{funnel[k] ?? 0}</strong>
                <span className="ml-1 text-[10px] text-slate-500">{label}</span>
              </span>
              {i < arr.length - 1 && <span className="text-slate-600">→</span>}
            </span>
          ))}
          {(funnel.view ?? 0) > 0 && (
            <span className="text-[11px] text-slate-500">
              · {Math.round(((funnel.lead_captured ?? 0) / (funnel.view || 1)) * 100)}% completion
            </span>
          )}
          {analytics?.avg_score != null && (
            <span className="text-[11px] text-slate-500">· avg quality <strong className="text-slate-300">{analytics.avg_score}</strong>/100</span>
          )}
        </div>
      )}
    </section>
  )
}
