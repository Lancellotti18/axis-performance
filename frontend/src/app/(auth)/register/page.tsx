'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { signUp, signIn, resendConfirmation } from '@/lib/auth'
import { Button, Input, Label } from '@/components/ui'
import { AuthShell, AuthAlert } from '@/components/auth/AuthShell'

export default function RegisterPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [fullName, setFullName] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  // Set when the account exists but Supabase is holding it until the email is
  // confirmed. Shown in place of the form: bouncing to /login loses the address
  // they just typed, so they cannot resend and have nothing to act on.
  const [awaitingEmail, setAwaitingEmail] = useState(false)
  const [resent, setResent] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)

    const { error: signUpError } = await signUp(email, password, fullName, '')
    if (signUpError) {
      setError(signUpError.message)
      setLoading(false)
      return
    }

    // With email confirmation ON, Supabase refuses the sign-in until the link
    // is clicked. That is the expected path, not an error.
    const { error: signInError } = await signIn(email, password)
    setLoading(false)
    if (signInError) {
      if (/confirm/i.test(signInError.message)) {
        setAwaitingEmail(true)
      } else {
        router.push('/login?registered=1')
      }
    } else {
      router.push('/dashboard')
    }
  }

  if (awaitingEmail) {
    return (
      <AuthShell title="Confirm your email"
                 subtitle="One click and your workspace is ready">
        <AuthAlert tone="info">
          We sent a confirmation link to <strong>{email}</strong>. Open it and
          you&rsquo;ll be signed straight in.
        </AuthAlert>
        <p className="mt-4 text-center text-xs leading-relaxed text-[#6b7280]">
          It usually arrives within a minute. Check your spam folder before
          resending &mdash; a second copy lands in the same place as the first.
        </p>
        <div className="mt-4 space-y-3">
          <Button type="button" size="lg" variant="secondary" className="w-full"
                  disabled={resent}
                  onClick={async () => {
                    const { error: e } = await resendConfirmation(email)
                    if (e) setError(e.message)
                    else setResent(true)
                  }}>
            {resent ? 'Sent again — check your inbox' : 'Resend the link'}
          </Button>
          {error && <AuthAlert tone="error">{error}</AuthAlert>}
        </div>
        <p className="text-center text-[#6b7280] text-sm mt-6">
          Wrong address?{' '}
          <button type="button"
                  onClick={() => { setAwaitingEmail(false); setResent(false); setError('') }}
                  className="text-brand-700 hover:text-brand-800 font-medium underline underline-offset-2">
            Start again
          </button>
        </p>
      </AuthShell>
    )
  }

  return (
    <AuthShell title="Create your account" subtitle="Set up your roofing workspace in seconds">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <Label htmlFor="name">Full name</Label>
          <Input id="name" type="text" required value={fullName} onChange={e => setFullName(e.target.value)} placeholder="John Smith" />
        </div>
        <div>
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="you@company.com" />
        </div>
        <div>
          <Label htmlFor="password">Password</Label>
          <Input id="password" type="password" required minLength={6} value={password} onChange={e => setPassword(e.target.value)} placeholder="Min. 6 characters" />
        </div>
        {error && <AuthAlert tone="error">{error}</AuthAlert>}
        <Button type="submit" size="lg" loading={loading} className="w-full">
          {loading ? 'Creating account…' : 'Create Account'}
        </Button>
        <p className="text-center text-xs leading-relaxed text-[#6b7280]">
          By creating an account you agree to our{' '}
          <Link href="/legal/terms" className="text-brand-700 underline underline-offset-2">Terms of Service</Link>
          {' '}and{' '}
          <Link href="/legal/privacy" className="text-brand-700 underline underline-offset-2">Privacy Policy</Link>,
          which you&rsquo;ll be asked to acknowledge next.
        </p>
        <p className="text-center text-xs leading-relaxed text-[#6b7280]">
          Next, add your <strong className="text-[#9ca3af]">business name and logo</strong> in Settings —
          they brand every roof report and proposal you send, and appear throughout your CRM.
        </p>
      </form>
      <p className="text-center text-[#6b7280] text-sm mt-6">
        Already have an account?{' '}
        <Link href="/login" className="text-brand-700 hover:text-brand-800 font-medium underline underline-offset-2">
          Sign in
        </Link>
      </p>
    </AuthShell>
  )
}
