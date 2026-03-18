'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'

export default function ResetPasswordPage() {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)

  // Supabase sends the user back with a session in the URL hash.
  // We listen for the PASSWORD_RECOVERY event to know we're in reset mode.
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') setReady(true)
    })
    // Also check if there's already an active session from the magic link
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) setReady(true)
    })
    return () => subscription.unsubscribe()
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (password !== confirm) { setError('Passwords do not match.'); return }
    if (password.length < 6) { setError('Password must be at least 6 characters.'); return }
    setLoading(true)
    const { error } = await supabase.auth.updateUser({ password })
    if (error) {
      setError(error.message)
      setLoading(false)
    } else {
      await supabase.auth.signOut()
      router.push('/login?reset=1')
    }
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4 bg-cover bg-center bg-no-repeat"
      style={{ backgroundImage: "url('/blueprint-hero.png')" }}
    >
      <div className="absolute inset-0 bg-[#1a3a6b]/70 backdrop-blur-sm" />
      <div className="relative z-10 w-full max-w-sm">

        {/* Logo */}
        <div className="text-center mb-8">
          <Link href="/" className="inline-flex items-center gap-2.5 mb-4">
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
              <rect x="2" y="2" width="24" height="24" rx="4" stroke="rgba(255,255,255,0.8)" strokeWidth="1.5"/>
              <line x1="7" y1="8" x2="21" y2="8" stroke="rgba(255,255,255,0.8)" strokeWidth="1.5" strokeLinecap="round"/>
              <line x1="7" y1="12" x2="17" y2="12" stroke="rgba(255,255,255,0.5)" strokeWidth="1.5" strokeLinecap="round"/>
              <line x1="7" y1="16" x2="19" y2="16" stroke="rgba(255,255,255,0.5)" strokeWidth="1.5" strokeLinecap="round"/>
              <line x1="7" y1="20" x2="14" y2="20" stroke="rgba(255,255,255,0.3)" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
            <span className="text-lg font-bold text-white tracking-tight">Axis Performance</span>
          </Link>
          <h1 className="text-2xl font-black text-white">Set new password</h1>
          <p className="text-white/50 text-sm mt-1">Choose a strong password for your account</p>
        </div>

        <div className="bg-white/10 backdrop-blur-md border border-white/20 rounded-2xl p-8 shadow-2xl">
          {!ready ? (
            <div className="text-center py-4">
              <svg className="animate-spin text-white/40 mx-auto mb-3" width="24" height="24" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/>
              </svg>
              <p className="text-white/50 text-sm">Verifying reset link…</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-white/80 mb-1.5">New Password</label>
                <input
                  type="password" required minLength={6} value={password} onChange={e => setPassword(e.target.value)}
                  className="w-full bg-white/10 border border-white/20 rounded-xl px-4 py-2.5 text-white placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-white/40 focus:border-white/40 transition-all"
                  placeholder="Min. 6 characters"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-white/80 mb-1.5">Confirm New Password</label>
                <input
                  type="password" required minLength={6} value={confirm} onChange={e => setConfirm(e.target.value)}
                  className="w-full bg-white/10 border border-white/20 rounded-xl px-4 py-2.5 text-white placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-white/40 focus:border-white/40 transition-all"
                  placeholder="Repeat password"
                />
              </div>

              {/* Password strength hint */}
              {password.length > 0 && (
                <div className="flex gap-1">
                  {[1,2,3,4].map(i => (
                    <div key={i} className={`h-1 flex-1 rounded-full transition-all ${
                      password.length >= i * 3
                        ? password.length >= 12 ? 'bg-green-400' : password.length >= 8 ? 'bg-yellow-400' : 'bg-red-400'
                        : 'bg-white/10'
                    }`} />
                  ))}
                </div>
              )}

              {error && (
                <div className="bg-red-500/20 border border-red-400/30 rounded-xl px-4 py-3 text-red-200 text-sm">
                  {error}
                </div>
              )}
              <button
                type="submit" disabled={loading}
                className="w-full bg-white text-blue-700 font-bold py-3 rounded-xl hover:bg-blue-50 disabled:opacity-50 transition-all duration-200 shadow-lg mt-2"
              >
                {loading ? 'Updating…' : 'Update Password'}
              </button>
            </form>
          )}

          <p className="text-center text-white/40 text-sm mt-6">
            <Link href="/login" className="text-white/60 hover:text-white transition-colors">
              ← Back to Sign In
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}
