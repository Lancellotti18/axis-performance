'use client'

/**
 * Homeowner access page — the "Homeowner Sign In" entrance from the homepage.
 * No accounts, no passwords: the portal link your contractor texted IS your
 * sign-in. This page opens it (paste the link or code) or tells you how to
 * get it back.
 */
import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

export default function PortalAccessPage() {
  const router = useRouter()
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)

  const open = useCallback(() => {
    const v = value.trim()
    if (!v) { setError('Paste your portal link or access code.'); return }
    // Accept a full link (any host) or a bare token.
    const m = v.match(/\/c\/([A-Za-z0-9_-]{8,64})/) || v.match(/^([A-Za-z0-9_-]{8,64})$/)
    if (!m) { setError("That doesn't look like a portal link — it should contain /c/ followed by your code."); return }
    router.push(`/c/${m[1]}`)
  }, [value, router])

  return (
    <main
      className="flex min-h-screen items-center justify-center p-4 text-slate-900 sm:p-8"
      style={{ background: 'linear-gradient(170deg, #f8fafc 0%, #eef4fb 55%, #f8fafc 100%)' }}
    >
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.28em] text-blue-600/80">Homeowner access</div>
          <h1 className="text-2xl font-bold tracking-tight">View your project</h1>
          <p className="mt-2 text-sm text-slate-500">
            No account needed — the link your contractor sent you is your sign-in.
          </p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_10px_40px_-12px_rgba(15,40,80,0.15)] sm:p-6">
          <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">Your portal link or code</label>
          <div className="mt-2 flex gap-2">
            <input
              type="text"
              value={value}
              onChange={e => { setValue(e.target.value); setError(null) }}
              onKeyDown={e => { if (e.key === 'Enter') open() }}
              placeholder="Paste the link from your text message"
              className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-3 text-sm text-slate-900 placeholder:text-slate-400 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            />
            <button
              onClick={open}
              className="shrink-0 rounded-lg px-4 py-3 text-sm font-semibold text-white transition hover:scale-[1.02]"
              style={{ background: 'linear-gradient(180deg, #3B82F6 0%, #1E40AF 100%)', boxShadow: '0 6px 20px rgba(59,130,246,0.35)' }}
            >Open</button>
          </div>
          {error && <p className="mt-2 text-xs text-rose-600">{error}</p>}

          <div className="mt-5 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-500">
            <strong className="text-slate-700">Lost the link?</strong> Your contractor can resend it in
            seconds — call or text them and ask for your <em>project portal link</em>.
          </div>
        </div>

        <p className="mt-4 text-center text-xs text-slate-400">
          Are you a contractor? <Link href="/login" className="font-semibold text-blue-600 hover:underline">Sign in here</Link>
        </p>
      </div>
    </main>
  )
}
