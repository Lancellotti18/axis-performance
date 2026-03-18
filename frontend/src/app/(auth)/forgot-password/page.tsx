'use client'
import { useState, Suspense } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'

function ForgotForm() {
  const params = useSearchParams()
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState(params.get('error') === 'invalid_link' ? 'That reset link has expired. Please request a new one.' : '')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/api/auth/callback`,
    })
    if (error) {
      setError(error.message)
      setLoading(false)
    } else {
      setSent(true)
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
          <h1 className="text-2xl font-black text-white">Reset your password</h1>
          <p className="text-white/50 text-sm mt-1">
            {sent ? "Check your inbox" : "We'll send you a reset link"}
          </p>
        </div>

        <div className="bg-white/10 backdrop-blur-md border border-white/20 rounded-2xl p-8 shadow-2xl">
          {sent ? (
            <div className="text-center space-y-4">
              <div className="w-14 h-14 bg-green-500/20 border border-green-400/30 rounded-full flex items-center justify-center mx-auto">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
                  <polyline points="22,6 12,13 2,6"/>
                </svg>
              </div>
              <div>
                <div className="text-white font-bold mb-1">Email sent!</div>
                <p className="text-white/60 text-sm leading-relaxed">
                  We sent a password reset link to <span className="text-white font-medium">{email}</span>. Check your inbox and click the link to set a new password.
                </p>
              </div>
              <p className="text-white/30 text-xs pt-2">Didn&apos;t get it? Check your spam folder or{' '}
                <button onClick={() => setSent(false)} className="text-white/60 hover:text-white underline underline-offset-2 transition-colors">try again</button>.
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-white/80 mb-1.5">Email address</label>
                <input
                  type="email" required value={email} onChange={e => setEmail(e.target.value)}
                  className="w-full bg-white/10 border border-white/20 rounded-xl px-4 py-2.5 text-white placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-white/40 focus:border-white/40 transition-all"
                  placeholder="you@company.com"
                  autoFocus
                />
              </div>
              {error && (
                <div className="bg-red-500/20 border border-red-400/30 rounded-xl px-4 py-3 text-red-200 text-sm">
                  {error}
                </div>
              )}
              <button
                type="submit" disabled={loading}
                className="w-full bg-white text-blue-700 font-bold py-3 rounded-xl hover:bg-blue-50 disabled:opacity-50 transition-all duration-200 shadow-lg"
              >
                {loading ? 'Sending…' : 'Send Reset Link'}
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

export default function ForgotPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ForgotForm />
    </Suspense>
  )
}
