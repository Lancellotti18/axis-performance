'use client'

/**
 * "Have a company code?" — redeems a promo code on the signed-in account.
 * A code gives 3 free reports and 7 days of full access, and makes the
 * account a founding member (today's pricing kept when prices rise).
 */
import { useState } from 'react'
import toast from 'react-hot-toast'
import { api } from '@/lib/api'

export const PENDING_CODE_KEY = 'axis_pending_code'

export default function PromoCodeBox({ onRedeemed, compact = false }: {
  onRedeemed?: () => void
  compact?: boolean
}) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function redeem() {
    const c = code.trim()
    if (c.length < 3) { setError('Enter the code from your email.'); return }
    setBusy(true); setError(null)
    try {
      const r = await api.billing.redeemCode(c)
      toast.success(`Code redeemed — ${r.free_reports} free reports and ${r.access_days} days of full access.`)
      try { localStorage.removeItem(PENDING_CODE_KEY) } catch { /* ignore */ }
      setCode('')
      onRedeemed?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That code could not be redeemed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={compact ? '' : 'rounded-xl border border-[#dededc] bg-white p-4'}>
      {!compact && (
        <div className="mb-2 text-sm font-semibold text-[#1a1a1a]">Have a company code?</div>
      )}
      <div className="flex gap-2">
        <input
          value={code}
          onChange={e => setCode(e.target.value.toUpperCase())}
          onKeyDown={e => { if (e.key === 'Enter') void redeem() }}
          placeholder="e.g. FORTITUDE"
          aria-label="Company code"
          maxLength={32}
          className="min-w-0 flex-1 rounded-md border border-[#dededc] bg-[#f8f8f7] px-3 py-2 text-sm uppercase tracking-wide text-[#1a1a1a] placeholder:normal-case placeholder:tracking-normal focus:border-blue-400 focus:outline-none"
        />
        <button
          onClick={() => void redeem()}
          disabled={busy}
          className="rounded-md bg-[#1a1a1a] px-4 py-2 text-sm font-semibold text-white hover:bg-black disabled:opacity-50"
        >{busy ? 'Checking…' : 'Redeem'}</button>
      </div>
      {error && <p className="mt-2 text-xs text-rose-700">{error}</p>}
    </div>
  )
}
