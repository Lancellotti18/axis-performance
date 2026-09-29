'use client'
import { useState, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { signIn, resendConfirmation } from '@/lib/auth'
import { Button, Input, Label } from '@/components/ui'
import { AuthShell, AuthAlert } from '@/components/auth/AuthShell'

function LoginForm() {
  const router = useRouter()
  const params = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  // Set when Supabase refuses the sign-in because the address isn't confirmed
  // yet. That is a normal state now, not a failure, and the only way out of it
  // is a fresh link, so it gets a resend button instead of a raw error.
  const [unconfirmed, setUnconfirmed] = useState(false)
  const [resent, setResent] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setUnconfirmed(false)
    setLoading(true)
    const { error } = await signIn(email, password)
    if (error) {
      if (/not confirmed/i.test(error.message)) {
        setUnconfirmed(true); setResent('idle')
      } else {
        setError(error.message)
      }
      setLoading(false)
    } else {
      router.push('/dashboard')
    }
  }

  return (
    <>
      {params.get('registered') && (
        <div className="mb-4">
          <AuthAlert tone="info">Account created! Check your email to confirm, then sign in.</AuthAlert>
        </div>
      )}
      {params.get('confirmed') && (
        <div className="mb-4">
          <AuthAlert tone="success">Your email is confirmed. Sign in to get started.</AuthAlert>
        </div>
      )}
      {params.get('expired') && (
        <div className="mb-4">
          <AuthAlert tone="info">That confirmation link has expired. Sign in below and we&apos;ll send you a new one.</AuthAlert>
        </div>
      )}
      {params.get('reset') && (
        <div className="mb-4">
          <AuthAlert tone="success">Password updated. Sign in with your new password.</AuthAlert>
        </div>
      )}
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            required
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="you@company.com"
            autoFocus
          />
        </div>
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <Label htmlFor="password" className="mb-0">Password</Label>
            <Link href="/forgot-password" className="text-xs text-[#6b7280] hover:text-brand-600 transition-colors">
              Forgot password?
            </Link>
          </div>
          <Input
            id="password"
            type="password"
            required
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="••••••••"
          />
        </div>
        {error && <AuthAlert tone="error">{error}</AuthAlert>}
        {unconfirmed && (
          <AuthAlert tone="info">
            You haven&apos;t confirmed <strong>{email}</strong> yet. Open the link we emailed you,
            and check spam if it isn&apos;t in your inbox.{' '}
            {resent === 'sent' ? (
              <span className="font-medium">A new link is on its way.</span>
            ) : (
              <button
                type="button"
                disabled={resent === 'sending'}
                onClick={async () => {
                  setResent('sending')
                  const { error: e } = await resendConfirmation(email)
                  setResent(e ? 'failed' : 'sent')
                }}
                className="font-medium underline underline-offset-2 disabled:opacity-50"
              >
                {resent === 'sending' ? 'Sending…' : resent === 'failed' ? 'Couldn\u2019t send, try again' : 'Send a new link'}
              </button>
            )}
          </AuthAlert>
        )}
        <Button type="submit" size="lg" loading={loading} className="w-full">
          {loading ? 'Signing in…' : 'Sign In'}
        </Button>
      </form>
      <p className="text-center text-[#6b7280] text-sm mt-6">
        No account?{' '}
        <Link href="/register" className="text-brand-700 hover:text-brand-800 font-medium underline underline-offset-2">
          Create one free
        </Link>
      </p>
    </>
  )
}

export default function LoginPage() {
  return (
    <AuthShell title="Welcome back" subtitle="Sign in to your account">
      <Suspense fallback={<div className="h-56" />}>
        <LoginForm />
      </Suspense>
    </AuthShell>
  )
}
