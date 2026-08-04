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
  const [priceLow, setPriceLow] = useState('425')
  const [priceHigh, setPriceHigh] = useState('550')
  const [showPrice, setShowPrice] = useState(false)
  const [catalog, setCatalog] = useState<{ key: string; name: string; tier: string }[]>([])
  const [palette, setPalette] = useState<string[]>([])

  useEffect(() => {
    api.instantQuote.myWidget().then(w => {
      setWidget(w)
      setPriceLow(String(w.price_low)); setPriceHigh(String(w.price_high))
      setShowPrice(!!w.show_instant_price)
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

  const toggleShowPrice = useCallback(async () => {
    const next = !showPrice
    setShowPrice(next)
    try {
      const w = await api.instantQuote.updateWidget({ show_instant_price: next })
      setWidget(w)
      toast.success(next ? 'Homeowners will now see your estimate range' : 'Instant price hidden from homeowners')
    } catch {
      setShowPrice(!next)
      toast.error('Could not update')
    }
  }, [showPrice])

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

  // Live homeowner-price preview — mirrors the backend math (squares × 10% waste
  // × rate, rounded to $50) so the contractor sees the effect of their numbers
  // as they type instead of trusting a static example line.
  const WASTE = 1.10
  const round50 = (n: number) => Math.round(n / 50) * 50
  const money = (n: number) => n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
  const previewRange = (squares: number): { low: number; high: number } | null => {
    const lo = parseFloat(priceLow), hi = parseFloat(priceHigh)
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo <= 0 || hi < lo) return null
    const order = squares * WASTE
    return { low: round50(order * lo), high: round50(order * hi) }
  }
  const PRICE_EXAMPLES = [
    { label: 'Small home', squares: 15, sqft: '1,500 sq ft' },
    { label: 'Typical home', squares: 25, sqft: '2,500 sq ft' },
    { label: 'Large home', squares: 40, sqft: '4,000 sq ft' },
  ]

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
        <div className="mt-3 space-y-4 rounded-lg border border-white/10 bg-slate-800/40 p-4 text-xs">
          {/* Pricing — the number that powers the homeowner's instant estimate */}
          <div>
            <div className="text-sm font-semibold text-slate-100">💵 Your pricing</div>
            <p className="mt-0.5 max-w-prose text-[11px] leading-relaxed text-slate-400">
              This sets the instant estimate homeowners see. Enter your <strong className="text-slate-200">installed price per roofing square</strong> — 1 square = 100 sq ft of roof. Give a low–high range; homeowners see the range, never a single hard number.
            </p>

            <div className="mt-3 flex flex-wrap items-end gap-3">
              <label className="text-[11px] font-medium text-slate-400">
                Low end
                <div className="mt-1 flex items-center rounded-md border border-slate-700 bg-slate-800 focus-within:border-blue-500">
                  <span className="pl-2.5 text-slate-500">$</span>
                  <input type="number" inputMode="decimal" value={priceLow} onChange={e => setPriceLow(e.target.value)}
                    className="w-16 bg-transparent px-1.5 py-2 text-sm text-white outline-none" />
                  <span className="pr-2.5 text-[10px] text-slate-500">/&nbsp;square</span>
                </div>
              </label>
              <span className="pb-2 text-slate-600">to</span>
              <label className="text-[11px] font-medium text-slate-400">
                High end
                <div className="mt-1 flex items-center rounded-md border border-slate-700 bg-slate-800 focus-within:border-blue-500">
                  <span className="pl-2.5 text-slate-500">$</span>
                  <input type="number" inputMode="decimal" value={priceHigh} onChange={e => setPriceHigh(e.target.value)}
                    className="w-16 bg-transparent px-1.5 py-2 text-sm text-white outline-none" />
                  <span className="pr-2.5 text-[10px] text-slate-500">/&nbsp;square</span>
                </div>
              </label>
              <button onClick={saveSettings} className="rounded-md bg-emerald-600 px-3.5 py-2 font-semibold text-white hover:bg-emerald-500">Save pricing</button>
            </div>

            {/* Live preview — recalculates as they type */}
            <div className="mt-3 rounded-lg border border-white/10 bg-slate-900/60 p-3">
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500">What homeowners will see</div>
              <div className="space-y-1.5">
                {PRICE_EXAMPLES.map(ex => {
                  const r = previewRange(ex.squares)
                  return (
                    <div key={ex.squares} className="flex items-center justify-between gap-3">
                      <span className="text-slate-400">{ex.label} <span className="text-slate-600">· {ex.squares} sq · {ex.sqft}</span></span>
                      <span className="font-semibold tabular-nums text-slate-100">{r ? `${money(r.low)} – ${money(r.high)}` : <span className="text-rose-400">check range</span>}</span>
                    </div>
                  )
                })}
              </div>
              <p className="mt-2 border-t border-white/10 pt-2 text-[10px] leading-relaxed text-slate-500">
                Approximate — each homeowner’s number is calculated from their own measured roof, including the industry-standard 10% cut waste.
              </p>
            </div>

            {/* Show-to-homeowners toggle */}
            <button type="button" onClick={toggleShowPrice}
              className="mt-3 flex w-full items-center gap-3 rounded-lg border border-white/10 bg-slate-900/40 p-3 text-left transition-colors hover:bg-slate-900/70">
              <span className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${showPrice ? 'bg-emerald-500' : 'bg-slate-600'}`}>
                <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${showPrice ? 'left-[18px]' : 'left-0.5'}`} />
              </span>
              <span className="min-w-0">
                <span className="block text-[12px] font-semibold text-slate-100">Show these prices to homeowners</span>
                <span className="block text-[11px] text-slate-400">
                  {showPrice
                    ? 'On — the report shows this range with an “estimate only” note.'
                    : 'Off — homeowners see the material options without prices.'}
                </span>
              </span>
            </button>
          </div>

          {catalog.length > 0 && (
            <div className="border-t border-white/10 pt-3">
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
