'use client'

/**
 * Roof Intelligence Report — the homeowner's shareable web report.
 * Chosen over a PDF deliberately: mobile-perfect, live CTAs, every open is
 * tracked (a speed-to-lead signal for the contractor), shareable by text,
 * and printable via the button (print stylesheet) for the few who want paper.
 */
import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'

import { api } from '@/lib/api'

const API_BASE = (process.env.NEXT_PUBLIC_API_URL || 'https://build-backend-jcp9.onrender.com').trim()

type Report = Awaited<ReturnType<typeof api.instantQuote.report>>

const SCENARIOS = [
  { name: 'Architectural asphalt', note: 'The standard — solid protection, best value', mult: 1.0 },
  { name: 'Premium / designer', note: 'Upgraded curb appeal + longer warranty', mult: 1.25 },
  { name: 'Standing-seam metal', note: '50+ year lifespan, energy-efficient', mult: 1.7 },
]

const AGE_INSIGHT: Record<string, string> = {
  '0-5': 'Your roof is nearly new. Keep gutters clear and schedule a checkup every few years.',
  '5-15': 'Mid-life roof — small maintenance now (sealed boots, secure flashing) prevents expensive repairs later.',
  '15-25': 'Your roof is entering the typical replacement window for asphalt shingles. Planning now means choosing on your schedule, not an emergency’s.',
  '25+': 'At 25+ years, your roof is past the typical asphalt lifespan. A professional inspection soon is strongly recommended — small leaks at this age become structural problems fast.',
  'unsure': 'Not sure of the age? A quick inspection pins it down — and most homeowners are within 5 years of a decision point without knowing it.',
}

const ISSUE_LABELS: Record<string, string> = {
  leak: '💧 Active leak', storm_damage: '⛈ Storm damage', missing_shingles: '🍂 Missing shingles',
  sagging: '📉 Sagging', planning: '📋 Planning ahead',
}

const WORK_LABELS: Record<string, string> = {
  replace: '🏠 Full replacement', repair: '🔧 Repair', unsure: '🤔 Deciding',
}
const CONDITION_LABELS: Record<string, string> = {
  no_damage: '✅ No visible damage', visible_damage: '⚠️ Visible damage', unsure: '🤔 Unsure',
}
const ROOFTOP_LABELS: Record<string, string> = {
  satellite_dish: '📡 Satellite dish', solar_panels: '☀️ Solar panels', hvac: '❄️ HVAC unit',
  antenna: '📶 Antenna', nothing: 'Nothing on roof', unsure: 'Unsure',
}
const DRAINAGE_LABELS: Record<string, string> = {
  external_gutters: '🌧 External gutters', internal_gutters: '🌧 Internal gutters',
  none: 'No gutters', unsure: 'Unsure',
}

type Render = { key: string; name: string; tier: string; image_url: string }

// RoofVision — the emotional close: the homeowner's OWN roof rendered in the
// shingle colors the contractor installs, each tagged to its price tier. A
// color-swatch picker swaps the hero image instantly.
function RoofVision({ renders, company, apiBase }: { renders: Render[]; company: string; apiBase: string }) {
  const [sel, setSel] = useState(0)
  const active = renders[Math.min(sel, renders.length - 1)]
  const src = (u: string) => (u.startsWith('http') ? u : `${apiBase}${u}`)
  return (
    <section className="mb-5 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="px-5 py-3">
        <div className="text-sm font-semibold">✨ See your home in a new roof</div>
        <p className="mt-0.5 text-[11px] text-slate-500">Your actual house, rendered in shingle colors {company} installs. Tap a color.</p>
      </div>
      <div className="relative bg-slate-100">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src(active.image_url)} alt={`Your roof in ${active.name}`} className="block w-full" />
        <div className="absolute left-3 top-3 rounded-full bg-black/60 px-2.5 py-1 text-[11px] font-semibold text-white backdrop-blur">
          {active.name} · {active.tier}
        </div>
        <div className="absolute bottom-2 right-3 rounded bg-black/50 px-1.5 py-0.5 text-[9px] text-white/80 backdrop-blur">
          ✨ AI preview — actual color may vary
        </div>
      </div>
      <div className="flex flex-wrap gap-2 p-4">
        {renders.map((rn, i) => (
          <button key={rn.key} onClick={() => setSel(i)}
            className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${i === sel ? 'border-blue-500 bg-blue-50 text-blue-900 shadow-sm' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'}`}>
            {rn.name}
          </button>
        ))}
      </div>
    </section>
  )
}

