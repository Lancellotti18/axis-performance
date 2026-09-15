'use client'

/**
 * The pricing page renders entirely from GET /api/v1/billing/plans, which
 * reads app/core/plans.py — the same table the entitlement check enforces.
 *
 * It used to hardcode its own numbers, and drifted badly: a $49 Solo and a
 * free tier that existed nowhere else in the system, live on the public site
 * while the code charged $299 and offered one promo report. A second copy of
 * the prices with nothing tying it to the first is how that happens, so there
 * is no longer a second copy.
 */
import { useEffect, useState } from 'react'
import Link from 'next/link'

const API_BASE = (process.env.NEXT_PUBLIC_API_URL || 'https://build-backend-jcp9.onrender.com').trim()

type Plan = {
  key: string
  name: string
  tagline: string
  monthly_usd: number
  annual_usd: number
  annual_monthly_equivalent: number
  annual_months_free: number
  reports: number | null
  reports_unlimited: boolean
  crews: number | null
  crews_unlimited: boolean
  included: string[]
}

type PlansResponse = {
  plans: Plan[]
  overage_report_usd: number
  lead_usd: number
  promo: { reports: number; note: string }
  leads: { headline: string; body: string; price_usd: number }
}

export default function PricingTables() {
  const [data, setData] = useState<PlansResponse | null>(null)
  const [annual, setAnnual] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    fetch(`${API_BASE}/api/v1/billing/plans`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(setData)
      .catch(() => setFailed(true))
  }, [])

  if (failed) {
    return (
      <Shell>
        <p className="text-center text-sm text-[#6b7280]">
          Pricing is unavailable right now.{' '}
          <a href="mailto:lance@rwinfrastructure.com" className="text-[#0060c4] underline">
            Email us
          </a>{' '}
          and we&apos;ll send it over.
        </p>
      </Shell>
    )
  }

  if (!data) {
    return (
      <Shell>
        <div className="grid gap-5 md:grid-cols-3">
          {[0, 1, 2].map(i => (
            <div key={i} className="h-[520px] animate-pulse rounded-2xl bg-[#e9ecf1]" />
          ))}
        </div>
      </Shell>
    )
  }

  return (
    <Shell>
      {/* Monthly / annual */}
      <div className="mb-8 flex items-center justify-center gap-3">
        <button
          onClick={() => setAnnual(false)}
          className={`rounded-lg px-4 py-2 text-sm font-semibold transition ${!annual ? 'bg-[#0060c4] text-white' : 'text-[#47536a] hover:bg-[#e9ecf1]'}`}
        >
          Monthly
        </button>
        <button
          onClick={() => setAnnual(true)}
          className={`rounded-lg px-4 py-2 text-sm font-semibold transition ${annual ? 'bg-[#0060c4] text-white' : 'text-[#47536a] hover:bg-[#e9ecf1]'}`}
        >
          Annual
          <span className="ml-2 rounded-full bg-[#0b6b53] px-2 py-0.5 text-[10px] font-bold text-white">
            2 months free
          </span>
        </button>
      </div>

      <div className="grid gap-5 md:grid-cols-3">
        {data.plans.map((p, i) => {
          const featured = i === 1
          return (
            <div
              key={p.key}
              className={`relative flex flex-col rounded-2xl border p-7 transition ${
                featured
                  ? 'border-[#0060c4] bg-white shadow-[0_8px_30px_-12px_rgba(0,96,196,0.35)] md:-mt-3'
                  : 'border-[#d3dae4] bg-white'
              }`}
            >
              {featured && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-[#0060c4] px-3 py-1 text-[10px] font-bold uppercase tracking-wide text-white">
                  Most popular
                </span>
              )}

              <h2 className="text-xl font-bold text-[#0e1420]">{p.name}</h2>
              <p className="mt-1 min-h-[36px] text-[13px] leading-snug text-[#6b7789]">
                {p.tagline}
              </p>

              <div className="mt-5 flex items-baseline gap-1">
                <span className="text-[42px] font-black leading-none tabular-nums text-[#0e1420]">
                  ${annual ? p.annual_monthly_equivalent : p.monthly_usd}
                </span>
                <span className="text-sm text-[#6b7789]">/mo</span>
              </div>
              <p className="mt-1.5 h-4 text-[11px] text-[#6b7789]">
                {annual ? `$${p.annual_usd.toLocaleString()} billed yearly` : 'billed monthly'}
              </p>

              {/* The only two things that differ between plans, given the full
                  weight of the card. The shared feature list used to sit here
                  three times over, which made the tiers look near-identical and
                  buried the numbers someone is actually comparing. */}
              <div className="mt-6 flex-1 space-y-4">
                <Stat
                  value={p.reports_unlimited ? '∞' : String(p.reports)}
                  unit={p.reports_unlimited ? 'Unlimited reports' : 'roof reports'}
                  caption="every month"
                  featured={featured}
                />
                <div className="h-px bg-[#e3e8ef]" />
                <Stat
                  value={p.crews_unlimited ? '∞' : String(p.crews)}
                  unit={p.crews_unlimited ? 'Unlimited crews' : p.crews === 1 ? 'dispatch crew' : 'dispatch crews'}
                  caption="on the board"
                  featured={featured}
                />
              </div>

              <Link
                href={`/register?plan=${p.key}&interval=${annual ? 'year' : 'month'}`}
                className={`mt-7 rounded-xl py-3.5 text-center text-sm font-bold transition ${
                  featured
                    ? 'bg-[#0060c4] text-white hover:bg-[#01498f]'
                    : 'bg-[#0e1420] text-white hover:bg-[#2a3543]'
                }`}
              >
                Choose {p.name}
              </Link>
            </div>
          )
        })}
      </div>

      {/* Said once, because it is true of all three. Repeating this list inside
          every card is what made the plans hard to tell apart. */}
      <div className="mt-8 rounded-2xl border border-[#d3dae4] bg-white p-7">
        <h3 className="text-center text-sm font-bold text-[#0e1420]">
          Included on every plan — no add-ons, no upsells
        </h3>
        <ul className="mx-auto mt-5 grid max-w-3xl gap-x-8 gap-y-3 text-sm text-[#374151] sm:grid-cols-2">
          {(data.plans[0]?.included ?? []).map(f => (
            <li key={f} className="flex gap-2.5">
              <span className="mt-[2px] text-[#0b6b53]">✓</span>
              <span>{f}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Extras — stated plainly rather than discovered at the point of sale */}
      <div className="mx-auto mt-8 grid max-w-3xl items-stretch gap-4 sm:grid-cols-2">
        <div className="flex flex-col rounded-xl border border-[#d3dae4] bg-white p-5">
          <h3 className="text-sm font-bold text-[#0e1420]">Need more reports?</h3>
          <p className="mt-1.5 text-sm leading-relaxed text-[#47536a]">
            Extra reports are <strong>${data.overage_report_usd}</strong> each, on any plan.
            You&apos;ll always be asked before anything is charged.
          </p>
        </div>
        <div className="flex flex-col rounded-xl border border-[#d3dae4] bg-white p-5">
          <h3 className="text-sm font-bold text-[#0e1420]">{data.leads.headline}</h3>
          <p className="mt-1.5 text-sm leading-relaxed text-[#47536a]">{data.leads.body}</p>
          <p className="mt-2 text-sm text-[#47536a]">
            <strong>${data.leads.price_usd}</strong> per lead, on any plan.
          </p>
        </div>
      </div>

      <p className="mx-auto mt-8 max-w-xl text-center text-xs leading-relaxed text-[#6b7789]">
        {data.promo.note} Month to month — cancel anytime and you keep access until the
        end of the period you&apos;ve paid for.
      </p>
    </Shell>
  )
}

function Stat({ value, unit, caption, featured }: {
  value: string; unit: string; caption: string; featured: boolean
}) {
  return (
    <div className="flex items-baseline gap-3">
      <span
        className={`min-w-[2ch] text-[32px] font-black leading-none tabular-nums ${
          featured ? 'text-[#0060c4]' : 'text-[#0e1420]'
        }`}
      >
        {value}
      </span>
      <span className="leading-tight">
        <span className="block text-sm font-semibold text-[#0e1420]">{unit}</span>
        <span className="block text-[11px] text-[#6b7789]">{caption}</span>
      </span>
    </div>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#f4f6f9] px-6 py-16 text-[#0e1420]">
      <div className="mx-auto max-w-5xl">
        <header className="mb-10 text-center">
          <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.28em] text-[#0060c4]">
            Pricing
          </div>
          <h1 className="text-4xl font-bold tracking-tight">Every tool, on every plan.</h1>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-[#47536a]">
            You only choose how many roof reports and crews you need. The CRM, dispatch
            board, quote widget and everything else are included whichever you pick.
          </p>
        </header>
        {children}
      </div>
    </div>
  )
}
