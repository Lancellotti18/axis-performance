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
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-8">
      {params.get('registered') && (
        <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg px-4 py-3 text-blue-400 text-sm mb-4">
          Account created! Check your email to confirm, then sign in.
        </div>
      )}
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-1.5">Email</label>
          <input
            type="email" required value={email} onChange={e => setEmail(e.target.value)}
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="you@company.com"
            autoFocus
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-1.5">Password</label>
          <input
            type="password" required value={password} onChange={e => setPassword(e.target.value)}
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="••••••••"
          />
        </div>
        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-red-400 text-sm">
            {error}
          </div>
        )}
        <button
          type="submit" disabled={loading}
          className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold py-2.5 rounded-lg transition-colors"
        >
          {loading ? 'Signing in...' : 'Sign In'}
        </button>
      </form>
      <p className="text-center text-slate-400 text-sm mt-6">
        No account?{' '}
        <Link href="/register" className="text-blue-400 hover:text-blue-300">Create one free</Link>
      </p>
    </div>
  )
}

export default function LoginPage() {
  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white">BuildAI</h1>
          <p className="text-slate-400 mt-2">Sign in to your account</p>
        </div>
        <Suspense fallback={<div className="bg-slate-900 border border-slate-800 rounded-xl p-8 h-64" />}>
          <LoginForm />
        </Suspense>
      </div>
    </div>
  )
}