export default function ReportPage() {
  const params = useParams<{ token: string }>()
  const token = params.token
  const [r, setR] = useState<Report | null>(null)
  const [notFound, setNotFound] = useState(false)

  // Inspection booking
  const [bookDate, setBookDate] = useState('')
  const [bookWindow, setBookWindow] = useState('anytime')
  const [bookNote, setBookNote] = useState('')
  const [booking, setBooking] = useState(false)
  const [booked, setBooked] = useState(false)
  const [bookErr, setBookErr] = useState<string | null>(null)
  const [hp, setHp] = useState('')   // honeypot

  const submitBooking = () => {
    if (!token) return
    if (!bookDate) { setBookErr('Pick a day that works for you.'); return }
    setBooking(true); setBookErr(null)
    api.instantQuote.bookInspection(token, { preferred_date: bookDate, time_window: bookWindow, note: bookNote.trim() || undefined, website: hp || undefined })
      .then(res => { if (res.ok) setBooked(true); else setBookErr('Could not book — please call instead.') })
      .catch((e: unknown) => setBookErr(e instanceof Error ? e.message.replace(/\[HTTP \d+\]\s*/, '') : 'Could not book — please call instead.'))
      .finally(() => setBooking(false))
  }

  useEffect(() => {
    if (!token) return
    api.instantQuote.report(token).then(setR).catch(() => setNotFound(true))
  }, [token])

  const money = (v?: number | null) => v == null ? '—' : v.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

  if (notFound) {
    return <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6 text-slate-600">This report link isn&apos;t valid — ask your contractor for a fresh one.</main>
  }
  if (!r) {
    return <main className="flex min-h-screen items-center justify-center bg-slate-50"><span className="h-6 w-6 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" /></main>
  }

  const urgent = r.issues.includes('leak') || r.issues.includes('storm_damage') || r.roof_age === '25+' || r.details?.condition === 'visible_damage'

  return (
    <main className="min-h-screen px-4 py-10 text-slate-900 print:bg-white print:py-2 sm:px-8"
      style={{ background: 'linear-gradient(170deg, #f8fafc 0%, #eef4fb 55%, #f8fafc 100%)' }}>
      <div className="mx-auto max-w-2xl">
        {/* Header */}
        <header className="mb-6 text-center">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.28em] text-blue-600/80">Roof Intelligence Report</div>
          <h1 className="text-2xl font-bold tracking-tight">{r.company_name}</h1>
          <div className="mt-1 text-sm text-slate-500">Prepared for <strong className="text-slate-700">{r.first_name}</strong> · {r.address}</div>
          <div className="text-[11px] text-slate-400">{new Date(r.created_at).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}</div>
        </header>

        {/* Roof image */}
        {r.imagery_url && (
          <div className="mb-5 overflow-hidden rounded-2xl shadow-[0_10px_40px_-12px_rgba(15,40,80,0.15)] ring-1 ring-slate-200">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`${API_BASE}${r.imagery_url}`} alt="Satellite view of your roof" className="block w-full" />
            {r.roof_confirmed && (
              <div className="bg-emerald-50 px-3 py-1.5 text-center text-[11px] font-semibold text-emerald-700">✓ Roof location confirmed by you</div>
            )}
          </div>
        )}

        {/* RoofVision — your own roof in the shingle colors {company} installs */}
        {(r.details?.renders?.length ?? 0) > 0 && (
          <RoofVision renders={r.details!.renders!} company={r.company_name} apiBase={API_BASE} />
        )}

        {/* Measurement */}
        <section className="mb-2 grid grid-cols-2 gap-3">
          <div className="rounded-xl border border-slate-200 bg-white p-4 text-center shadow-sm">
            <div className="text-2xl font-bold">{r.roof_sqft ? Math.round(r.roof_sqft).toLocaleString() : '—'} ft²</div>
            <div className="mt-0.5 text-[10px] uppercase tracking-wide text-slate-500">Measured roof area</div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4 text-center shadow-sm">
            <div className="text-2xl font-bold">{r.squares ?? '—'}</div>
            <div className="mt-0.5 text-[10px] uppercase tracking-wide text-slate-500">Roofing squares</div>
          </div>
        </section>

        {/* Honest band — say HOW it was measured, in plain English */}
        {r.band && (
          <p className={`mb-5 rounded-lg px-3 py-2 text-[11px] leading-relaxed ring-1 ${r.band.level === 'tight' ? 'bg-emerald-50 text-emerald-800 ring-emerald-100' : 'bg-slate-50 text-slate-600 ring-slate-100'}`}>
            {r.band.level === 'tight' ? '🎯 ' : 'ℹ️ '}{r.band.how}
          </p>
        )}

        {/* Good / Better / Best */}
        {r.tiers && r.tiers.length > 0 ? (
          <section className="mb-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="text-sm font-semibold">Your options</div>
            <p className="mt-0.5 text-[11px] text-slate-500">Three ways to do this job — your exact price follows a free on-site review.</p>
            <div className="mt-3 space-y-2">
              {r.tiers.map((t, i) => (
                <div key={t.name} className={`flex items-center justify-between gap-3 rounded-lg px-3 py-2.5 ring-1 ${i === 1 ? 'bg-blue-50/60 ring-blue-200' : 'bg-slate-50 ring-slate-100'}`}>
                  <div>
                    <div className="text-sm font-semibold">{t.name} — {t.headline}{i === 1 && <span className="ml-1.5 rounded-full bg-blue-600 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white">Popular</span>}</div>
                    <div className="text-[11px] text-slate-500">{t.detail}</div>
                  </div>
                  <div className="shrink-0 text-right text-sm font-bold text-slate-800">{money(t.price)}</div>
                </div>
              ))}
            </div>
            {r.financing && (
              <p className="mt-3 text-center text-xs font-semibold text-emerald-700">
                💳 From {money(r.financing.from_per_month)}/mo
                <span className="mt-0.5 block text-[10px] font-normal text-slate-400">{r.financing.disclaimer}</span>
              </p>
            )}
          </section>
        ) : r.price_low != null && (
          <section className="mb-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="text-sm font-semibold">Estimated investment by material</div>
            <p className="mt-0.5 text-[11px] text-slate-500">Rough ranges — your exact price follows a free on-site review.</p>
            <div className="mt-3 space-y-2">
              {SCENARIOS.map(sc => (
                <div key={sc.name} className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2.5 ring-1 ring-slate-100">
                  <div>
                    <div className="text-sm font-semibold">{sc.name}</div>
                    <div className="text-[11px] text-slate-500">{sc.note}</div>
                  </div>
                  <div className="shrink-0 text-right text-sm font-bold text-slate-800">
                    {money((r.price_low ?? 0) * sc.mult)}–{money((r.price_high ?? 0) * sc.mult)}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Show the math — verify me, don't trust me */}
        {r.math && (
          <details className="mb-5 rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
            <summary className="cursor-pointer select-none text-sm font-semibold text-slate-700">🧮 How we got this number</summary>
            <div className="mt-3 space-y-1.5 text-xs text-slate-600">
              <div className="flex justify-between"><span>Measured roof area</span><strong>{r.math.roof_sqft.toLocaleString()} ft²</strong></div>
              <div className="flex justify-between"><span>÷ 100 = roofing squares</span><strong>{r.math.squares}</strong></div>
              <div className="flex justify-between"><span>+ {r.math.waste_pct}% cut waste (industry standard)</span><strong>{r.math.order_squares} squares to order</strong></div>
              {r.math.rate_low_per_sq && r.math.rate_high_per_sq && (
                <div className="flex justify-between"><span>× installed rate per square</span><strong>{money(r.math.rate_low_per_sq)}–{money(r.math.rate_high_per_sq)}</strong></div>
              )}
              <div className="mt-2 border-t border-slate-100 pt-2 text-[11px] text-slate-500">
                <strong>How it was measured:</strong>{' '}
                {r.math.method === 'solar'
                  ? 'True 3D roof geometry from Google aerial solar data (real area + pitch).'
                  : r.math.method === 'footprint'
                    ? <>Building footprint from map data × {r.math.slope_factor} typical-pitch factor (plan-view estimate).</>
                    : 'Automatic measurement unavailable — placeholder range.'}
              </div>
              {r.math.calibration && (
                <div className="rounded-md bg-emerald-50 px-2.5 py-1.5 text-[11px] text-emerald-800">✓ {r.math.calibration.note}</div>
              )}
            </div>
          </details>
        )}

        {/* What you told us + insight */}
        <section className="mb-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="text-sm font-semibold">Your roof&apos;s situation</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {r.details?.work_type && <span className="rounded-full bg-blue-50 px-2.5 py-1 text-[11px] font-medium text-blue-800">{WORK_LABELS[r.details.work_type] || r.details.work_type}</span>}
            {r.details?.condition && <span className={`rounded-full px-2.5 py-1 text-[11px] ${r.details.condition === 'visible_damage' ? 'bg-rose-50 font-semibold text-rose-700' : 'bg-slate-100 text-slate-600'}`}>{CONDITION_LABELS[r.details.condition] || r.details.condition}</span>}
            {r.roof_age && <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] text-slate-600">Age: {r.roof_age} yrs</span>}
            {r.stories && <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] text-slate-600">{r.stories} stor{r.stories === 1 ? 'y' : 'ies'}</span>}
            {r.issues.map(i => (
              <span key={i} className={`rounded-full px-2.5 py-1 text-[11px] ${i === 'leak' || i === 'storm_damage' ? 'bg-rose-50 font-semibold text-rose-700' : 'bg-slate-100 text-slate-600'}`}>
                {ISSUE_LABELS[i] || i}
              </span>
            ))}
            {(r.details?.rooftop_items || []).filter(x => x !== 'nothing' && x !== 'unsure').map(x => (
              <span key={x} className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] text-slate-600">{ROOFTOP_LABELS[x] || x}</span>
            ))}
            {r.details?.chimney_skylights && <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] text-slate-600">🧱 Chimney / skylights</span>}
            {r.details?.attic === true && <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] text-slate-600">🏚 Attic</span>}
            {r.details?.drainage && r.details.drainage !== 'unsure' && <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] text-slate-600">{DRAINAGE_LABELS[r.details.drainage] || r.details.drainage}</span>}
          </div>
          {r.roof_age && <p className="mt-3 text-xs leading-relaxed text-slate-600">💡 {AGE_INSIGHT[r.roof_age]}</p>}
          {urgent && (
            <p className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-xs font-medium text-rose-800 ring-1 ring-rose-100">
              ⚠ Based on what you shared, we recommend a professional inspection <strong>soon</strong> — active issues compound quickly.
            </p>
          )}
        </section>

        {/* Trust & Verify — pre-empt "is this roofer legit / is this a scam?" */}
        <section className="mb-5 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap gap-x-4 gap-y-2 text-[11px]">
            <span className="inline-flex items-center gap-1.5 font-medium text-emerald-700">
              <span className="text-emerald-500">✓</span> Satellite-verified measurement
            </span>
            {r.company_license && (
              <span className="inline-flex items-center gap-1.5 font-medium text-slate-600">
                <span className="text-blue-500">✓</span> Licensed #{r.company_license}
              </span>
            )}
            {r.service_area && (
              <span className="inline-flex items-center gap-1.5 font-medium text-slate-600">
                <span className="text-blue-500">📍</span> Serving {r.service_area}
              </span>
            )}
          </div>
          <p className="mt-2.5 border-t border-slate-100 pt-2.5 text-[11px] leading-relaxed text-slate-500">
            🔒 Your details went to <strong className="text-slate-700">{r.company_name}</strong> only — not five call
            centers. No door-knock, no pressure, no shared leads.
          </p>
        </section>

        {/* Disclaimer */}
        <section className="mb-5 rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="text-[11px] leading-relaxed text-amber-900/80">
            <strong>ⓘ About this report:</strong> a rough, AI-powered educational estimate built from satellite
            imagery and regional pricing data — not an official quote or inspection. Final pricing depends on an
            on-site evaluation: decking condition, tear-off layers, material selection, and access.
            <strong> {r.company_name} provides an exact written proposal after a free on-site review.</strong>
          </p>
        </section>

        {/* What happens next */}
        <section className="mb-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="text-sm font-semibold">What happens next</div>
          <ul className="mt-2 space-y-1.5 text-xs text-slate-600">
            <li>✓ <strong>{r.company_name}</strong> has your request and will reach out to schedule a <strong>free, precise on-site quote</strong> — this report is a rough instant estimate, not a final price.</li>
            <li>✓ Ready sooner? Call or text below to get on the schedule first.</li>
            <li>✓ Keep this link — your report updates if anything changes.</li>
          </ul>
        </section>

        {/* Book a free inspection — self-serve, lands on the contractor's calendar */}
        <section className="mb-5 overflow-hidden rounded-2xl border border-blue-200 bg-white shadow-sm print:hidden">
          <div className="px-5 py-3 text-white" style={{ background: 'linear-gradient(180deg, #3B82F6 0%, #1E40AF 100%)' }}>
            <div className="text-sm font-semibold">📅 Book your free on-site inspection</div>
            <div className="text-[11px] text-blue-50/90">Pick a day and {r.company_name} will confirm — no charge, no obligation.</div>
          </div>
          {booked ? (
            <div className="p-5 text-center">
              <div className="text-2xl">✅</div>
              <div className="mt-1 text-sm font-semibold text-slate-800">You&apos;re on the schedule!</div>
              <p className="mx-auto mt-1 max-w-sm text-xs text-slate-500">
                {r.company_name} has your request for <strong>{new Date(bookDate + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</strong>
                {bookWindow !== 'anytime' && <> ({bookWindow})</>} and will reach out to confirm. {r.company_phone && <>Need it sooner? Call {r.company_phone}.</>}
              </p>
            </div>
          ) : (
            <div className="p-5">
              {/* honeypot */}
              <input type="text" value={hp} onChange={e => setHp(e.target.value)} name="website" autoComplete="off" tabIndex={-1} aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 opacity-0" />
              <label className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Preferred day</label>
              <input type="date" value={bookDate} min={new Date().toISOString().slice(0, 10)}
                onChange={e => setBookDate(e.target.value)}
                className="mt-1.5 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20" />

              <div className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Time that works best</div>
              <div className="mt-1.5 grid grid-cols-4 gap-1.5">
                {[['anytime', 'Anytime'], ['morning', 'Morning'], ['afternoon', 'Afternoon'], ['evening', 'Evening']].map(([k, lbl]) => (
                  <button key={k} onClick={() => setBookWindow(k)}
                    className={`rounded-lg border px-2 py-2 text-xs font-medium transition ${bookWindow === k ? 'border-blue-500 bg-blue-50 text-blue-900 shadow-sm' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'}`}>{lbl}</button>
                ))}
              </div>

              <input type="text" value={bookNote} onChange={e => setBookNote(e.target.value)}
                placeholder="Anything we should know? (optional)"
                className="mt-3 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20" />

              {bookErr && <p className="mt-2 text-xs text-rose-600">{bookErr}</p>}
              <button onClick={submitBooking} disabled={booking}
                className="mt-3 w-full rounded-lg bg-emerald-600 py-3 text-sm font-semibold text-white shadow-[0_6px_18px_rgba(5,150,105,0.3)] transition hover:bg-emerald-500 disabled:opacity-50">
                {booking ? 'Booking…' : 'Request my free inspection'}
              </button>
            </div>
          )}
        </section>

        {/* CTAs */}
        <section className="mb-6 grid gap-2 print:hidden">
          {r.company_phone && (
            <>
              <a href={`tel:${r.company_phone}`}
                className="rounded-lg bg-slate-100 py-3 text-center text-sm font-semibold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-200"
              >📞 Prefer to call? {r.company_phone}</a>
              <a href={`sms:${r.company_phone}`}
                className="rounded-lg bg-emerald-600 py-3 text-center text-sm font-semibold text-white hover:bg-emerald-500"
              >💬 Text {r.company_name}</a>
            </>
          )}
          <div className="flex gap-2">
            <button
              onClick={() => { void navigator.share?.({ title: 'My Roof Intelligence Report', url: window.location.href }).catch(() => navigator.clipboard.writeText(window.location.href)) }}
              className="flex-1 rounded-lg bg-slate-100 py-2.5 text-sm font-semibold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-200"
            >↗ Share</button>
            <button onClick={() => window.print()}
              className="flex-1 rounded-lg bg-slate-100 py-2.5 text-sm font-semibold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-200"
            >🖨 Print / PDF</button>
          </div>
        </section>

        <p className="text-center text-[10px] text-slate-400">Powered by Axis Performance aerial + solar intelligence.</p>
      </div>
    </main>
  )
}
