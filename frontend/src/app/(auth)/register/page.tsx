'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { signUp, signIn } from '@/lib/auth'
import { Button, Input, Label } from '@/components/ui'
import { AuthShell, AuthAlert } from '@/components/auth/AuthShell'

export default function RegisterPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [fullName, setFullName] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

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

    const { error: signInError } = await signIn(email, password)
    if (signInError) {
      router.push('/login?registered=1')
    } else {
      router.push('/dashboard')
    }
  }

  return (
    <AuthShell title="Create your account" subtitle="Start automating your blueprint workflow">
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
      </form>
      <p className="text-center text-slate-500 text-sm mt-6">
        Already have an account?{' '}
        <Link href="/login" className="text-brand-700 hover:text-brand-800 font-medium underline underline-offset-2">
          Sign in
        </Link>
      </p>
    </AuthShell>
  )
}
