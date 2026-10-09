'use client'

/**
 * Who may use the app right now.
 *
 * A signed-in account needs an active subscription OR a running promo (a
 * company code's 7 days). Otherwise every page shows the plan screen instead —
 * "Thank you for trying Axis" when a trial has ended, "Choose a plan" when
 * there never was one. Settings and Checkout stay reachable so they can pay.
 *
 * The server enforces the same rule on every feature endpoint (402
 * access_required); this screen is what the contractor sees instead of a
 * page full of errors. While billing enforcement is off, nothing is locked.
 */
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import toast from 'react-hot-toast'
import { api, type PromoState } from '@/lib/api'
import PromoCodeBox, { PENDING_CODE_KEY } from './PromoCodeBox'

type Me = Awaited<ReturnType<typeof api.billing.me>>
type Plan = {
  key: string; name: string; tagline?: string; monthly_usd: number; annual_usd: number
  annual_monthly_equivalent: number; reports: number | null; reports_unlimited: boolean
  crews: number | null; crews_unlimited: boolean
}

const ALWAYS_OPEN = ['/settings', '/checkout']
const ACTIVE = new Set(['active', 'trialing', 'past_due'])

export default function AccessGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || ''
  const [me, setMe] = useState<Me | null>(null)

  const load = useCallback(async () => {
    try { setMe(await api.billing.me()) } catch { /* the server still enforces */ }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      // A code typed at sign-up is redeemed the first time they are signed in.
      let pending: string | null = null
      try { pending = localStorage.getItem(PENDING_CODE_KEY) } catch { /* ignore */ }
      if (pending) {
        try {
          const r = await api.billing.redeemCode(pending)
          toast.success(`Welcome! ${r.free_reports} free reports and ${r.access_days} days of full access are active.`)
        } catch (e) {
          toast.error(e instanceof Error ? e.message : 'Your code could not be redeemed.')
        }
        try { localStorage.removeItem(PENDING_CODE_KEY) } catch { /* ignore */ }
      }
      if (!cancelled) await load()
    })()
    const t = setInterval(load, 5 * 60 * 1000)     // the 7-day clock can run out mid-session
    return () => { cancelled = true; clearInterval(t) }
  }, [load])

  if (!me) return <>{children}</>
  const status = String((me.subscription as Record<string, unknown> | null)?.status || 'none')
  const subscribed = me.has_plan && ACTIVE.has(status)
  const promo = me.promo
  const open = me.is_admin || subscribed || promo?.active || !me.enforcing
  const exempt = ALWAYS_OPEN.some(p => pathname.startsWith(p))

  if (!open && !exempt) return <PlanScreen promo={promo} onRedeemed={load} />
  return (
    <>
      {promo?.active && !subscribed && <TrialBanner promo={promo} />}
      {children}
    </>
  )
}

function TrialBanner({ promo }: { promo: PromoState }) {
  const days = `${promo.days_left} day${promo.days_left === 1 ? '' : 's'}`
  const reports = `${promo.reports_left} free report${promo.reports_left === 1 ? '' : 's'}`
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-emerald-200 bg-emerald-50 px-6 py-2 text-sm text-emerald-900">
      <span>
        <strong>Free trial:</strong> {days} and {reports} left
        {promo.founding_member && <span className="ml-2 rounded-full bg-emerald-600 px-2 py-0.5 text-[11px] font-semibold text-white">Founding member</span>}
      </span>
      <Link href="/settings" className="font-semibold underline underline-offset-2">Choose a plan</Link>
    </div>
  )
}

function PlanScreen({ promo, onRedeemed }: { promo?: PromoState; onRedeemed: () => void }) {
  const [plans, setPlans] = useState<Plan[]>([])
  const [annual, setAnnual] = useState(false)
  const ended = !!promo?.ended

  useEffect(() => {
    fetch(`${(process.env.NEXT_PUBLIC_API_URL || 'https://build-backend-jcp9.onrender.com').trim()}/api/v1/billing/plans`)
      .then(r => r.json()).then(d => setPlans(d.plans || [])).catch(() => {})
  }, [])

  return (
    <div className="mx-auto max-w-4xl px-6 py-12">
      <div className="text-center">
        {ended ? (
          <>
            <h1 className="text-2xl font-bold text-[#1a1a1a]">Thank you for trying Axis</h1>
            <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-[#4b5563]">
              Your free trial has ended. I hope it saved you time on your bids. To keep measuring
              roofs, building reports and material lists, choose a plan below.
              {promo?.founding_member && (
                <> As a <strong>founding member</strong>, today&apos;s pricing stays locked in for as long as you&apos;re subscribed.</>
              )}
            </p>
          </>
        ) : (
          <>
            <h1 className="text-2xl font-bold text-[#1a1a1a]">Choose a plan to start using Axis</h1>
            <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-[#4b5563]">
              Pick the plan that fits your crew, or redeem the company code from your email for a free trial.
            </p>
          </>
        )}
      </div>

      <div className="mt-6 flex justify-center">
        <div className="inline-flex rounded-lg border border-[#dededc] bg-white p-0.5 text-xs">
          {([false, true] as const).map(a => (
            <button key={String(a)} onClick={() => setAnnual(a)}
              className={`rounded-md px-3 py-1.5 font-medium ${annual === a ? 'bg-[#1a1a1a] text-white' : 'text-[#2d2d2d]'}`}>
              {a ? 'Yearly (2 months free)' : 'Monthly'}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-3">
        {plans.map(p => (
          <div key={p.key} className="flex flex-col rounded-xl border border-[#dededc] bg-white p-5">
            <div className="text-lg font-bold text-[#1a1a1a]">{p.name}</div>
            {p.tagline && <div className="mt-1 text-xs text-[#6b7280]">{p.tagline}</div>}
            <div className="mt-4 text-3xl font-bold text-[#1a1a1a]">
              ${annual ? p.annual_monthly_equivalent : p.monthly_usd}
              <span className="text-sm font-normal text-[#6b7280]">/mo</span>
            </div>
            {annual && <div className="text-xs text-[#6b7280]">${p.annual_usd} billed yearly</div>}
            <ul className="mt-4 space-y-1 text-sm text-[#2d2d2d]">
              <li>{p.reports_unlimited ? 'Unlimited reports' : `${p.reports} reports a month`}</li>
              <li>{p.crews_unlimited ? 'Unlimited crews' : `Up to ${p.crews} crews`}</li>
            </ul>
            <Link href={`/checkout?plan=${p.key}&interval=${annual ? 'year' : 'month'}`}
              className="mt-5 rounded-md bg-[#1a1a1a] px-4 py-2 text-center text-sm font-semibold text-white hover:bg-black">
              Choose {p.name}
            </Link>
          </div>
        ))}
      </div>

      {!promo?.had_promo && (
        <div className="mx-auto mt-8 max-w-md">
          <PromoCodeBox onRedeemed={onRedeemed} />
        </div>
      )}
      <p className="mt-8 text-center text-xs text-[#6b7280]">
        Questions? Reply to any email from me, or manage billing in <Link href="/settings" className="underline">Settings</Link>.
      </p>
    </div>
  )
}
