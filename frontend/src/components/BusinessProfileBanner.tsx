'use client'

/**
 * BusinessProfileBanner — onboarding nudge shown across the dashboard until
 * the contractor sets their company name. This profile is the single source
 * of truth that personalizes EVERYTHING: the RoofIQ quote page, homeowner
 * reports, proposals, the client portal, and PDF branding.
 */
import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'

import { api } from '@/lib/api'

export default function BusinessProfileBanner({ userId }: { userId: string }) {
  const [needed, setNeeded] = useState(false)
  const [open, setOpen] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({ company_name: '', phone: '', license_number: '', email: '' })

  useEffect(() => {
    if (!userId) return
    api.contractorProfile.get(userId)
      .then(p => { if (!p || !('company_name' in p) || !p.company_name) setNeeded(true) })
      .catch(() => setNeeded(true))
    try { if (sessionStorage.getItem('axis_profile_banner_dismissed')) setDismissed(true) } catch { /* ignore */ }
  }, [userId])

  const save = useCallback(async () => {
    if (form.company_name.trim().length < 2) { toast.error('Enter your company name.'); return }
    setSaving(true)
    try {
      await api.contractorProfile.save(userId, {
        company_name: form.company_name.trim(),
        phone: form.phone.trim(),
        license_number: form.license_number.trim(),
        email: form.email.trim(),
      })
      toast.success('Profile saved — your quote page, reports, proposals and portal are now branded.')
      setNeeded(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save — try again.')
    } finally {
      setSaving(false)
    }
  }, [userId, form])

  if (!needed || dismissed) return null

  return (
    <div className="border-b border-amber-400/25 bg-amber-500/10 px-4 py-2.5 text-sm">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2">
        <span className="text-amber-200">
          🏷 <strong>Set up your business profile</strong> — your company name, phone and logo
          brand your quote page, homeowner reports, proposals and client portal.
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => setOpen(o => !o)}
            className="rounded bg-amber-500 px-3 py-1 text-xs font-semibold text-amber-950 hover:bg-amber-400">
            {open ? 'Hide' : 'Set up now (1 min)'}
          </button>
          <button onClick={() => { setDismissed(true); try { sessionStorage.setItem('axis_profile_banner_dismissed', '1') } catch { /* ignore */ } }}
            className="rounded p-1 text-amber-200/60 hover:text-white" aria-label="Dismiss">✕</button>
        </div>
      </div>
      {open && (
        <div className="mx-auto mt-2 grid max-w-6xl gap-2 pb-1 sm:grid-cols-5">
          {([
            ['company_name', 'Company name *'],
            ['phone', 'Phone'],
            ['license_number', 'License #'],
            ['email', 'Email'],
          ] as [keyof typeof form, string][]).map(([k, label]) => (
            <input key={k} type="text" value={form[k]} placeholder={label}
              onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))}
              className="rounded border border-amber-400/30 bg-slate-900/60 px-2.5 py-1.5 text-xs text-white placeholder:text-slate-500" />
          ))}
          <button onClick={save} disabled={saving}
            className="rounded bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50">
            {saving ? 'Saving…' : 'Save'}
          </button>
          <p className="text-[10px] text-amber-200/50 sm:col-span-5">
            Add your logo any time from the report step&apos;s branding editor — Axis auto-cleans and sizes it.
          </p>
        </div>
      )}
    </div>
  )
}
