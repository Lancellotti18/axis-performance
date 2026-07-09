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

export default function ReportPage() {
  const params = useParams<{ token: string }>()
  const token = params.token
  const [r, setR] = useState<Report | null>(null)
  const [notFound, setNotFound] = useState(false)

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

  const urgent = r.issues.includes('leak') || r.issues.includes('storm_damage') || r.roof_age === '25+'

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

        {/* Measurement */}
        <section className="mb-5 grid grid-cols-2 gap-3">
          <div className="rounded-xl border border-slate-200 bg-white p-4 text-center shadow-sm">
            <div className="text-2xl font-bold">{r.roof_sqft ? Math.round(r.roof_sqft).toLocaleString() : '—'} ft²</div>
            <div className="mt-0.5 text-[10px] uppercase tracking-wide text-slate-500">Measured roof area</div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4 text-center shadow-sm">
            <div className="text-2xl font-bold">{r.squares ?? '—'}</div>
            <div className="mt-0.5 text-[10px] uppercase tracking-wide text-slate-500">Roofing squares</div>
          </div>
        </section>

        {/* Price scenarios */}
        {r.price_low != null && (
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

        {/* What you told us + insight */}
        <section className="mb-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="text-sm font-semibold">Your roof&apos;s situation</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {r.roof_age && <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] text-slate-600">Age: {r.roof_age} yrs</span>}
            {r.stories && <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] text-slate-600">{r.stories} stor{r.stories === 1 ? 'y' : 'ies'}</span>}
            {r.issues.map(i => (
              <span key={i} className={`rounded-full px-2.5 py-1 text-[11px] ${i === 'leak' || i === 'storm_damage' ? 'bg-rose-50 font-semibold text-rose-700' : 'bg-slate-100 text-slate-600'}`}>
                {ISSUE_LABELS[i] || i}
              </span>
            ))}
          </div>
          {r.roof_age && <p className="mt-3 text-xs leading-relaxed text-slate-600">💡 {AGE_INSIGHT[r.roof_age]}</p>}
          {urgent && (
            <p className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-xs font-medium text-rose-800 ring-1 ring-rose-100">
              ⚠ Based on what you shared, we recommend a professional inspection <strong>soon</strong> — active issues compound quickly.
            </p>
          )}
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

        {/* CTAs */}
        <section className="mb-6 grid gap-2 print:hidden">
          {r.company_phone && (
            <>
              <a href={`tel:${r.company_phone}`}
                className="rounded-lg py-3.5 text-center text-sm font-semibold text-white transition hover:scale-[1.01]"
                style={{ background: 'linear-gradient(180deg, #3B82F6 0%, #1E40AF 100%)', boxShadow: '0 6px 20px rgba(59,130,246,0.35)' }}
              >📅 Book my free inspection — {r.company_phone}</a>
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
