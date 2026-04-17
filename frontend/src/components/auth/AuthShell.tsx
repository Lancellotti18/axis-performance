'use client'
import Link from 'next/link'
import type { ReactNode } from 'react'

/**
 * Shared layout for auth pages (login, register, forgot-password, reset-password).
 *
 * Matches the dashboard's light gradient background + slate ink so the
 * sign-in → app transition is visually continuous (Stripe / Linear pattern).
 */
export function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: ReactNode
  children: ReactNode
}) {
  return (
    <div
      className="min-h-screen flex items-center justify-center px-4 py-10"
      style={{ background: 'linear-gradient(135deg, #eef6ff 0%, #ffffff 100%)' }}
    >
      <div className="w-full max-w-sm">
        <div className="text-center mb-7">
          <Link href="/" className="inline-flex items-center gap-2.5 mb-4">
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden>
              <rect x="2" y="2" width="24" height="24" rx="4" stroke="#2563eb" strokeWidth="1.5" />
              <line x1="7" y1="8" x2="21" y2="8" stroke="#2563eb" strokeWidth="1.5" strokeLinecap="round" />
              <line x1="7" y1="12" x2="17" y2="12" stroke="#2563eb" strokeWidth="1.5" strokeLinecap="round" opacity="0.7" />
              <line x1="7" y1="16" x2="19" y2="16" stroke="#2563eb" strokeWidth="1.5" strokeLinecap="round" opacity="0.7" />
              <line x1="7" y1="20" x2="14" y2="20" stroke="#2563eb" strokeWidth="1.5" strokeLinecap="round" opacity="0.4" />
            </svg>
            <span className="text-lg font-bold text-slate-800 tracking-tight">Axis Performance</span>
          </Link>
          <h1 className="text-2xl font-black text-slate-800">{title}</h1>
          {subtitle && <p className="text-slate-500 text-sm mt-1">{subtitle}</p>}
        </div>

        <div
          className="bg-white rounded-2xl p-8 border"
          style={{
            borderColor: 'rgba(219,234,254,0.9)',
            boxShadow: '0 2px 12px rgba(59,130,246,0.08)',
          }}
        >
          {children}
        </div>
      </div>
    </div>
  )
}

/**
 * Standardised alert box used inside AuthShell — success / info / error tones.
 */
export function AuthAlert({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'success' | 'error'
  children: ReactNode
}) {
  const styles =
    tone === 'success'
      ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
      : tone === 'error'
      ? 'bg-red-50 border-red-200 text-red-800'
      : 'bg-blue-50 border-blue-200 text-blue-800'
  return (
    <div className={`border rounded-xl px-4 py-3 text-sm ${styles}`}>{children}</div>
  )
}
