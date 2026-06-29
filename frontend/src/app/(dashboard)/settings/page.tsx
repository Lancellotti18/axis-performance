'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getUser } from '@/lib/auth'

export default function SettingsPage() {
  const router = useRouter()
  const [user, setUser] = useState<{ email?: string; user_metadata?: { full_name?: string; company_name?: string } } | null>(null)

  useEffect(() => {
    getUser().then(u => { if (!u) router.push('/login'); else setUser(u) })
  }, [router])

  const fields = [
    { label: 'Full Name', value: user?.user_metadata?.full_name || '', placeholder: 'John Smith' },
    { label: 'Email', value: user?.email || '', placeholder: 'you@company.com', disabled: true },
    { label: 'Company', value: user?.user_metadata?.company_name || '', placeholder: 'Smith Construction LLC' },
    { label: 'Region', value: '', placeholder: 'e.g. NC, CA, TX' },
  ]

  const card = 'rounded-2xl border border-white/10 bg-white/[0.04] backdrop-blur-sm p-6'
  const blueBtn = { background: 'linear-gradient(180deg, #3B82F6 0%, #1E40AF 100%)', boxShadow: '0 8px 24px rgba(59,130,246,0.35), inset 0 1px 0 rgba(255,255,255,0.2)' }

  return (
    <div className="relative min-h-full" style={{ background: '#040810' }}>
      <div className="pointer-events-none absolute inset-0 opacity-[0.11]" style={{ backgroundImage: 'linear-gradient(rgba(96,165,250,1) 1.5px, transparent 1.5px), linear-gradient(90deg, rgba(96,165,250,1) 1.5px, transparent 1.5px)', backgroundSize: '34px 34px' }} />
      <div className="pointer-events-none absolute -top-32 -right-24 h-[420px] w-[420px] rounded-full opacity-[0.10] blur-3xl" style={{ background: 'radial-gradient(circle, #3b82f6, transparent 60%)' }} />

      <div className="relative p-8 max-w-2xl mx-auto">
        <div className="mb-7">
          <h1 className="text-2xl font-bold text-white">Settings</h1>
          <p className="text-slate-400 text-sm mt-1">Manage your account and preferences.</p>
        </div>

        <div className="space-y-5">
          {/* Profile */}
          <div className={card}>
            <h2 className="text-white font-semibold text-sm mb-5">Profile</h2>
            <div className="space-y-4">
              {fields.map(f => (
                <div key={f.label}>
                  <label className="text-slate-500 text-xs font-semibold uppercase tracking-wider block mb-1.5">{f.label}</label>
                  <input
                    defaultValue={f.value}
                    placeholder={f.placeholder}
                    disabled={f.disabled}
                    className="w-full bg-white/[0.06] border border-white/12 focus:border-blue-400/40 rounded-xl px-4 py-2.5 text-white text-sm placeholder-slate-500 focus:outline-none disabled:opacity-40 transition-colors"
                  />
                </div>
              ))}
            </div>
            <button className="mt-5 text-white font-semibold px-5 py-2.5 rounded-xl text-sm transition-all hover:scale-[1.02]" style={blueBtn}>Save Changes</button>
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
            <div className="text-slate-400 text-sm mb-4">Your plan renews monthly. Includes unlimited blueprint uploads and AI analysis.</div>
            <button className="border border-white/10 hover:border-white/20 text-slate-300 hover:text-white text-sm font-medium px-5 py-2.5 rounded-xl transition-colors bg-white/[0.04]">Manage Billing</button>
          </div>

          {/* Danger zone */}
          <div className="rounded-2xl border border-rose-500/20 bg-rose-500/[0.06] p-6">
            <h2 className="text-rose-300 font-semibold text-sm mb-2">Danger Zone</h2>
            <p className="text-slate-400 text-sm mb-4">Permanently delete your account and all associated data.</p>
            <button className="border border-rose-500/30 text-rose-300 hover:bg-rose-500/10 text-sm font-medium px-5 py-2.5 rounded-xl transition-colors">Delete Account</button>
          </div>
        </div>
      </div>
    </div>
  )
}
