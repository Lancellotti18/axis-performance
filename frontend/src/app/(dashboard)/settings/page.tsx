'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getUser } from '@/lib/auth'

export default function SettingsPage() {
  const router = useRouter()
  const [user, setUser] = useState<any>(null)

  useEffect(() => {
    getUser().then(u => { if (!u) router.push('/login'); else setUser(u) })
  }, [router])

  const fields = [
    { label: 'Full Name', value: user?.user_metadata?.full_name || '', placeholder: 'John Smith' },
    { label: 'Email', value: user?.email || '', placeholder: 'you@company.com', disabled: true },
    { label: 'Company', value: user?.user_metadata?.company_name || '', placeholder: 'Smith Construction LLC' },
    { label: 'Region', value: '', placeholder: 'e.g. NC, CA, TX' },
  ]

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-black text-white">Settings</h1>
        <p className="text-[#4a6a8a] text-sm mt-1">Manage your account and preferences.</p>
      </div>

      <div className="space-y-5">
        {/* Profile */}
        <div className="bg-[#0f1e30] border border-[#1a2a3a] rounded-xl p-6">
          <h2 className="text-white font-bold text-sm mb-5">Profile</h2>
          <div className="space-y-4">
            {fields.map(f => (
              <div key={f.label}>
                <label className="text-[#4a6a8a] text-xs font-semibold uppercase tracking-wider block mb-1.5">{f.label}</label>
                <input
                  defaultValue={f.value}
                  placeholder={f.placeholder}
                  disabled={f.disabled}
                  className="w-full bg-[#0a1628] border border-[#1a2a3a] focus:border-blue-500/50 rounded-xl px-4 py-2.5 text-white text-sm placeholder-[#3a5a7a] focus:outline-none disabled:opacity-40 transition-all"
                />
              </div>
            ))}
          </div>
          <button className="mt-5 bg-blue-600 hover:bg-blue-500 text-white font-semibold px-5 py-2.5 rounded-xl text-sm transition-all">
            Save Changes
          </button>
        </div>

        {/* Plan */}
        <div className="bg-[#0f1e30] border border-[#1a2a3a] rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-white font-bold text-sm">Subscription</h2>
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full bg-blue-600/15 text-blue-400 border border-blue-500/20">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
              Pro Plan
            </span>
          </div>
          <div className="text-[#4a6a8a] text-sm mb-4">Your plan renews monthly. Includes unlimited blueprint uploads and AI analysis.</div>
          <button className="border border-[#1a2a3a] hover:border-[#2a3a4a] text-[#4a6a8a] hover:text-white text-sm font-medium px-5 py-2.5 rounded-xl transition-all">
            Manage Billing
          </button>
        </div>

        {/* Danger zone */}
        <div className="bg-red-500/5 border border-red-500/15 rounded-xl p-6">
          <h2 className="text-red-400 font-bold text-sm mb-2">Danger Zone</h2>
          <p className="text-[#4a6a8a] text-sm mb-4">Permanently delete your account and all associated data.</p>
          <button className="border border-red-500/30 text-red-400 hover:bg-red-500/10 text-sm font-medium px-5 py-2.5 rounded-xl transition-all">
            Delete Account
          </button>
        </div>
      </div>
    </div>
  )
}
