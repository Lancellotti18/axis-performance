'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { Button, Input, Label } from '@/components/ui'
import { AuthShell, AuthAlert } from '@/components/auth/AuthShell'

export default function ResetPasswordPage() {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters.')
      return
    }
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

  const strength = password.length === 0 ? 0 : password.length >= 12 ? 4 : password.length >= 8 ? 3 : password.length >= 6 ? 2 : 1
  const strengthColor = ['', 'bg-red-400', 'bg-amber-400', 'bg-blue-400', 'bg-emerald-500'][strength]
  const strengthText = ['', 'text-red-500', 'text-amber-600', 'text-blue-600', 'text-emerald-600'][strength]
  const strengthLabel = ['', 'Weak', 'Fair', 'Good', 'Strong'][strength]

  const mismatch = confirm.length > 0 && confirm !== password

  return (
    <AuthShell title="Set new password" subtitle="Choose a strong password for your account">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <Label htmlFor="pw">New password</Label>
          <Input
            id="pw"
            type="password"
            required
            minLength={6}
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="Min. 6 characters"
            autoFocus
          />
          {password.length > 0 && (
            <div className="mt-2 space-y-1">
              <div className="flex gap-1">
                {[1, 2, 3, 4].map(i => (
                  <div key={i} className={`h-1 flex-1 rounded-full transition-all duration-300 ${i <= strength ? strengthColor : 'bg-slate-200'}`} />
                ))}
              </div>
              <p className={`text-xs font-medium ${strengthText}`}>{strengthLabel}</p>
            </div>
          )}
        </div>

        <div>
          <Label htmlFor="confirm">Confirm password</Label>
          <Input
            id="confirm"
            type="password"
            required
            minLength={6}
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
            placeholder="Repeat password"
            invalid={mismatch}
          />
          {mismatch && <p className="text-red-500 text-xs mt-1">Passwords don&apos;t match</p>}
        </div>

        {error && <AuthAlert tone="error">{error}</AuthAlert>}

        <Button type="submit" size="lg" loading={loading} disabled={mismatch} className="w-full">
          {loading ? 'Updating password…' : 'Update Password'}
        </Button>
      </form>

      <p className="text-center text-slate-500 text-sm mt-6">
        <Link href="/login" className="text-slate-500 hover:text-brand-700 transition-colors">
          ← Back to Sign In
        </Link>
      </p>
    </AuthShell>
  )
}
