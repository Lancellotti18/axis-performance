'use client'

/**
 * Public instant-quote page — homeowner-facing, mobile-first.
 *
 * Hosted at /q/{widgetKey}: contractors share it from their website (iframe
 * embed with ?embed=1), Google Business Profile, Facebook, ads, or a QR code.
 * Flow: address → instant roof size + price range → contact capture → the
 * lead lands in the contractor's Axis lead inbox.
 */
import { useCallback, useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'next/navigation'

import { api } from '@/lib/api'

type Quote = Awaited<ReturnType<typeof api.instantQuote.quote>>

// Material options adjust the shown range client-side (base range = the
// contractor's architectural-asphalt pricing).
const MATERIALS = [
  { key: 'arch', label: 'Architectural asphalt', note: 'Most common', mult: 1.0 },
  { key: 'designer', label: 'Premium / designer', note: 'Upgraded look + warranty', mult: 1.25 },
  { key: 'metal', label: 'Standing-seam metal', note: 'Longest lifespan', mult: 1.7 },
] as const

const URGENCY = [
  { key: 'asap', label: 'As soon as possible' },
  { key: '1-3mo', label: 'In the next 1–3 months' },
  { key: 'research', label: 'Just researching prices' },
] as const

/** Monthly payment estimate — 9.9% APR, 120 months. Display-only teaser. */
function monthly(principal: number): number {
  const r = 0.099 / 12
  const n = 120
  return principal * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1)
}

