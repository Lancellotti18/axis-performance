'use client'

/**
 * New job from an address — the board's own way in.
 *
 * Jobs used to be able to originate in exactly one place: Project → "Add to
 * dispatch board". That is right for a measured re-roof, but it is far too much
 * ceremony for "there's a leak at 14 Oak St, send someone" — and it meant a
 * dispatcher could not start work from the screen they were already on.
 *
 * The job lands in the tray unassigned, exactly like a staged project, and can
 * be linked to a real project later from the job detail panel.
 */
import { useState } from 'react'
import toast from 'react-hot-toast'
import { createQuickJob } from './lib/board'

const JOB_TYPES = ['REROOF', 'ROOF_REPAIR', 'INSPECTION'] as const

export default function QuickJobDialog({ onClose, onCreated }: {
  onClose: () => void
  onCreated: () => void
}) {
  const [address, setAddress] = useState('')
  const [customer, setCustomer] = useState('')
  const [phone, setPhone] = useState('')
  const [jobType, setJobType] = useState<string>('REROOF')
  const [squares, setSquares] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit() {
    if (!address.trim()) { toast.error('An address is needed to send a crew somewhere.'); return }
    setBusy(true)
    try {
      const res = await createQuickJob({
        address: address.trim(),
        customer_name: customer.trim() || undefined,
        phone: phone.trim() || undefined,
        job_type: jobType,
        squares: squares ? parseFloat(squares) : undefined,
      })
      // Say plainly when the address didn't resolve — that job silently loses
      // site weather, and finding out later is worse than hearing it now.
      if (res.geocoded) toast.success(res.message)
      else toast(res.message, { icon: '⚠️', duration: 6000 })
      onCreated()
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message.replace(/\[HTTP \d+\]\s*/, '').slice(0, 160) : 'Could not create the job')
    } finally {
      setBusy(false)
    }
  }

  const field = 'w-full rounded-lg border px-3 py-2.5 text-sm'
  const fieldStyle = { borderColor: 'var(--line)', background: 'var(--panel2)', color: 'var(--text)' }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-6"
      onClick={onClose}>
      {/* Sheet on a phone, dialog on a desktop — a centred box is awkward to
          reach one-handed on mobile. */}
      <div className="w-full max-w-md rounded-t-2xl border p-5 shadow-2xl sm:rounded-2xl"
        style={{ background: 'var(--panel)', borderColor: 'var(--line)' }}
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[15px] font-bold">New job</div>
            <div className="text-[12px]" style={{ color: 'var(--muted)' }}>
              Send a crew to an address — no project needed.
            </div>
          </div>
          <button onClick={onClose} aria-label="Close"
            className="rounded-md px-2 py-1 text-sm" style={{ color: 'var(--muted)' }}>✕</button>
        </div>

        <div className="mt-4 space-y-3">
          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>Address</span>
            <input value={address} onChange={e => setAddress(e.target.value)} autoFocus
              placeholder="14 Oak St, Wilmington NC"
              className={`${field} mt-1`} style={fieldStyle} />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>Customer</span>
              <input value={customer} onChange={e => setCustomer(e.target.value)} placeholder="Optional"
                className={`${field} mt-1`} style={fieldStyle} />
            </label>
            <label className="block">
              <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>Phone</span>
              <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="Optional" inputMode="tel"
                className={`${field} mt-1`} style={fieldStyle} />
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>Type</span>
              <select value={jobType} onChange={e => setJobType(e.target.value)}
                className={`${field} mt-1`} style={fieldStyle}>
                {JOB_TYPES.map(t => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>Squares</span>
              <input value={squares} onChange={e => setSquares(e.target.value)} inputMode="decimal"
                placeholder="Optional" className={`${field} mt-1`} style={fieldStyle} />
            </label>
          </div>
          <p className="text-[11px]" style={{ color: 'var(--muted)' }}>
            Squares drive crew-days and capacity. Leave it blank and link a project later to inherit the measured roof.
          </p>
        </div>

        <div className="mt-5 flex gap-2">
          <button onClick={onClose}
            className="rounded-lg border px-4 py-2.5 text-sm font-semibold"
            style={{ borderColor: 'var(--line)', color: 'var(--muted)' }}>Cancel</button>
          <button onClick={() => void submit()} disabled={busy || !address.trim()}
            className="flex-1 rounded-lg py-2.5 text-sm font-bold disabled:opacity-50"
            style={{ background: 'var(--dawn)', color: '#ffffff' }}>
            {busy ? 'Creating…' : 'Add to tray'}
          </button>
        </div>
      </div>
    </div>
  )
}
