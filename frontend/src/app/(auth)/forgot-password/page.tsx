'use client'
import { useState, Suspense } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { Button, Input, Label } from '@/components/ui'
import { AuthShell, AuthAlert } from '@/components/auth/AuthShell'

function ForgotForm() {
  const params = useSearchParams()
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState(
    params.get('error') === 'invalid_link' ? 'That reset link has expired. Please request a new one.' : '',
  )

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
    <AuthShell title="Reset your password" subtitle={sent ? 'Check your inbox' : "We'll send you a reset link"}>
      {sent ? (
        <div className="text-center space-y-4">
          <div className="w-14 h-14 bg-emerald-50 border border-emerald-200 rounded-full flex items-center justify-center mx-auto">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#059669" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
              <polyline points="22,6 12,13 2,6" />
            </svg>
          </div>
          <div>
            <div className="text-slate-800 font-bold mb-1">Email sent!</div>
            <p className="text-slate-500 text-sm leading-relaxed">
              We sent a password reset link to <span className="text-slate-800 font-medium">{email}</span>. Click the link to set a new password.
            </p>
          </div>
          <p className="text-slate-400 text-xs pt-2">
            Didn&apos;t get it? Check your spam folder or{' '}
            <button onClick={() => setSent(false)} className="text-brand-700 hover:text-brand-800 underline underline-offset-2 transition-colors">
              try again
            </button>
            .
          </p>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor="email">Email address</Label>
            <Input id="email" type="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="you@company.com" autoFocus />
          </div>
          {error && <AuthAlert tone="error">{error}</AuthAlert>}
          <Button type="submit" size="lg" loading={loading} className="w-full">
            {loading ? 'Sending…' : 'Send Reset Link'}
          </Button>
        </form>
      )}

      <p className="text-center text-slate-500 text-sm mt-6">
        <Link href="/login" className="text-slate-500 hover:text-brand-700 transition-colors">
          ← Back to Sign In
        </Link>
      </p>
    </AuthShell>
  )
}

export default function ForgotPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ForgotForm />
    </Suspense>
  )
}