export default function InstantQuotePage() {
  const params = useParams<{ key: string }>()
  const search = useSearchParams()
  const widgetKey = params.key
  const embedded = search.get('embed') === '1'

  const [company, setCompany] = useState<string>('')
  const [companyPhone, setCompanyPhone] = useState<string>('')
  const [notFound, setNotFound] = useState(false)

  const [address, setAddress] = useState('')
  const [loading, setLoading] = useState(false)
  const [quote, setQuote] = useState<Quote | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Quote refinement tools
  const [material, setMaterial] = useState<typeof MATERIALS[number]['key']>('arch')
  const [factorsOpen, setFactorsOpen] = useState(false)

  // Lead form
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [urgency, setUrgency] = useState<typeof URGENCY[number]['key']>('asap')
  const [insurance, setInsurance] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState<string | null>(null)

  useEffect(() => {
    if (!widgetKey) return
    api.instantQuote.widgetConfig(widgetKey)
      .then(c => { setCompany(c.company_name); setCompanyPhone(c.phone) })
      .catch(() => setNotFound(true))
  }, [widgetKey])

  const getQuote = useCallback(async () => {
    if (address.trim().length < 6) { setError('Enter your full address, including the city.'); return }
    setLoading(true); setError(null); setQuote(null); setDone(null)
    try {
      const q = await api.instantQuote.quote(widgetKey, address.trim())
      setQuote(q)
      if (!q.found) setError(q.message || 'Address not found.')
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/\[HTTP \d+\]\s*/, '') : 'Something went wrong — try again.')
    } finally {
      setLoading(false)
    }
  }, [address, widgetKey])

  const submitLead = useCallback(async () => {
    if (name.trim().length < 2) { setError('Please enter your name.'); return }
    if (!phone.trim() && !email.trim()) { setError('A phone number or email is needed so we can reach you.'); return }
    setSubmitting(true); setError(null)
    try {
      const mat = MATERIALS.find(m => m.key === material)
      const urg = URGENCY.find(u => u.key === urgency)
      const res = await api.instantQuote.submitLead(widgetKey, {
        name: name.trim(),
        phone: phone.trim() || undefined,
        email: email.trim() || undefined,
        address: quote?.address || address.trim(),
        lat: quote?.lat, lng: quote?.lng,
        squares_estimate: quote?.squares,
        price_low: quote?.price_low, price_high: quote?.price_high,
        quote_source: quote?.source,
        notes: [
          mat ? `Interested in: ${mat.label}` : null,
          urg ? `Timeline: ${urg.label}` : null,
          insurance ? 'Possible insurance claim (storm damage)' : null,
        ].filter(Boolean).join(' · '),
      })
      setDone(res.message)
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/\[HTTP \d+\]\s*/, '') : 'Could not send — please call instead.')
    } finally {
      setSubmitting(false)
    }
  }, [name, phone, email, quote, address, widgetKey])

  const money = (v?: number) => v == null ? '—' : v.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

  if (notFound) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#060b18] p-6 text-slate-300">
        This quote tool isn&apos;t available. Please contact the contractor directly.
      </main>
    )
  }

  return (
    <main className={`min-h-screen bg-[#060b18] text-slate-100 ${embedded ? 'p-3' : 'flex items-center justify-center p-4 sm:p-8'}`}>
      <div className="w-full max-w-xl">
        {/* Header */}
        <div className="mb-6 text-center">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.28em] text-blue-300/80">Instant roof quote</div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{company || '…'}</h1>
          <p className="mt-2 text-sm text-slate-400">
            Type your address — we measure your roof from aerial data and show a real price range in seconds.
          </p>
        </div>

        {/* Address input */}
        <div
          className="rounded-2xl border border-white/10 p-5 shadow-2xl"
          style={{ background: 'linear-gradient(160deg, rgba(15,23,42,0.9), rgba(8,13,28,0.95))' }}
        >
          <label className="text-xs font-semibold uppercase tracking-wide text-slate-400">Property address</label>
          <div className="mt-2 flex gap-2">
            <input
              type="text"
              value={address}
              onChange={e => setAddress(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void getQuote() }}
              placeholder="123 Main St, Springfield, IL"
              className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-3 text-sm text-white placeholder:text-slate-500"
            />
            <button
              onClick={getQuote}
              disabled={loading}
              className="shrink-0 rounded-lg px-4 py-3 text-sm font-semibold text-white transition hover:scale-[1.02] disabled:opacity-50"
              style={{ background: 'linear-gradient(180deg, #3B82F6 0%, #1E40AF 100%)', boxShadow: '0 6px 20px rgba(59,130,246,0.45)' }}
            >{loading ? 'Measuring…' : 'Get my quote'}</button>
          </div>
          {loading && (
            <div className="mt-3 flex items-center gap-2 text-xs text-blue-300">
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-blue-400 border-t-transparent" />
              Measuring your roof from satellite + solar data…
            </div>
          )}
          {error && <p className="mt-3 text-xs text-rose-400">{error}</p>}

          {/* Quote result */}
          {quote?.found && !done && (
            <div className="mt-5 border-t border-white/10 pt-5">
              <div className="text-xs text-slate-400">{quote.address}</div>
              {quote.measured ? (() => {
                const mult = MATERIALS.find(m => m.key === material)?.mult ?? 1
                const lo = (quote.price_low ?? 0) * mult
                const hi = (quote.price_high ?? 0) * mult
                return (
                  <>
                    {/* Material picker — the range updates live */}
                    <div className="mt-3">
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Roof material</div>
                      <div className="mt-1.5 grid grid-cols-3 gap-1.5">
                        {MATERIALS.map(m => (
                          <button
                            key={m.key}
                            onClick={() => setMaterial(m.key)}
                            className={`rounded-lg border px-2 py-2 text-center transition ${
                              material === m.key
                                ? 'border-blue-400/60 bg-blue-500/15 text-white'
                                : 'border-white/10 bg-slate-800/50 text-slate-400 hover:text-white'
                            }`}
                          >
                            <div className="text-[11px] font-semibold leading-tight">{m.label}</div>
                            <div className="mt-0.5 text-[9px] text-slate-500">{m.note}</div>
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="mt-3 grid grid-cols-2 gap-3">
                      <div className="rounded-xl border border-white/10 bg-slate-800/50 p-3 text-center">
                        <div className="text-xl font-bold text-white">{quote.roof_sqft?.toLocaleString()} ft²</div>
                        <div className="mt-0.5 text-[10px] uppercase tracking-wide text-slate-500">Measured roof area</div>
                      </div>
                      <div className="rounded-xl border border-emerald-400/25 bg-emerald-500/10 p-3 text-center">
                        <div className="text-xl font-bold text-emerald-300">{money(lo)}–{money(hi)}</div>
                        <div className="mt-0.5 text-[10px] uppercase tracking-wide text-emerald-400/70">Estimated range</div>
                        <div className="mt-1 text-[10px] text-slate-400">
                          or from <strong className="text-emerald-200">{money(monthly(lo))}/mo</strong> with financing*
                        </div>
                      </div>
                    </div>

                    {/* Honest expectations — this is an estimate, and here's why it varies */}
                    <div className="mt-3 rounded-lg border border-amber-400/25 bg-amber-500/[0.07] p-3">
                      <div className="text-[11px] font-semibold text-amber-200">
                        ⓘ This is an instant estimate — not your official quote.
                      </div>
                      <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
                        It&apos;s based on an aerial measurement of your roof and typical pricing.
                        Your firm quote comes after {company || 'the contractor'} verifies the
                        details below — the final price can be higher or lower.
                      </p>
                      <button
                        onClick={() => setFactorsOpen(o => !o)}
                        className="mt-1.5 text-[11px] font-semibold text-amber-300/90 underline-offset-2 hover:underline"
                      >{factorsOpen ? 'Hide' : 'What can change the price?'}</button>
                      {factorsOpen && (
                        <ul className="mt-2 space-y-1 text-[11px] text-slate-400">
                          <li>• <strong className="text-slate-300">Roof steepness &amp; height</strong> — steeper or multi-story roofs take more labor and safety setup</li>
                          <li>• <strong className="text-slate-300">Layers to tear off</strong> — removing two or more old shingle layers costs more than one</li>
                          <li>• <strong className="text-slate-300">Decking condition</strong> — rotted or soft plywood found during tear-off is replaced per sheet</li>
                          <li>• <strong className="text-slate-300">Material &amp; color choice</strong> — the exact shingle line and warranty level you pick</li>
                          <li>• <strong className="text-slate-300">Roof complexity</strong> — chimneys, skylights, valleys and dormers add flashing work</li>
                          <li>• <strong className="text-slate-300">Local code &amp; permits</strong> — ice-and-water barrier requirements and permit fees vary by town</li>
                        </ul>
                      )}
                      <p className="mt-1.5 text-[10px] text-slate-500">
                        *Financing example: 9.9% APR, 120 months, subject to credit approval. Terms vary.
                      </p>
                    </div>
                  </>
                )
              })() : (
                <p className="mt-3 text-sm text-amber-300/90">{quote.message}</p>
              )}

              {/* Lead capture */}
              <div className="mt-5 rounded-xl border border-blue-400/20 bg-blue-500/5 p-4">
                <div className="text-sm font-semibold text-white">Get your official quote — free, no obligation</div>
                <p className="mt-1 text-xs text-slate-400">
                  {company || 'The contractor'} verifies the measurement and the factors above, then gives you a firm price in writing.
                </p>
                <div className="mt-3 grid gap-2">
                  <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Your name"
                    className="rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-2.5 text-sm text-white placeholder:text-slate-500" />
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <input type="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="Phone"
                      className="rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-2.5 text-sm text-white placeholder:text-slate-500" />
                    <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Email"
                      className="rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-2.5 text-sm text-white placeholder:text-slate-500" />
                  </div>
                  <select
                    value={urgency}
                    onChange={e => setUrgency(e.target.value as typeof URGENCY[number]['key'])}
                    className="rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-2.5 text-sm text-white"
                  >
                    {URGENCY.map(u => <option key={u.key} value={u.key}>When do you need this? — {u.label}</option>)}
                  </select>
                  <label className="flex items-center gap-2 text-xs text-slate-300">
                    <input type="checkbox" checked={insurance} onChange={e => setInsurance(e.target.checked)}
                      className="h-4 w-4 rounded border-slate-600 bg-slate-800" />
                    My roof may have storm damage (possible insurance claim)
                  </label>
                  <button
                    onClick={submitLead}
                    disabled={submitting}
                    className="rounded-lg bg-emerald-600 py-3 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
                  >{submitting ? 'Sending…' : 'Get my official quote →'}</button>
                </div>
              </div>
            </div>
          )}

          {done && (
            <div className="mt-5 rounded-xl border border-emerald-400/30 bg-emerald-500/10 p-4 text-center">
              <div className="text-2xl">✅</div>
              <div className="mt-1 text-sm font-semibold text-emerald-200">{done}</div>
              {companyPhone && (
                <a href={`tel:${companyPhone}`} className="mt-3 inline-block rounded-lg bg-slate-800 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-700">
                  Or call now: {companyPhone}
                </a>
              )}
            </div>
          )}
        </div>

        {!embedded && (
          <p className="mt-4 text-center text-[10px] text-slate-600">
            Measurements powered by Axis Performance aerial + solar data.
          </p>
        )}
      </div>
    </main>
  )
}
