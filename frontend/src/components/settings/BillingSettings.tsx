'use client'

/**
 * Plan and payment management.
 *
 * Replaces a card that hardcoded "Pro Plan — unlimited roof reports" and a
 * button that did nothing. Every figure here now comes from the same plan table
 * the entitlement check reads, so what Settings says and what Axis enforces
 * cannot drift apart the way the pricing page did.
 */
import { useCallback, useEffect, useState } from 'react'
import { loadStripe, type Stripe } from '@stripe/stripe-js'
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js'
import toast from 'react-hot-toast'

import { api } from '@/lib/api'

type Card = {
  id: string; brand: string | null; last4: string | null
  exp_month: number | null; exp_year: number | null; is_default: boolean
}
type Plan = {
  key: string; name: string; monthly_usd: number; annual_usd: number
  reports: number | null; reports_unlimited: boolean
  crews: number | null; crews_unlimited: boolean
}
type Sub = Record<string, unknown> | null

const API_BASE = (process.env.NEXT_PUBLIC_API_URL || 'https://build-backend-jcp9.onrender.com').trim()

export default function BillingSettings() {
  const [sub, setSub] = useState<Sub>(null)
  const [plans, setPlans] = useState<Plan[]>([])
  const [cards, setCards] = useState<Card[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [addingCard, setAddingCard] = useState(false)
  const [stripePromise, setStripePromise] = useState<Promise<Stripe | null> | null>(null)
  const [setupSecret, setSetupSecret] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [me, plansRes, pms] = await Promise.all([
        api.billing.me(),
        fetch(`${API_BASE}/api/v1/billing/plans`).then(r => r.json()),
        api.billing.paymentMethods().catch(() => ({ payment_methods: [] })),
      ])
      setSub(me.subscription)
      setPlans(plansRes.plans || [])
      setCards(pms.payment_methods || [])
    } catch {
      /* leave the section empty rather than blocking the rest of Settings */
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const planKey = (sub?.plan_key as string | undefined) ?? null
  const status = (sub?.status as string | undefined) ?? 'none'
  const current = plans.find(p => p.key === planKey) ?? null
  const scheduled = (sub?.scheduled_plan_key as string | undefined) ?? null
  const cancelling = Boolean(sub?.cancel_at_period_end)
  const periodEnd = sub?.current_period_end as string | undefined
  const active = ['active', 'trialing', 'past_due'].includes(status)

  const startAddCard = useCallback(async () => {
    setBusy(true)
    try {
      const [cfg, intent] = await Promise.all([api.billing.config(), api.billing.setupIntent()])
      if (!cfg.publishable_key) throw new Error('Payments are not set up yet.')
      setStripePromise(loadStripe(cfg.publishable_key))
      setSetupSecret(intent.client_secret)
      setAddingCard(true)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not start card setup.')
    } finally { setBusy(false) }
  }, [])

  const act = useCallback(async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true)
    try { await fn(); toast.success(ok); await refresh() }
    catch (e) { toast.error(e instanceof Error ? e.message : 'That didn’t work.') }
    finally { setBusy(false) }
  }, [refresh])

  if (loading) return <Card><div className="h-24 animate-pulse rounded-lg bg-[#eceef1]" /></Card>

  return (
    <>
      <Card>
        <H>Your plan</H>

        {!active ? (
          <>
            <p className="mt-1 text-sm text-[#6b7280]">
              You don’t have a plan yet. Choose one to unlock reports, dispatch crews and leads.
            </p>
            <a href="/pricing"
               className="mt-4 inline-block rounded-xl bg-[#0068d6] px-5 py-2.5 text-sm font-bold text-white hover:bg-[#01498f]">
              See plans
            </a>
          </>
        ) : (
          <>
            <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-2xl font-black text-[#1a1a1a]">{current?.name ?? planKey}</span>
              {current && (
                <span className="text-sm text-[#6b7280]">
                  ${((sub?.billing_interval as string) === 'year'
                      ? current.annual_usd : current.monthly_usd).toLocaleString()}
                  {(sub?.billing_interval as string) === 'year' ? '/year' : '/month'}
                </span>
              )}
              <StatusChip status={status} />
            </div>

            {current && (
              <div className="mt-4 flex flex-wrap gap-6 rounded-xl bg-[#f4f6f9] p-4">
                <Stat value={current.reports_unlimited ? '∞' : String(current.reports)}
                      label="reports a month" />
                <Stat value={current.crews_unlimited ? '∞' : String(current.crews)}
                      label="dispatch crews" />
              </div>
            )}

            {status === 'past_due' && (
              <Notice tone="warn">
                Your last payment didn’t go through. Update your card below and we’ll retry —
                your account stays active in the meantime.
              </Notice>
            )}
            {scheduled && (
              <Notice tone="info">
                Switching to <strong>{plans.find(p => p.key === scheduled)?.name ?? scheduled}</strong>
                {periodEnd ? ` on ${new Date(periodEnd).toLocaleDateString()}` : ''}. Nothing changes until then.
              </Notice>
            )}
            {cancelling && (
              <Notice tone="warn">
                Your plan ends{periodEnd ? ` on ${new Date(periodEnd).toLocaleDateString()}` : ''}.
                You keep full access until then.
                <button onClick={() => act(() => api.billing.resume(), 'Plan resumed.')}
                        disabled={busy}
                        className="ml-2 font-semibold text-[#0060c4] underline disabled:opacity-50">
                  Keep my plan
                </button>
              </Notice>
            )}

            <div className="mt-5 flex flex-wrap gap-2">
              {plans.filter(p => p.key !== planKey).map(p => (
                <button key={p.key} disabled={busy}
                  onClick={() => act(async () => {
                    const r = await api.billing.changePlan(p.key)
                    if (r.warning) toast(r.warning, { duration: 9000, icon: '⚠️' })
                  }, `Switched to ${p.name}.`)}
                  className="rounded-xl border border-[#dededc] bg-white px-4 py-2 text-sm font-medium text-[#1a1a1a] hover:border-[#0068d6] disabled:opacity-50">
                  Switch to {p.name}
                </button>
              ))}
              {!cancelling && (
                <button disabled={busy}
                  onClick={() => {
                    if (!confirm('Cancel your plan? You keep access until the end of the period you’ve paid for.')) return
                    act(() => api.billing.cancel(), 'Plan will end at the period close.')
                  }}
                  className="rounded-xl px-4 py-2 text-sm font-medium text-[#b03535] hover:bg-red-50 disabled:opacity-50">
                  Cancel plan
                </button>
              )}
            </div>
          </>
        )}
      </Card>

      <Card>
        <H>Payment methods</H>
        <p className="mt-1 text-sm text-[#6b7280]">
          Cards are held by Stripe — Axis never sees the number.
        </p>

        <div className="mt-4 space-y-2">
          {cards.length === 0 && !addingCard && (
            <p className="text-sm text-[#6b7280]">No card on file.</p>
          )}
          {cards.map(c => (
            <div key={c.id}
                 className="flex flex-wrap items-center gap-3 rounded-xl border border-[#e3e8ef] bg-white px-4 py-3">
              <span className="text-sm font-semibold capitalize text-[#1a1a1a]">
                {c.brand ?? 'Card'} ····{c.last4 ?? '????'}
              </span>
              <span className="text-xs text-[#6b7280]">
                {c.exp_month && c.exp_year
                  ? `expires ${String(c.exp_month).padStart(2, '0')}/${String(c.exp_year).slice(-2)}`
                  : ''}
              </span>
              {c.is_default
                ? <span className="rounded-full bg-[#dcf0e8] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[#0b6b53]">Default</span>
                : (
                  <button disabled={busy}
                    onClick={() => act(() => api.billing.setDefaultCard(c.id), 'Default card updated.')}
                    className="text-xs font-semibold text-[#0060c4] underline disabled:opacity-50">
                    Make default
                  </button>
                )}
              <button disabled={busy}
                onClick={() => act(() => api.billing.removeCard(c.id), 'Card removed.')}
                className="ml-auto text-xs text-[#b03535] hover:underline disabled:opacity-50">
                Remove
              </button>
            </div>
          ))}
        </div>

        {addingCard && stripePromise && setupSecret ? (
          <div className="mt-4 rounded-xl border border-[#e3e8ef] p-4">
            <Elements stripe={stripePromise} options={{ clientSecret: setupSecret,
              appearance: { theme: 'stripe', variables: { colorPrimary: '#0068d6', borderRadius: '10px' } } }}>
              <AddCardForm onDone={async () => { setAddingCard(false); setSetupSecret(null); await refresh() }}
                           onCancel={() => { setAddingCard(false); setSetupSecret(null) }} />
            </Elements>
          </div>
        ) : (
          <button onClick={startAddCard} disabled={busy}
            className="mt-4 rounded-xl border border-[#dededc] bg-[#f8f8f7] px-4 py-2 text-sm font-medium text-[#1a1a1a] hover:border-[#0068d6] disabled:opacity-50">
            {busy ? 'Opening…' : 'Add a card'}
          </button>
        )}
      </Card>
    </>
  )
}

function AddCardForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const stripe = useStripe()
  const elements = useElements()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <form onSubmit={async e => {
      e.preventDefault()
      if (!stripe || !elements) return
      setSaving(true); setError(null)
      const { error } = await stripe.confirmSetup({ elements, redirect: 'if_required' })
      if (error) {
        setError(error.message ?? 'That card couldn’t be saved. Try again, or use a different one.')
        setSaving(false)
        return
      }
      toast.success('Card saved.')
      // Stripe's webhook writes the row; give it a beat before refetching.
      setTimeout(onDone, 1200)
    }}>
      <PaymentElement options={{ layout: 'tabs' }} />
      {error && <p className="mt-3 text-[13px] text-[#b03535]">{error}</p>}
      <div className="mt-4 flex gap-2">
        <button type="submit" disabled={!stripe || saving}
          className="rounded-xl bg-[#0068d6] px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50">
          {saving ? 'Saving…' : 'Save card'}
        </button>
        <button type="button" onClick={onCancel} disabled={saving}
          className="rounded-xl px-4 py-2.5 text-sm font-medium text-[#6b7280] hover:text-[#1a1a1a]">
          Cancel
        </button>
      </div>
    </form>
  )
}

function StatusChip({ status }: { status: string }) {
  const map: Record<string, [string, string, string]> = {
    active:   ['Active', '#dcf0e8', '#0b6b53'],
    trialing: ['Trial', '#e2ecfa', '#0060c4'],
    past_due: ['Payment failed', '#fbeed6', '#9a5b00'],
    canceled: ['Cancelled', '#fadedd', '#a62f2f'],
  }
  const [label, bg, fg] = map[status] ?? [status, '#eceef1', '#47536a']
  return (
    <span className="rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide"
          style={{ background: bg, color: fg }}>{label}</span>
  )
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <div className="text-xl font-black tabular-nums text-[#1a1a1a]">{value}</div>
      <div className="text-[11px] text-[#6b7280]">{label}</div>
    </div>
  )
}

function Notice({ tone, children }: { tone: 'info' | 'warn'; children: React.ReactNode }) {
  const c = tone === 'warn'
    ? { bg: '#fbeed6', border: '#e0a955', fg: '#7a4a00' }
    : { bg: '#e2ecfa', border: '#7fb0ee', fg: '#0d3a6b' }
  return (
    <div className="mt-4 rounded-xl px-4 py-3 text-[13px] leading-relaxed"
         style={{ background: c.bg, border: `1px solid ${c.border}`, color: c.fg }}>
      {children}
    </div>
  )
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="rounded-2xl border border-[#dededc] bg-white p-6">{children}</div>
}

function H({ children }: { children: React.ReactNode }) {
  return <h2 className="text-sm font-semibold text-[#1a1a1a]">{children}</h2>
}
