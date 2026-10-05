'use client'
import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { Suspense } from 'react'
import type { EmailOtpType } from '@supabase/supabase-js'
import { postAuthDestination, seedProfileFromSignup } from '@/lib/auth'

function CallbackHandler() {
  const router = useRouter()
  const params = useSearchParams()
  const [error, setError] = useState('')

  // Signed in by the link: fill their profile from the signup details, then
  // on to checkout if they picked a plan before signing up, else the dashboard.
  async function arrive() {
    const { data } = await supabase.auth.getUser()
    await seedProfileFromSignup(data.user)
    router.replace(postAuthDestination(data.user))
  }

  useEffect(() => {
    async function handle() {
      // Supabase reports a bad link (expired, already used) by redirecting here
      // with error params in the query or the hash rather than with a code.
      const hashParams = new URLSearchParams(window.location.hash.replace('#', ''))
      const errCode = params.get('error_code') || hashParams.get('error_code')
      if (errCode) {
        if (params.get('type') === 'recovery' || hashParams.get('type') === 'recovery') {
          setError(params.get('error_description') || hashParams.get('error_description') || 'Link expired')
        } else {
          // A signup link. /login explains it and offers a fresh one.
          router.replace('/login?expired=1')
        }
        return
      }

      // token_hash flow: the link carries a hash we verify server-side. Unlike
      // the code flow below it needs nothing stored in THIS browser, so it works
      // when someone signs up on a laptop and taps the link on their phone.
      // Used once the "Confirm signup" email template points here with
      // ?token_hash={{ .TokenHash }}&type=email.
      const tokenHash = params.get('token_hash')
      const otpType = params.get('type') as EmailOtpType | null
      if (tokenHash && otpType) {
        const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: otpType })
        if (error) {
          if (otpType === 'recovery') { setError(error.message); return }
          router.replace('/login?expired=1')
          return
        }
        if (otpType === 'recovery') router.replace('/reset-password')
        else await arrive()
        return
      }

      // PKCE flow: Supabase sends ?code=XXX after the user clicks the email link
      const code = params.get('code')
      const type = params.get('type') // 'recovery' for password reset

      if (code) {
        const { error } = await supabase.auth.exchangeCodeForSession(code)
        if (error) {
          // The exchange needs a verifier that signUp stored in the browser the
          // account was created in. Opened anywhere else (the phone, a different
          // browser, a mail app's webview) it fails, even though Supabase has
          // ALREADY confirmed the address before redirecting here with a code.
          // So for a signup this is a success that just needs a sign-in, not an
          // "invalid reset link".
          if (type === 'recovery') { setError(error.message); return }
          router.replace('/login?confirmed=1')
          return
        }
        if (type === 'recovery') {
          router.replace('/reset-password')
        } else {
          await arrive()
        }
        return
      }

      // Implicit flow fallback: token is in the URL hash (#access_token=...)
      // Next.js can't read hash server-side, so we parse it client-side
      if (window.location.hash) {
        const accessToken = hashParams.get('access_token')
        const refreshToken = hashParams.get('refresh_token')
        const hashType = hashParams.get('type')

        if (accessToken && refreshToken) {
          const { error } = await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken })
          if (error) { setError(error.message); return }
          if (hashType === 'recovery') {
            router.replace('/reset-password')
          } else {
            await arrive()
          }
          return
        }
      }

      // No code or hash — something went wrong
      setError('Invalid or expired reset link. Please request a new one.')
    }

    handle()
  }, [params, router])   // eslint-disable-line react-hooks/exhaustive-deps -- arrive only reads router

  if (error) {
    return (
      <div className="text-center space-y-4">
        <div className="w-12 h-12 bg-red-500/20 border border-red-400/30 rounded-full flex items-center justify-center mx-auto">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        </div>
        <div>
          <div className="text-[#1a1a1a] font-bold mb-1">Link expired or invalid</div>
          <p className="text-[#1a1a1a]/60 text-sm">{error}</p>
        </div>
        <a href="/forgot-password" className="inline-block mt-2 bg-white text-blue-700 font-bold px-5 py-2.5 rounded-xl text-sm hover:bg-blue-50 transition-all">
          Request a new link
        </a>
      </div>
    )
  }

  return (
    <div className="text-center space-y-3">
      <svg className="animate-spin text-[#1a1a1a]/50 mx-auto" width="28" height="28" viewBox="0 0 24 24" fill="none">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/>
      </svg>
      <p className="text-[#1a1a1a]/60 text-sm">Verifying your link…</p>
    </div>
  )
}

export default function AuthCallbackPage() {
  return (
    <div
      className="min-h-screen flex items-center justify-center px-4 bg-cover bg-center"
      style={{ backgroundImage: "url('/blueprint-hero.png')" }}
    >
      <div className="absolute inset-0 bg-[#0060c4]/70" />
      <div className="relative z-10 w-full max-w-sm">
        <div className="bg-[#eeeeed] border border-[#dededc] rounded-2xl p-10 shadow-2xl">
          <Suspense fallback={<div className="text-center text-[#1a1a1a]/50 text-sm">Loading…</div>}>
            <CallbackHandler />
          </Suspense>
        </div>
      </div>
    </div>
  )
}
