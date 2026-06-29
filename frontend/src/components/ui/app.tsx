'use client'
/**
 * Axis Performance — dark "app" UI primitives.
 *
 * The light Button/Input/Card/Badge in this folder serve the auth pages (light
 * AuthShell). These are their dark-glass counterparts for the in-app screens
 * (dashboard, projects, tools) so every app surface is consistent + premium.
 */
import React, { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import { cn } from '@/lib/cn'

// ── Spinner ──────────────────────────────────────────────────────────────────
export function Spinner({ size = 14, className = '' }: { size?: number; className?: string }) {
  return (
    <svg className={cn('animate-spin', className)} width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  )
}

// ── Button styling (shared by AppButton + ButtonLink) ────────────────────────
export type AppVariant = 'primary' | 'glass' | 'ghost' | 'danger'
export type AppSize = 'sm' | 'md' | 'lg'

const BASE =
  'inline-flex items-center justify-center gap-2 font-semibold rounded-xl transition-all duration-150 ' +
  'active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/40 ' +
  'disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap select-none'
const SIZES: Record<AppSize, string> = {
  sm: 'text-xs px-3 py-1.5',
  md: 'text-sm px-4 py-2.5',
  lg: 'text-sm px-6 py-3',
}
const VARIANTS: Record<AppVariant, string> = {
  primary: 'text-white hover:brightness-110',
  glass: 'text-slate-200 bg-white/[0.06] border border-white/12 hover:bg-white/10 hover:border-white/20',
  ghost: 'text-slate-300 hover:text-white hover:bg-white/[0.06]',
  danger: 'text-rose-300 bg-rose-500/10 border border-rose-400/25 hover:bg-rose-500/20',
}
const PRIMARY_STYLE: React.CSSProperties = {
  background: 'linear-gradient(180deg, #3B82F6 0%, #1E40AF 100%)',
  boxShadow: '0 6px 20px rgba(59,130,246,0.35), inset 0 1px 0 rgba(255,255,255,0.2)',
}

interface AppBtnCommon { variant?: AppVariant; size?: AppSize; leftIcon?: React.ReactNode; className?: string; children?: React.ReactNode }

export function AppButton({
  variant = 'glass', size = 'md', leftIcon, loading = false, className, style, disabled, children, ...rest
}: AppBtnCommon & { loading?: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cn(BASE, SIZES[size], VARIANTS[variant], className)}
      style={variant === 'primary' ? { ...PRIMARY_STYLE, ...style } : style}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Spinner size={size === 'lg' ? 16 : 14} /> : leftIcon}
      {children}
    </button>
  )
}

export function ButtonLink({ variant = 'glass', size = 'md', leftIcon, className, style, href, children }: AppBtnCommon & { href: string; style?: React.CSSProperties }) {
  return (
    <Link href={href} className={cn(BASE, SIZES[size], VARIANTS[variant], className)} style={variant === 'primary' ? { ...PRIMARY_STYLE, ...style } : style}>
      {leftIcon}{children}
    </Link>
  )
}

// ── StatusBadge (dark) — electric-blue palette, rose only for failures ───────
export function StatusBadge({ status, className = '' }: { status: string; className?: string }) {
  const map: Record<string, { cls: string; dot: string; label: string }> = {
    complete:   { cls: 'bg-blue-500/15 text-blue-200 border-blue-400/30', dot: 'bg-blue-400', label: 'Complete' },
    processing: { cls: 'bg-white/[0.05] text-slate-300 border-white/10', dot: 'bg-blue-400 animate-pulse', label: 'In progress' },
    pending:    { cls: 'bg-white/[0.05] text-slate-300 border-white/10', dot: 'bg-blue-400 animate-pulse', label: 'In progress' },
    failed:     { cls: 'bg-rose-500/15 text-rose-300 border-rose-400/30', dot: 'bg-rose-400', label: 'Failed' },
  }
  const s = map[status] || { cls: 'bg-white/[0.05] text-slate-400 border-white/10', dot: 'bg-slate-500', label: status }
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-full border', s.cls, className)}>
      <span className={cn('w-1.5 h-1.5 rounded-full', s.dot)} />
      {s.label}
    </span>
  )
}

// ── PageTransition — gentle fade + rise on mount (premium, not flashy) ───────
export function PageTransition({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <motion.div className={className} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, ease: 'easeOut' }}>
      {children}
    </motion.div>
  )
}

// ── CountUp — gentle number animation for stats ──────────────────────────────
export function CountUp({ value, duration = 600, className = '' }: { value: number; duration?: number; className?: string }) {
  const [n, setN] = useState(0)
  const fromRef = useRef(0)
  useEffect(() => {
    const from = fromRef.current
    const start = performance.now()
    let raf = 0
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / duration)
      const eased = 1 - Math.pow(1 - p, 3)
      setN(Math.round(from + (value - from) * eased))
      if (p < 1) raf = requestAnimationFrame(tick)
      else fromRef.current = value
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value, duration])
  return <span className={className}>{n}</span>
}
