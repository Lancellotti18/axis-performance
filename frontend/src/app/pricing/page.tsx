import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Pricing — Axis Performance',
  description:
    'Flat. Public. No per-seat tax. Month-to-month. Instant satellite roof quotes, scored exclusive leads, and a roofing CRM — starting free.',
}

const PLANS = [
  {
    name: 'RoofIQ Free',
    price: 0,
    tagline: 'Your website starts quoting roofs today',
    features: [
      'Instant satellite roof quotes on your site',
      'Homeowner web reports (shareable)',
      'Leads land in your CRM, scored 0–100',
      'No credit card required',
    ],
    cta: 'Start free',
    highlight: false,
  },
  {
    name: 'Solo',
    price: 49,
    tagline: 'For the owner-operator',
    features: [
      'Everything in Free',
      'Speed-to-lead alerts the second a lead lands',
      'One-click good/better/best proposals',
      'Roof measurement editor + PDF reports',
      'Your branding on every report',
    ],
    cta: 'Start free, upgrade when ready',
    highlight: false,
  },
  {
    name: 'Pro',
    price: 149,
    tagline: 'For growing crews — unlimited seats',
    features: [
      'Everything in Solo',
      'Unlimited team members — no per-seat tax',
      'Field-verified accuracy calibration',
      'Permit lookup + package builder',
      'Client portal for every job',
      'Priority support',
    ],
    cta: 'Start free, upgrade when ready',
    highlight: true,
  },
]

export default function PricingPage() {
  return (
    <main className="min-h-screen px-5 py-16 text-white" style={{ background: '#040810' }}>
      <div className="mx-auto max-w-5xl">
        <header className="mb-12 text-center">
          <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.28em] text-blue-300/90">Pricing</div>
          <h1 className="text-4xl font-bold tracking-tight">Flat. Public. No per-seat tax.</h1>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-white/60">
            Month-to-month. Cancel anytime. No setup fee. And never, ever pay for a shared lead again —
            every lead RoofIQ captures is yours alone.
          </p>
        </header>

        <div className="grid gap-5 md:grid-cols-3">
          {PLANS.map(p => (
            <div
              key={p.name}
              className={`relative flex flex-col rounded-2xl border p-6 ${
                p.highlight
                  ? 'border-blue-400/50 bg-blue-500/[0.07] shadow-[0_0_60px_-20px_rgba(59,130,246,0.5)]'
                  : 'border-white/10 bg-white/[0.03]'
              }`}
            >
              {p.highlight && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-blue-500 px-3 py-1 text-[10px] font-bold uppercase tracking-wide">
                  Most popular
                </span>
              )}
              <h2 className="text-lg font-bold">{p.name}</h2>
              <p className="mt-0.5 text-xs text-white/50">{p.tagline}</p>
              <div className="mt-4 flex items-baseline gap-1">
                <span className="text-4xl font-black">${p.price}</span>
                <span className="text-sm text-white/50">/mo</span>
              </div>
              <ul className="mt-5 flex-1 space-y-2.5 text-sm text-white/75">
                {p.features.map(f => (
                  <li key={f} className="flex gap-2">
                    <span className="text-emerald-400">✓</span>
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
              <Link
                href="/register"
                className={`mt-6 rounded-xl py-3 text-center text-sm font-bold transition ${
                  p.highlight
                    ? 'bg-blue-500 text-white hover:bg-blue-400'
                    : 'bg-white/[0.08] text-white hover:bg-white/[0.14]'
                }`}
              >
                {p.cta}
              </Link>
            </div>
          ))}
        </div>

        <section className="mx-auto mt-14 max-w-2xl space-y-4 text-sm text-white/60">
          <h3 className="text-center text-base font-semibold text-white">Why flat pricing?</h3>
          <p>
            Roofing software loves to nickel-and-dime: $60–100 per extra user, $13–19 per measurement
            report, price hikes with 60-day lock-ins. Axis is one flat price with unlimited seats —
            your office admin, your foreman, and your sales rep all work the same pipeline without
            the meter running.
          </p>
          <p>
            And the instant quote widget that others sell as a $125+/mo add-on? It&apos;s the free tier here.
            Try it on your own house first — that&apos;s the whole pitch.
          </p>
        </section>

        <p className="mt-12 text-center text-xs text-white/40">
          Questions? <Link href="/register" className="text-blue-300 underline">Create a free account</Link> or
          reach out — upgrades are handled personally while we onboard our founding contractors.
        </p>
      </div>
    </main>
  )
}
