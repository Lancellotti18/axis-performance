'use client'
import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { signUp, signIn, resendConfirmation, postAuthDestination, seedProfileFromSignup, type PlanIntent } from '@/lib/auth'
import { supabase } from '@/lib/supabase'
import { Button, Input, Label } from '@/components/ui'
import { AuthShell, AuthAlert } from '@/components/auth/AuthShell'

const API_BASE = (process.env.NEXT_PUBLIC_API_URL || 'https://build-backend-jcp9.onrender.com').trim()

export default function RegisterPage() {
  return (
    <Suspense fallback={<div className="h-56" />}>
      <RegisterForm />
    </Suspense>
  )
}

/** The plan they picked on the homepage, shown above the form so they know
 *  what they are signing up for. The price fills in when the plans endpoint
 *  answers; the name shows straight away. */
function PlanSummary({ intent }: { intent: PlanIntent }) {
  const [price, setPrice] = useState<string | null>(null)
  useEffect(() => {
    fetch(`${API_BASE}/api/v1/billing/plans`, { signal: AbortSignal.timeout(8000) })
      .then(r => r.json())
      .then(d => {
        const p = (d.plans || []).find((x: { key: string }) => x.key === intent.plan)
        if (!p) return
        setPrice(intent.interval === 'year'
          ? `$${Number(p.annual_usd).toLocaleString()} a year`
          : `$${Number(p.monthly_usd).toLocaleString()} a month`)
      })
      .catch(() => {})
  }, [intent.plan, intent.interval])
  const name = intent.plan.charAt(0).toUpperCase() + intent.plan.slice(1)
  return (
    <div className="mb-5 rounded-xl border border-[#cfe0f5] bg-[#eef5fd] px-4 py-3 text-sm text-[#1a1a1a]">
      <span className="font-semibold">{name} plan</span>
      {price && <span className="text-[#47536a]"> · {price}</span>}
      <p className="mt-0.5 text-xs text-[#6b7280]">
        Create your account, confirm your email, then add your card. You can change plans anytime.
      </p>
    </div>
  )
}

function RegisterForm() {
  const router = useRouter()
  const params = useSearchParams()
  const planParam = params.get('plan')
  const intent: PlanIntent | null = planParam && /^[a-z]+$/.test(planParam)
    ? { plan: planParam, interval: params.get('interval') === 'year' ? 'year' : 'month' }
    : null
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [fullName, setFullName] = useState('')
  const [company, setCompany] = useState('')
  const [phone, setPhone] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  // Set when the account exists but Supabase is holding it until the email is
  // confirmed. Shown in place of the form: bouncing to /login loses the address
  // they just typed, so they cannot resend and have nothing to act on.
  const [awaitingEmail, setAwaitingEmail] = useState(false)
  const [resent, setResent] = useState(false)

  // Already signed in (the homepage cannot tell): picking a plan should go
  // straight to paying for it, not to a signup form for an account they have.
  useEffect(() => {
    if (!intent) return
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) router.replace(`/checkout?plan=${intent.plan}&interval=${intent.interval}`)
    })
  }, [intent?.plan, intent?.interval])   // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)

    const { error: signUpError } = await signUp(email, password, fullName, company.trim(), phone.trim(), intent)
    if (signUpError) {
      setError(signUpError.message)
      setLoading(false)
      return
    }

    // With email confirmation ON, Supabase refuses the sign-in until the link
    // is clicked. That is the expected path, not an error.
    const { data: signInData, error: signInError } = await signIn(email, password)
    setLoading(false)
    if (signInError) {
      if (/confirm/i.test(signInError.message)) {
        setAwaitingEmail(true)
      } else {
        router.push('/login?registered=1')
      }
    } else {
      await seedProfileFromSignup(signInData.user)
      router.push(postAuthDestination(signInData.user))
    }
  }

  if (awaitingEmail) {
    return (
      <AuthShell title="Confirm your email"
                 subtitle="One click and your workspace is ready">
        <AuthAlert tone="info">
          We sent a confirmation link to <strong>{email}</strong>. Open it and
          you&rsquo;ll be signed straight in{intent ? ' and taken to checkout' : ''}.
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
      {intent && <PlanSummary intent={intent} />}
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <Label htmlFor="name">Full name</Label>
          <Input id="name" type="text" required autoComplete="name" value={fullName} onChange={e => setFullName(e.target.value)} placeholder="John Smith" />
        </div>
        <div>
          <Label htmlFor="company">Company name</Label>
          <Input id="company" type="text" required autoComplete="organization" value={company} onChange={e => setCompany(e.target.value)} placeholder="Smith Roofing LLC" />
        </div>
        <div>
          <Label htmlFor="phone">Business phone</Label>
          <Input id="phone" type="tel" required autoComplete="tel" minLength={10} title="Your business phone number" value={phone} onChange={e => setPhone(e.target.value)} placeholder="(910) 555-0123" />
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
          Your company name and phone brand every roof report and proposal you send. Add your
          <strong className="text-[#9ca3af]"> logo</strong> in Settings later.
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
