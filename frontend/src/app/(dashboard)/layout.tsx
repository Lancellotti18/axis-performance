'use client'
import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import { getUser, signOut } from '@/lib/auth'
import { PrecisionToggle } from '@/components/axis'

const API_BASE = (process.env.NEXT_PUBLIC_API_URL || 'https://build-backend-jcp9.onrender.com').trim()

const NAV = [
  { href: '/dashboard',       label: 'Dashboard',        icon: IconDashboard },
  { href: '/projects',        label: 'Projects',         icon: IconProjects },
  { href: '/projects/new',    label: 'Upload Blueprint',  icon: IconUpload },
  { href: '/material-check',  label: 'Material Compliance', icon: IconMaterialCheck },
  { href: '/home-visualizer', label: 'Home Visualizer',    icon: IconVisualizer },
  { href: '/aerial-report',   label: 'Aerial Roof Report', icon: IconAerial },
  { href: '/storm-report',    label: 'Storm Risk Report',  icon: IconStorm },
  { href: '/crm',             label: 'CRM',              icon: IconCRM },
  { href: '/reports',         label: 'Reports',          icon: IconReports },
  { href: '/permits',         label: 'Permits',          icon: IconPermits },
  { href: '/settings',        label: 'Settings',         icon: IconSettings },
]

function IconDashboard({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={active ? '#2563eb' : '#94a3b8'} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
      <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
    </svg>
  )
}
function IconProjects({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={active ? '#2563eb' : '#94a3b8'} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>
    </svg>
  )
}
function IconUpload({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={active ? '#2563eb' : '#94a3b8'} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
    </svg>
  )
}
function IconReports({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={active ? '#2563eb' : '#94a3b8'} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>
      <line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/>
    </svg>
  )
}
function IconPermits({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={active ? '#2563eb' : '#94a3b8'} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="4" width="16" height="16" rx="2"/>
      <path d="M9 12l2 2 4-4"/>
    </svg>
  )
}
function IconSettings({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={active ? '#2563eb' : '#94a3b8'} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/>
    </svg>
  )
}

function IconMaterialCheck({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={active ? '#2563eb' : '#94a3b8'} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>
    </svg>
  )
}

function IconVisualizer({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={active ? '#2563eb' : '#94a3b8'} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="14" rx="2"/>
      <path d="M3 9l4-4 4 4 4-4 4 4"/>
      <path d="M8 21h8M12 17v4"/>
    </svg>
  )
}

function IconAerial({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={active ? '#2563eb' : '#94a3b8'} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>
      <polyline points="9 22 9 12 15 12 15 22"/>
    </svg>
  )
}

function IconStorm({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={active ? '#2563eb' : '#94a3b8'} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 16.9A5 5 0 0018 7h-1.26A8 8 0 104 15.3"/>
      <polyline points="13 11 9 17 15 17 11 23"/>
    </svg>
  )
}

