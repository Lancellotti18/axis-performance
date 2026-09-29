'use client'

/**
 * "You've used all your reports — buy another for $35?"
 *
 * The one screen between an exhausted allowance and a charge. Everything about
 * it is built around a single rule: NOTHING is charged until the contractor
 * reads the price and clicks the button that names it. An earlier design billed
 * silently the moment someone crossed the line, which is how a contractor finds
 * a $35 charge he never agreed to and stops trusting the product.
 *
 * So the amount appears three times — in the body, on the button, and in the
 * confirmation — and the button says "Charge $35" rather than "Continue".
 */
import { useState } from 'react'
import toast from 'react-hot-toast'

import { api, type EntitlementBlock, type UsageSummary } from '@/lib/api'

export default function OveragePrompt({
  block, usage, onPurchased, onDismiss,
}: {
  block: EntitlementBlock
  usage?: UsageSummary | null
  onPurchased: () => void | Promise<void>
  onDismiss: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const price = block.purchase_price_usd

  // Not a money question — no plan at all, or leads without a subscription.
  // Sending these to a card form would be asking for payment for something
  // buying a report cannot fix.
  if (!block.requires_purchase || price == null) {
    return (
      <Shell onDismiss={onDismiss} title="You've reached a plan limit">
        <p className="text-sm leading-relaxed text-[#47536a]">{block.reason}</p>
        <div className="mt-5 flex flex-wrap gap-2">
          <a href="/pricing"
             className="rounded-xl bg-[#0068d6] px-5 py-2.5 text-sm font-bold text-white hover:bg-[#01498f]">
            See plans
          </a>
          <button onClick={onDismiss}
                  className="rounded-xl px-4 py-2.5 text-sm font-medium text-[#6b7280] hover:text-[#1a1a1a]">
            Not now
          </button>
        </div>
      </Shell>
    )
  }

  const buy = async () => {
    setBusy(true)
    setFailed(null)
    try {
      const r = await api.billing.purchaseReport(1)
      if (r.requires_action) {
        // 3DS. There is no cardholder-present flow here yet, so say what to do
        // rather than spinning forever on a payment that cannot complete.
        setFailed('Your bank needs to confirm this payment. Open Settings → '
                  + 'Billing and re-add your card, then try again.')
        return
      }
      toast.success(r.message || `Charged $${price}.`)
      await onPurchased()
    } catch (e) {
      setFailed(e instanceof Error ? e.message.replace(/^\[HTTP \d+\]\s*/, '')
                                   : 'That payment did not go through.')
    } finally {
      setBusy(false)
    }
  }

  const used = usage?.reports_used
  const entitled = usage?.reports_entitled

  return (
    <Shell onDismiss={onDismiss} title="You're out of reports this period">
      {used != null && entitled != null && (
        <p className="text-sm text-[#47536a]">
          You've used <strong className="tabular-nums">{used}</strong> of{' '}
          <strong className="tabular-nums">{entitled}</strong> reports
          {usage?.overage_purchased
            ? ` (${entitled - usage.overage_purchased} included + ${usage.overage_purchased} purchased)`
            : ''}
          {usage?.period_end
            ? `. Your allowance resets on ${new Date(usage.period_end).toLocaleDateString()}.`
            : '.'}
        </p>
      )}

      {/* The charge, stated plainly and before the button. */}
      <div className="mt-4 rounded-xl border border-[#e0a955] bg-[#fdf6e9] px-4 py-3">
        <p className="text-[13px] leading-relaxed text-[#7a4a00]">
          You can measure this roof now for <strong>${price}</strong>. This is an
          extra charge on top of your plan — we'll bill the card on file
          immediately, and it will show up as a separate line on your next
          statement.
        </p>
      </div>

      {failed && (
        <p className="mt-3 text-[13px] leading-relaxed text-[#b03535]">{failed}</p>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <button onClick={buy} disabled={busy}
          className="rounded-xl bg-[#0068d6] px-5 py-2.5 text-sm font-bold text-white hover:bg-[#01498f] disabled:opacity-50">
          {busy ? 'Charging…' : `Charge $${price} and continue`}
        </button>
        <button onClick={onDismiss} disabled={busy}
          className="rounded-xl px-4 py-2.5 text-sm font-medium text-[#6b7280] hover:text-[#1a1a1a] disabled:opacity-50">
          No thanks
        </button>
        <a href="/pricing"
           className="ml-auto text-xs font-semibold text-[#0060c4] underline">
          Or upgrade your plan
        </a>
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-[#8a94a6]">
        Your trace is saved either way — nothing you've drawn is lost if you decline.
      </p>
    </Shell>
  )
}

function Shell({ title, children, onDismiss }: {
  title: string; children: React.ReactNode; onDismiss: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center"
         role="dialog" aria-modal="true" aria-label={title}
         onClick={e => { if (e.target === e.currentTarget) onDismiss() }}>
      <div className="w-full max-w-lg rounded-2xl border border-[#dededc] bg-white p-6 shadow-xl">
        <h2 className="text-base font-bold text-[#1a1a1a]">{title}</h2>
        <div className="mt-2">{children}</div>
      </div>
    </div>
  )
}
