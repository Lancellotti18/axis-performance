'use client'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import toast from 'react-hot-toast'
import { getUser } from '@/lib/auth'
import { api } from '@/lib/api'
import type { ContractorProfile } from '@/types'

// The business profile drives the branded PDF report and customer proposal —
// company name + logo in the header, license/phone/email in the footer, and the
// address/region as defaults for permits. This is the one place the contractor
// corrects that information, so every field here is really persisted.
const EMPTY: ContractorProfile = {
  company_name: '', license_number: '', phone: '', email: '',
  address: '', city: '', state: '', zip_code: '', insurance_policy: '', logo_url: '',
}

export default function SettingsPage() {
  const router = useRouter()
  const [userId, setUserId] = useState<string | null>(null)
  const [profile, setProfile] = useState<ContractorProfile>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [uploadingLogo, setUploadingLogo] = useState(false)
  const logoInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    getUser().then(async u => {
      if (!u) { router.push('/login'); return }
      if (cancelled) return
      setUserId(u.id)
      try {
        const p = await api.contractorProfile.get(u.id)
        if (cancelled) return
        // Prefill email from the account if the profile hasn't set one yet.
        const loaded = (p && 'company_name' in p) ? p as ContractorProfile : EMPTY
        setProfile({ ...EMPTY, ...loaded, email: loaded.email || u.email || '' })
      } catch {
        setProfile({ ...EMPTY, email: u.email || '' })
      } finally {
        if (!cancelled) setLoading(false)
      }
    })
    return () => { cancelled = true }
  }, [router])

  const set = (k: keyof ContractorProfile) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setProfile(p => ({ ...p, [k]: e.target.value }))

  const save = async () => {
    if (!userId) return
    setSaving(true)
    try {
      const saved = await api.contractorProfile.save(userId, profile)
      setProfile(p => ({ ...p, ...saved }))
      toast.success('Saved — this is what your reports and proposals will use')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save')
    } finally {
      setSaving(false)
    }
  }

  const onLogoPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !userId) return
    setUploadingLogo(true)
    try {
      const { logo_url } = await api.contractorProfile.uploadLogo(userId, file)
      setProfile(p => ({ ...p, logo_url }))
      toast.success('Logo updated')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Logo upload failed')
    } finally {
      setUploadingLogo(false)
      if (logoInputRef.current) logoInputRef.current.value = ''
    }
  }

  const card = 'rounded-2xl border border-white/10 bg-white/[0.04] backdrop-blur-sm p-6'
  const blueBtn = { background: 'linear-gradient(180deg, #3B82F6 0%, #1E40AF 100%)', boxShadow: '0 8px 24px rgba(59,130,246,0.35), inset 0 1px 0 rgba(255,255,255,0.2)' }
  const inputCls = 'w-full bg-white/[0.06] border border-white/12 focus:border-blue-400/40 rounded-xl px-4 py-2.5 text-white text-sm placeholder-slate-500 focus:outline-none disabled:opacity-40 transition-colors'
  const labelCls = 'text-slate-500 text-xs font-semibold uppercase tracking-wider block mb-1.5'

  const Field = ({ k, label, placeholder, disabled }: { k: keyof ContractorProfile; label: string; placeholder?: string; disabled?: boolean }) => (
    <div>
      <label className={labelCls}>{label}</label>
      <input value={(profile[k] as string) || ''} onChange={set(k)} placeholder={placeholder} disabled={disabled} className={inputCls} />
    </div>
  )

  return (
    <div className="relative min-h-full" style={{ background: '#040810' }}>
      <div className="pointer-events-none absolute inset-0 opacity-[0.11]" style={{ backgroundImage: 'linear-gradient(rgba(96,165,250,1) 1.5px, transparent 1.5px), linear-gradient(90deg, rgba(96,165,250,1) 1.5px, transparent 1.5px)', backgroundSize: '34px 34px' }} />
      <div className="pointer-events-none absolute -top-32 -right-24 h-[420px] w-[420px] rounded-full opacity-[0.10] blur-3xl" style={{ background: 'radial-gradient(circle, #3b82f6, transparent 60%)' }} />

      <div className="relative p-8 max-w-2xl mx-auto">
        <div className="mb-7">
          <h1 className="text-2xl font-bold text-white">Settings</h1>
          <p className="text-slate-400 text-sm mt-1">Your business details — these brand every report and proposal you send.</p>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-24">
            <svg className="animate-spin text-blue-400" width="24" height="24" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>
          </div>
        ) : (
        <div className="space-y-5">
          {/* Business profile */}
          <div className={card}>
            <h2 className="text-white font-semibold text-sm mb-5">Business profile</h2>

            {/* Logo */}
            <div className="mb-5 flex items-center gap-4">
              <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-white/12 bg-white/[0.06]">
                {profile.logo_url
                  // eslint-disable-next-line @next/next/no-img-element
                  ? <img src={profile.logo_url} alt="Company logo" className="max-h-full max-w-full object-contain" />
                  : <span className="text-[10px] text-slate-500">No logo</span>}
              </div>
              <div>
                <input ref={logoInputRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={onLogoPick} className="hidden" />
                <button onClick={() => logoInputRef.current?.click()} disabled={uploadingLogo}
                  className="rounded-xl border border-white/12 bg-white/[0.06] px-4 py-2 text-sm font-medium text-slate-200 hover:border-white/20 disabled:opacity-50">
                  {uploadingLogo ? 'Uploading…' : profile.logo_url ? 'Replace logo' : 'Upload logo'}
                </button>
                <p className="mt-1.5 text-[11px] text-slate-500">PNG or JPG. Axis trims and centers it automatically.</p>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2"><Field k="company_name" label="Company name" placeholder="Smith Roofing LLC" /></div>
              <Field k="license_number" label="License #" placeholder="e.g. 12345-RC" />
              <Field k="insurance_policy" label="Insurance policy #" placeholder="Optional" />
              <Field k="phone" label="Phone" placeholder="(555) 123-4567" />
              <Field k="email" label="Email" placeholder="you@company.com" />
              <div className="sm:col-span-2"><Field k="address" label="Address" placeholder="123 Main St" /></div>
              <Field k="city" label="City" placeholder="Wilmington" />
              <div className="grid grid-cols-2 gap-4">
                <Field k="state" label="State" placeholder="NC" />
                <Field k="zip_code" label="ZIP" placeholder="28401" />
              </div>
            </div>

            <button onClick={save} disabled={saving}
              className="mt-6 text-white font-semibold px-5 py-2.5 rounded-xl text-sm transition-all hover:scale-[1.02] disabled:opacity-60 disabled:hover:scale-100" style={blueBtn}>
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>

          {/* Plan */}
          <div className={card}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-white font-semibold text-sm">Subscription</h2>
              <span className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-200 border border-blue-400/30">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                Pro Plan
              </span>
            </div>
            <div className="text-slate-400 text-sm mb-4">Your plan renews monthly. Includes unlimited roof reports and AI analysis.</div>
            <button className="border border-white/10 hover:border-white/20 text-slate-300 hover:text-white text-sm font-medium px-5 py-2.5 rounded-xl transition-colors bg-white/[0.04]">Manage Billing</button>
          </div>
        </div>
        )}
      </div>
    </div>
  )
}
