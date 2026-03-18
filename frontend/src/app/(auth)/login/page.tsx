'use client'
import { useState, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { signIn } from '@/lib/auth'

function LoginForm() {
  const router = useRouter()
  const params = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    const { error } = await signIn(email, password)
    if (error) {
      setError(error.message)
      setLoading(false)
    } else {
      router.push('/dashboard')
    }
  }

  return (
    <div className="bg-white/10 backdrop-blur-md border border-white/20 rounded-2xl p-8 shadow-2xl">
      {params.get('registered') && (
        <div className="bg-blue-500/20 border border-blue-400/30 rounded-xl px-4 py-3 text-blue-200 text-sm mb-4">
          Account created! Check your email to confirm, then sign in.
        </div>
      )}
      {params.get('reset') && (
        <div className="bg-green-500/20 border border-green-400/30 rounded-xl px-4 py-3 text-green-200 text-sm mb-4">
          Password updated successfully. Sign in with your new password.
        </div>
      )}
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-white/80 mb-1.5">Email</label>
          <input
            type="email" required value={email} onChange={e => setEmail(e.target.value)}
            className="w-full bg-white/10 border border-white/20 rounded-xl px-4 py-2.5 text-white placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-white/40 focus:border-white/40 transition-all"
            placeholder="you@company.com"
            autoFocus
          />
        </div>
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="block text-sm font-medium text-white/80">Password</label>
            <Link href="/forgot-password" className="text-xs text-white/50 hover:text-white transition-colors">
              Forgot password?
            </Link>
          </div>
          <input
            type="password" required value={password} onChange={e => setPassword(e.target.value)}
            className="w-full bg-white/10 border border-white/20 rounded-xl px-4 py-2.5 text-white placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-white/40 focus:border-white/40 transition-all"
            placeholder="••••••••"
          />
        </div>
        {error && (
          <div className="bg-red-500/20 border border-red-400/30 rounded-xl px-4 py-3 text-red-200 text-sm">
            {error}
          </div>
        )}
        <button
          type="submit" disabled={loading}
          className="w-full bg-white text-blue-700 font-bold py-3 rounded-xl hover:bg-blue-50 disabled:opacity-50 transition-all duration-200 shadow-lg mt-2"
        >
          {loading ? 'Signing in…' : 'Sign In'}
        </button>
      </form>
      <p className="text-center text-white/40 text-sm mt-6">
        No account?{' '}
        <Link href="/register" className="text-white/80 hover:text-white font-medium underline underline-offset-2">
          Create one free
        </Link>
      </p>
    </div>
  )
}

export default function LoginPage() {
  return (
    <div
      className="min-h-screen flex items-center justify-center px-4 bg-cover bg-center bg-no-repeat"
      style={{ backgroundImage: "url('/blueprint-hero.png')" }}
    >
      <div className="absolute inset-0 bg-[#1a3a6b]/70 backdrop-blur-sm" />
      <div className="relative z-10 w-full max-w-sm">
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
          <h1 className="text-2xl font-black text-white">Welcome back</h1>
          <p className="text-white/50 text-sm mt-1">Sign in to your account</p>
        </div>
        <Suspense fallback={<div className="bg-white/10 border border-white/20 rounded-2xl p-8 h-64" />}>
          <LoginForm />
        </Suspense>
      </div>
    </div>
  )
}
