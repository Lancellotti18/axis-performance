'use client'

/**
 * Checkout, without leaving Axis.
 *
 * Stripe's Payment Element renders the card fields as iframes hosted on
 * Stripe's domain, so a card number goes straight from the browser to Stripe
 * and never touches our server — the branded experience of an embedded form
 * with the same PCI scope (SAQ A) as a full redirect.
 *
 * The publishable key is fetched at runtime rather than compiled in: Vercel
 * would not take a NEXT_PUBLIC_ name for it, and serving it means rotating the
 * key is an environment change instead of a frontend rebuild.
 */
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { loadStripe, type Stripe } from '@stripe/stripe-js'
import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from '@stripe/react-stripe-js'
import toast from 'react-hot-toast'

import { api } from '@/lib/api'

type PlanSummary = {
  name: string
  monthly_usd: number
  annual_usd: number
  reports: number | null
  reports_unlimited: boolean
  crews: number | null
  crews_unlimited: boolean
}

export default function CheckoutPage() {
  return (
    <Suspense fallback={<Centered>Loading…</Centered>}>
      <Checkout />
    </Suspense>
  )
}

function Checkout() {
  const params = useSearchParams()
  const planKey = params.get('plan') || 'solo'
  const interval = (params.get('interval') === 'year' ? 'year' : 'month') as 'month' | 'year'

  const [stripePromise, setStripePromise] = useState<Promise<Stripe | null> | null>(null)
  const [clientSecret, setClientSecret] = useState<string | null>(null)
  const [plan, setPlan] = useState<PlanSummary | null>(null)
  const [testMode, setTestMode] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [cfg, plansRes] = await Promise.all([
          api.billing.config(),
          fetch(`${process.env.NEXT_PUBLIC_API_URL || 'https://build-backend-jcp9.onrender.com'}/api/v1/billing/plans`)
            .then(r => r.json()),
        ])
        if (cancelled) return
        if (!cfg.publishable_key) {
          setError('Payments are not set up yet. Please try again shortly.')
          return
        }
        setStripePromise(loadStripe(cfg.publishable_key))
        setTestMode(cfg.test_mode)
        setPlan((plansRes.plans || []).find((p: { key: string }) => p.key === planKey) ?? null)

        const sub = await api.billing.subscribe(planKey, interval)
        if (cancelled) return
        if (!sub.requires_payment) {
          toast.success('You’re all set.')
          window.location.href = '/dashboard?subscribed=1'
          return
        }
        setClientSecret(sub.client_secret ?? null)
      } catch (e) {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : 'Could not start checkout.'
          // 409: they already have a plan. Not an error worth a red box.
          setError(msg.includes('already have an active plan')
            ? 'You already have a plan. Manage it in Settings → Payments.'
            : msg)
        }
      }
    })()
    return () => { cancelled = true }
  }, [planKey, interval])

  const price = useMemo(() => {
    if (!plan) return null
    return interval === 'year' ? plan.annual_usd : plan.monthly_usd
  }, [plan, interval])

  if (error) {
    return (
      <Centered>
        <p className="text-[15px] text-[#1a1a1a]">{error}</p>
        <a href="/pricing" className="mt-4 inline-block text-sm font-semibold text-[#0068d6] underline">
          Back to plans
        </a>
      </Centered>
    )
  }

  if (!stripePromise || !clientSecret) return <Centered>Setting up your checkout…</Centered>

  return (
    <div className="mx-auto max-w-lg px-6 py-10">
      {testMode && (
        // A checkout that looks identical in test and live is how a sandbox run
        // quietly becomes a real charge. Say which one this is.
        <div className="mb-5 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-[13px] text-amber-900">
          <strong>Test mode</strong> — no real card will be charged. Use
          <code className="mx-1 rounded bg-amber-100 px-1.5 py-0.5">4242 4242 4242 4242</code>
          with any future expiry and any CVC.
        </div>
      )}

      <h1 className="text-2xl font-bold text-[#1a1a1a]">
        {plan ? `Start ${plan.name}` : 'Checkout'}
      </h1>
      {plan && price != null && (
        <p className="mt-1.5 text-sm text-[#6b7280]">
          <strong className="text-[#1a1a1a]">${price.toLocaleString()}</strong>
          {interval === 'year' ? ' per year' : ' per month'} ·{' '}
          {plan.reports_unlimited ? 'Unlimited' : plan.reports} reports ·{' '}
          {plan.crews_unlimited ? 'Unlimited' : plan.crews} crews
        </p>
      )}

      <div className="mt-6 rounded-2xl border border-[#dededc] bg-white p-6">
        <Elements
          stripe={stripePromise}
          options={{
            clientSecret,
            appearance: {
              theme: 'stripe',
              variables: {
                colorPrimary: '#0068d6',
                colorText: '#1a1a1a',
                fontFamily: 'Inter, system-ui, sans-serif',
                borderRadius: '10px',
              },
            },
          }}
        >
          <PayForm planName={plan?.name ?? 'your plan'} />
        </Elements>
      </div>

      <p className="mt-4 text-center text-[12px] leading-relaxed text-[#6b7280]">
        Your card details go directly to Stripe — Axis never sees them.
        Cancel anytime; you keep access until the end of the period you&apos;ve paid for.
      </p>
    </div>
  )
}

function PayForm({ planName }: { planName: string }) {
  const stripe = useStripe()
  const elements = useElements()
  const router = useRouter()
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const onSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    if (!stripe || !elements || submitting) return
    setSubmitting(true)
    setMessage(null)

    // redirect: 'if_required' keeps the contractor in Axis for every card that
    // does not demand a 3-D Secure step, which is almost all of them.
    const { error, paymentIntent } = await stripe.confirmPayment({
      elements,
      redirect: 'if_required',
      confirmParams: { return_url: `${window.location.origin}/dashboard?subscribed=1` },
    })

    if (error) {
      // Stripe's own decline text is clearer than anything generic we would
      // write, and it distinguishes "wrong number" from "bank said no".
      setMessage(error.message ?? 'That payment didn’t go through. Try again, or use a different card.')
      setSubmitting(false)
      return
    }

    if (paymentIntent && paymentIntent.status === 'succeeded') {
      toast.success(`You’re on ${planName}.`)
      router.push('/dashboard?subscribed=1')
      return
    }

    // processing / requires_action that resolved without a redirect
    toast.success('Payment received — setting up your plan.')
    router.push('/dashboard?subscribed=1')
  }, [stripe, elements, submitting, planName, router])

  return (
    <form onSubmit={onSubmit}>
      <PaymentElement options={{ layout: 'tabs' }} />
      {message && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-[13px] text-red-700">
          {message}
        </div>
      )}
      <button
        type="submit"
        disabled={!stripe || submitting}
        className="mt-5 w-full rounded-xl px-4 py-3.5 text-[14px] font-bold text-white transition disabled:cursor-not-allowed"
        style={{ background: !stripe || submitting ? '#c7ccd3' : '#0068d6' }}
      >
        {submitting ? 'Processing…' : 'Start subscription'}
      </button>
    </form>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
      {children}
    </div>
  )
}
