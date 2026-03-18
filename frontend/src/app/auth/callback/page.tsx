'use client'
import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { Suspense } from 'react'

function CallbackHandler() {
  const router = useRouter()
  const params = useSearchParams()
  const [error, setError] = useState('')

  useEffect(() => {
    async function handle() {
      // PKCE flow: Supabase sends ?code=XXX after the user clicks the email link
      const code = params.get('code')
      const type = params.get('type') // 'recovery' for password reset

      if (code) {
        const { error } = await supabase.auth.exchangeCodeForSession(code)
        if (error) {
          setError(error.message)
          return
        }
        if (type === 'recovery') {
          router.replace('/reset-password')
        } else {
          router.replace('/dashboard')
        }
        return
      }

      // Implicit flow fallback: token is in the URL hash (#access_token=...)
      // Next.js can't read hash server-side, so we parse it client-side
      const hash = window.location.hash
      if (hash) {
        const hashParams = new URLSearchParams(hash.replace('#', ''))
        const accessToken = hashParams.get('access_token')
        const refreshToken = hashParams.get('refresh_token')
        const hashType = hashParams.get('type')

        if (accessToken && refreshToken) {
          const { error } = await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken })
          if (error) { setError(error.message); return }
          if (hashType === 'recovery') {
            router.replace('/reset-password')
          } else {
            router.replace('/dashboard')
          }
          return
        }
      }

      // No code or hash — something went wrong
      setError('Invalid or expired reset link. Please request a new one.')
    }

    handle()
  }, [params, router])

  if (error) {
    return (
      <div className="text-center space-y-4">
        <div className="w-12 h-12 bg-red-500/20 border border-red-400/30 rounded-full flex items-center justify-center mx-auto">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        </div>
        <div>
          <div className="text-white font-bold mb-1">Link expired or invalid</div>
          <p className="text-white/60 text-sm">{error}</p>
        </div>
        <a href="/forgot-password" className="inline-block mt-2 bg-white text-blue-700 font-bold px-5 py-2.5 rounded-xl text-sm hover:bg-blue-50 transition-all">
          Request a new link
        </a>
      </div>
    )
  }

  return (
    <div className="text-center space-y-3">
      <svg className="animate-spin text-white/50 mx-auto" width="28" height="28" viewBox="0 0 24 24" fill="none">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/>
      </svg>
      <p className="text-white/60 text-sm">Verifying your link…</p>
    </div>
  )
}

export default function AuthCallbackPage() {
  return (
    <div
      className="min-h-screen flex items-center justify-center px-4 bg-cover bg-center"
      style={{ backgroundImage: "url('/blueprint-hero.png')" }}
    >
      <div className="absolute inset-0 bg-[#1a3a6b]/70 backdrop-blur-sm" />
      <div className="relative z-10 w-full max-w-sm">
        <div className="bg-white/10 backdrop-blur-md border border-white/20 rounded-2xl p-10 shadow-2xl">
          <Suspense fallback={<div className="text-center text-white/50 text-sm">Loading…</div>}>
            <CallbackHandler />
          </Suspense>
        </div>
      </div>
    </div>
  )
}
