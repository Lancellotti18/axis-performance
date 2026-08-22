'use client'

/**
 * QuoteWidgetSettings — everything governing the public instant-quote page,
 * in Settings rather than buried in the CRM's RoofIQ card.
 *
 * These are the highest-stakes fields in the product: they decide what a
 * homeowner sees and what price they are quoted. They belong beside the
 * business profile, not three clicks into a tools panel.
 */
import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { api, type QuoteWidget } from '@/lib/api'

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

/** WCAG relative luminance. */
function luminance(hex: string): number | null {
  if (!HEX.test(hex)) return null
  let h = hex.slice(1)
  if (h.length === 3) h = h.split('').map(c => c + c).join('')
  const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const [r, g, b] = [0, 2, 4].map(i => f(parseInt(h.slice(i, i + 2), 16) / 255))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number | null {
  const la = luminance(a), lb = luminance(b)
  if (la == null || lb == null) return null
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

const CARD = 'rounded-2xl border border-white/10 bg-white/[0.03] p-6'
const INPUT = 'rounded-xl border border-white/12 bg-white/[0.06] px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-blue-400/50 focus:outline-none'

export default function QuoteWidgetSettings() {
  const [widget, setWidget] = useState<QuoteWidget | null>(null)
  const [priceLow, setPriceLow] = useState('')
  const [priceHigh, setPriceHigh] = useState('')
  const [showPrice, setShowPrice] = useState(false)
  const [brand, setBrand] = useState('')
  const [bg, setBg] = useState('')
  const [savingPrices, setSavingPrices] = useState(false)

  useEffect(() => {
    api.instantQuote.myWidget().then(w => {
      setWidget(w)
      setPriceLow(String(w.price_low ?? ''))
      setPriceHigh(String(w.price_high ?? ''))
      setShowPrice(!!w.show_instant_price)
      setBrand(w.brand_color || '')
      setBg(w.background_color || '')
    }).catch(() => {})
  }, [])

  const patch = useCallback(async (
    body: Partial<Pick<QuoteWidget, 'price_low' | 'price_high' | 'show_instant_price' | 'brand_color' | 'background_color'>>,
    ok: string,
  ) => {
    try {
      setWidget(await api.instantQuote.updateWidget(body))
      toast.success(ok)
      return true
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save')
      return false
    }
  }, [])

  const toggleShowPrice = useCallback(async () => {
    const next = !showPrice
    setShowPrice(next)
    const ok = await patch({ show_instant_price: next },
      next ? 'Homeowners will now see your estimate range' : 'Estimate hidden from homeowners')
    if (!ok) setShowPrice(!next)
  }, [showPrice, patch])

  const savePrices = useCallback(async () => {
    const lo = parseFloat(priceLow), hi = parseFloat(priceHigh)
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo <= 0 || hi < lo) {
      toast.error('Enter a valid range — low must be at or below high'); return
    }
    setSavingPrices(true)
    await patch({ price_low: lo, price_high: hi }, 'Pricing saved')
    setSavingPrices(false)
  }, [priceLow, priceHigh, patch])

  if (!widget) return null

  const ratio = brand && bg ? contrast(brand, bg) : null
  const lowContrast = ratio != null && ratio < 3
  const hostedUrl = `${typeof window !== 'undefined' ? window.location.origin : ''}/q/${widget.widget_key}`

  // Show what a typical roof actually quotes at, so changing a rate is not abstract.
  const lo = parseFloat(priceLow), hi = parseFloat(priceHigh)
  const sample = Number.isFinite(lo) && Number.isFinite(hi) && lo > 0 && hi >= lo
    ? { good: Math.round(25 * 1.1 * lo / 50) * 50, best: Math.round(25 * 1.1 * hi / 50) * 50 }
    : null

  return (
    <div className={CARD}>
      <h2 className="mb-1 text-sm font-semibold text-white">Instant quote widget</h2>
      <p className="mb-5 text-[12px] text-slate-400">
        What a homeowner sees on your public quote page. Changes go live immediately.
      </p>

      <div className="mb-5 flex items-start justify-between gap-4 rounded-xl border border-white/10 bg-white/[0.03] p-4">
        <div>
          <div className="text-sm font-medium text-white">Show the estimate</div>
          <p className="mt-0.5 text-[11px] text-slate-400">
            Off, a homeowner only gets &ldquo;someone will call you&rdquo;. On, they see a real range built from your rates.
          </p>
        </div>
        <button onClick={toggleShowPrice} role="switch" aria-checked={showPrice}
          aria-label="Show the estimate to homeowners"
          className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${showPrice ? 'bg-emerald-500' : 'bg-slate-600'}`}>
          <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${showPrice ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
        </button>
      </div>

      <div className="mb-5">
        <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-400">Installed rate, per square</div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-[11px] text-slate-400">Low
            <input value={priceLow} onChange={e => setPriceLow(e.target.value)} inputMode="decimal"
              className={`${INPUT} mt-1 block w-28`} />
          </label>
          <label className="text-[11px] text-slate-400">High
            <input value={priceHigh} onChange={e => setPriceHigh(e.target.value)} inputMode="decimal"
              className={`${INPUT} mt-1 block w-28`} />
          </label>
          <button onClick={savePrices} disabled={savingPrices}
            className="rounded-xl border border-white/12 bg-white/[0.06] px-4 py-2 text-sm font-medium text-slate-200 hover:border-white/20 disabled:opacity-50">
            {savingPrices ? 'Saving…' : 'Save rates'}
          </button>
        </div>
        {sample && (
          <p className="mt-2 text-[11px] text-slate-500">
            A typical 25-square roof quotes about{' '}
            <strong className="text-slate-300">${sample.good.toLocaleString()}</strong> to{' '}
            <strong className="text-slate-300">${sample.best.toLocaleString()}</strong>, including 10% waste.
          </p>
        )}
      </div>

      <div className="mb-5">
        <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-400">Page colors</div>
        <div className="flex flex-wrap items-end gap-4">
          <label className="text-[11px] text-slate-400">Accent / buttons
            <span className="mt-1 flex items-center gap-2">
              <input type="color" value={HEX.test(brand) ? brand : '#0056d6'} aria-label="Accent color"
                onChange={e => { setBrand(e.target.value); void patch({ brand_color: e.target.value }, 'Accent saved') }}
                className="h-9 w-10 cursor-pointer rounded border border-white/12 bg-transparent p-0.5" />
              <input value={brand} onChange={e => setBrand(e.target.value)} placeholder="#0056d6"
                onBlur={() => { if (!brand || HEX.test(brand)) void patch({ brand_color: brand || null }, 'Accent saved') }}
                className={`${INPUT} w-28 font-mono`} />
            </span>
          </label>
          <label className="text-[11px] text-slate-400">Page background
            <span className="mt-1 flex items-center gap-2">
              <input type="color" value={HEX.test(bg) ? bg : '#0b1220'} aria-label="Background color"
                onChange={e => { setBg(e.target.value); void patch({ background_color: e.target.value }, 'Background saved') }}
                className="h-9 w-10 cursor-pointer rounded border border-white/12 bg-transparent p-0.5" />
              <input value={bg} onChange={e => setBg(e.target.value)} placeholder="#0b1220"
                onBlur={() => { if (!bg || HEX.test(bg)) void patch({ background_color: bg || null }, 'Background saved') }}
                className={`${INPUT} w-28 font-mono`} />
            </span>
          </label>
        </div>

        {/* A pair that fails contrast makes the buttons sink into the page —
            exactly what you cannot see when you chose both colors yourself. */}
        {ratio != null && (
          <div className={`mt-3 rounded-lg border px-3 py-2 text-[11px] ${
            lowContrast ? 'border-amber-400/40 bg-amber-500/10 text-amber-100'
                        : 'border-emerald-400/25 bg-emerald-500/10 text-emerald-100'}`}>
            {lowContrast ? '⚠ ' : '✓ '}Accent against background is <strong>{ratio.toFixed(2)}:1</strong>
            {lowContrast
              ? ' — under the 3:1 minimum, so your buttons will be hard to pick out. Lighten the accent or darken the page.'
              : ' — comfortably readable.'}
          </div>
        )}

        <div className="mt-3 rounded-lg border border-white/10 p-3" style={{ background: HEX.test(bg) ? bg : '#0b1220' }}>
          <div className="text-[10px] uppercase tracking-wide text-white/70">Preview</div>
          <button className="mt-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-white"
            style={{ background: HEX.test(brand) ? brand : '#0056d6' }}>
            Get my free estimate
          </button>
        </div>
      </div>

      <div className="text-[11px] text-slate-500">
        Public page:{' '}
        <a href={hostedUrl} target="_blank" rel="noopener" className="text-blue-300 underline">{hostedUrl}</a>
      </div>
    </div>
  )
}