function IconCRM({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={active ? '#2563eb' : '#94a3b8'} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/>
      <circle cx="9" cy="7" r="4"/>
      <path d="M23 21v-2a4 4 0 00-3-3.87"/>
      <path d="M16 3.13a4 4 0 010 7.75"/>
    </svg>
  )
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const [user, setUser] = useState<any>(null)
  const [signingOut, setSigningOut] = useState(false)
  const [serverWaking, setServerWaking] = useState(false)
  const [wakingSeconds, setWakingSeconds] = useState(0)

  useEffect(() => {
    getUser().then(u => {
      if (!u) router.push('/login')
      else setUser(u)
    })

    // Ping health — if it takes >4s, server is cold — show banner
    let bannerTimer: ReturnType<typeof setTimeout>
    let countInterval: ReturnType<typeof setInterval>
    const start = Date.now()

    bannerTimer = setTimeout(() => {
      setServerWaking(true)
      setWakingSeconds(0)
      countInterval = setInterval(() => {
        setWakingSeconds(Math.round((Date.now() - start) / 1000))
      }, 1000)
    }, 4000)

    // AbortSignal.timeout() is not supported in Safari < 16.4 — use AbortController instead
    const abortCtrl  = new AbortController()
    const abortTimer = setTimeout(() => abortCtrl.abort(), 90000)

    fetch(`${API_BASE}/health`, { signal: abortCtrl.signal })
      .then(() => {
        clearTimeout(abortTimer)
        clearTimeout(bannerTimer)
        clearInterval(countInterval)
        setServerWaking(false)
      })
      .catch(() => {
        clearTimeout(abortTimer)
        clearTimeout(bannerTimer)
        clearInterval(countInterval)
        setServerWaking(false)
      })

    return () => { clearTimeout(abortTimer); clearTimeout(bannerTimer); clearInterval(countInterval) }
  }, [router])

  async function handleSignOut() {
    setSigningOut(true)
    await signOut()
    router.push('/')
  }

  const initials = user?.user_metadata?.full_name
    ? user.user_metadata.full_name.split(' ').map((n: string) => n[0]).join('').toUpperCase().slice(0, 2)
    : user?.email?.slice(0, 2).toUpperCase() ?? '?'

  return (
    <div
      className="flex flex-col h-screen overflow-hidden font-sans"
      style={{
        background:
          'radial-gradient(900px 500px at 100% 0%, rgba(127,201,244,0.20), transparent 60%),' +
          'radial-gradient(700px 400px at 0% 100%, rgba(220,239,251,0.55), transparent 60%),' +
          'linear-gradient(135deg, #F4F9FE 0%, #FFFFFF 60%, #EAF4FC 100%)',
      }}
    >

      {/* Server wake-up banner */}
      {serverWaking && (
        <div className="flex items-center justify-center gap-3 bg-amber-50 border-b border-amber-200 px-6 py-2.5 text-amber-800 text-sm font-medium flex-shrink-0" style={{ zIndex: 100 }}>
          <svg className="animate-spin flex-shrink-0" width="14" height="14" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>
          Server is waking up from sleep — this takes ~30–60 seconds.
          <span className="text-amber-600 font-normal">({wakingSeconds}s elapsed)</span>
          Your requests will go through automatically once it's ready.
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">

      {/* Subtle dot-grid overlay */}
      <div className="fixed inset-0 pointer-events-none" style={{ zIndex: 0 }}>
        <svg width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <pattern id="axis-dots" width="28" height="28" patternUnits="userSpaceOnUse">
              <circle cx="1.2" cy="1.2" r="1.2" fill="#7FC9F4" fillOpacity="0.13" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#axis-dots)" />
        </svg>
      </div>

      {/* ── SIDEBAR ──────────────────────────────────────────────────────── */}
      <aside
        className="w-60 flex-shrink-0 flex flex-col axis-glass-strong axis-plate axis-plate-soft relative"
        style={{ zIndex: 10 }}
      >
        {/* Vertical baby-blue rail along outer edge */}
        <div
          className="absolute top-0 bottom-0 right-0 w-px pointer-events-none"
          style={{
            background:
              'linear-gradient(180deg, rgba(127,201,244,0) 0%, rgba(127,201,244,0.55) 30%, rgba(127,201,244,0.55) 70%, rgba(127,201,244,0) 100%)',
          }}
        />
        {/* Logo — Axis A wordmark, 80px */}
        <div className="flex items-center gap-2.5 justify-center h-20 border-b" style={{ borderColor: 'var(--axis-glass-border)' }}>
          <div
            className="relative w-11 h-11 rounded-2xl flex items-center justify-center axis-sweep"
            style={{
              background: 'linear-gradient(180deg, #1B2433 0%, #06090E 100%)',
              border: '1px solid rgba(127,201,244,0.45)',
              boxShadow: '0 0 0 1px rgba(127,201,244,0.20), 0 4px 12px -4px rgba(127,201,244,0.45)',
            }}
          >
            <svg width="20" height="20" viewBox="0 0 28 28" fill="none">
              <path d="M14 4 L24 24 H19 L17 19 H11 L9 24 H4 Z" fill="#BFE6FF" />
              <path d="M12.5 15 H15.5 L14 11 Z" fill="#06090E" />
            </svg>
          </div>
          <div className="leading-none">
            <div className="text-[14px] font-black tracking-tight text-slate-800">AXIS</div>
            <div className="text-[9px] font-bold tracking-[0.3em] text-slate-400 mt-0.5">PERFORMANCE</div>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-3 py-5 space-y-1 overflow-y-auto">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || (href !== '/dashboard' && pathname.startsWith(href) && href !== '/projects/new')
            return (
              <Link
                key={href}
                href={href}
                className={`flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all duration-200 group relative overflow-hidden ${
                  active ? 'text-slate-900' : 'text-slate-500 hover:text-slate-800'
                }`}
                style={
                  active
                    ? {
                        background: 'linear-gradient(90deg, rgba(220,239,251,0.95) 0%, rgba(255,255,255,0.85) 100%)',
                        boxShadow: '0 0 0 1px rgba(127,201,244,0.45), 0 0 12px rgba(127,201,244,0.30)',
                      }
                    : {}
                }
              >
                {active && (
                  <span
                    className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-full"
                    style={{
                      background: 'linear-gradient(180deg, #BFE6FF 0%, #4FB0EA 100%)',
                      boxShadow: '0 0 8px rgba(127,201,244,0.85)',
                    }}
                  />
                )}
                <Icon active={active} />
                {label}
              </Link>
            )
          })}
        </nav>

        {/* Profile + Pro Plan */}
        <div className="border-t p-4 space-y-3" style={{ borderColor: 'var(--axis-glass-border)' }}>
          <div className="flex items-center gap-3">
            <div
              className="w-9 h-9 rounded-full flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
              style={{
                background: 'linear-gradient(180deg, #1B2433 0%, #06090E 100%)',
                border: '1px solid rgba(127,201,244,0.55)',
                boxShadow: '0 0 0 1px rgba(127,201,244,0.20), 0 0 10px rgba(127,201,244,0.30)',
                color: '#BFE6FF',
              }}
            >
              {initials}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-slate-800 text-xs font-semibold truncate">
                {user?.user_metadata?.full_name || 'Contractor'}
              </div>
              <div className="text-slate-400 text-[10px] truncate">{user?.email}</div>
            </div>
          </div>
          <div
            className="flex items-center justify-between px-3 py-2 rounded-xl axis-sweep"
            style={{
              background: 'linear-gradient(180deg, #FFFFFF 0%, #DCEFFB 100%)',
              border: '1px solid rgba(127,201,244,0.45)',
              boxShadow: '0 0 0 1px rgba(127,201,244,0.18), 0 0 10px rgba(127,201,244,0.20)',
            }}
          >
            <span className="text-slate-800 text-[11px] font-bold tracking-[0.18em] uppercase">Pro Plan</span>
            <span className="axis-pulse" />
          </div>
          <button
            onClick={handleSignOut}
            disabled={signingOut}
            className="w-full text-left text-xs text-slate-400 hover:text-slate-700 transition-colors px-1 py-0.5"
          >
            {signingOut ? 'Signing out...' : 'Sign out'}
          </button>
        </div>
      </aside>

        {/* ── MAIN AREA ─────────────────────────────────────────────────────── */}
        <div className="flex-1 flex flex-col min-w-0 relative" style={{ zIndex: 1 }}>

        {/* Top bar — 70px */}
        <header
          className="h-[70px] flex items-center justify-between px-8 flex-shrink-0 axis-glass-strong relative"
          style={{ borderBottom: '1px solid var(--axis-glass-border)' }}
        >
          {/* Bottom edge baby-blue glow */}
          <div
            className="absolute left-0 right-0 bottom-0 h-px pointer-events-none"
            style={{
              background:
                'linear-gradient(90deg, rgba(127,201,244,0) 0%, rgba(127,201,244,0.55) 50%, rgba(127,201,244,0) 100%)',
            }}
          />

          {/* Search bar — pill shape with axis sheen */}
          <div className="relative w-[320px]">
            <svg className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <input
              type="text"
              placeholder="Search projects, permits, materials…"
              className="w-full rounded-full pl-10 pr-5 py-2.5 text-sm text-slate-700 placeholder-slate-400 focus:outline-none transition-all"
              style={{
                background: 'linear-gradient(180deg, #FFFFFF 0%, #F4F8FC 100%)',
                border: '1px solid rgba(127,201,244,0.35)',
                boxShadow: 'inset 0 1px 1px rgba(255,255,255,0.9), 0 0 0 1px rgba(127,201,244,0.10)',
              }}
            />
          </div>

          <div className="flex items-center gap-3">
            {/* Precision Mode toggle */}
            <PrecisionToggle />

            {/* Notification bell */}
            <button
              className="relative w-10 h-10 flex items-center justify-center rounded-full text-slate-500 hover:text-slate-800 transition-all"
              style={{
                background: 'linear-gradient(180deg, #FFFFFF 0%, #F1F5F9 100%)',
                border: '1px solid rgba(127,201,244,0.30)',
                boxShadow: '0 1px 2px rgba(15,23,42,0.06)',
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/>
              </svg>
              <span
                className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full"
                style={{ background: '#4FB0EA', boxShadow: '0 0 6px rgba(127,201,244,0.85)', border: '2px solid white' }}
              />
            </button>

            {/* Avatar */}
            <div
              className="w-10 h-10 rounded-full flex items-center justify-center text-xs font-bold cursor-pointer"
              style={{
                background: 'linear-gradient(180deg, #1B2433 0%, #06090E 100%)',
                border: '1px solid rgba(127,201,244,0.55)',
                boxShadow: '0 0 0 1px rgba(127,201,244,0.20), 0 0 10px rgba(127,201,244,0.30)',
                color: '#BFE6FF',
              }}
            >
              {initials}
            </div>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto">
          {children}
        </main>
        </div>
      </div>
    </div>
  )
}
