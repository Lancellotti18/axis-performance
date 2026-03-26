'use client'
import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import { getUser, signOut } from '@/lib/auth'

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

const NAV = [
  { href: '/dashboard',    label: 'Dashboard',       icon: IconDashboard },
  { href: '/projects',     label: 'Projects',        icon: IconProjects },
  { href: '/projects/new', label: 'Upload Blueprint', icon: IconUpload },
  { href: '/reports',      label: 'Reports',         icon: IconReports },
  { href: '/permits',      label: 'Permits',         icon: IconPermits },
  { href: '/settings',     label: 'Settings',        icon: IconSettings },
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

    fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(90000) })
      .then(() => {
        clearTimeout(bannerTimer)
        clearInterval(countInterval)
        setServerWaking(false)
      })
      .catch(() => {
        clearTimeout(bannerTimer)
        clearInterval(countInterval)
        setServerWaking(false)
      })

    return () => { clearTimeout(bannerTimer); clearInterval(countInterval) }
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
    <div className="flex flex-col h-screen overflow-hidden font-sans" style={{ background: 'linear-gradient(135deg, #eef6ff 0%, #ffffff 100%)' }}>

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

      {/* Blueprint grid overlay */}
      <div className="fixed inset-0 pointer-events-none" style={{ zIndex: 0 }}>
        <svg width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#3b82f6" strokeWidth="0.5" strokeOpacity="0.07"/>
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#grid)" />
        </svg>
      </div>

      {/* ── SIDEBAR ──────────────────────────────────────────────────────── */}
      <aside
        className="w-60 flex-shrink-0 flex flex-col border-r relative"
        style={{
          zIndex: 10,
          background: 'rgba(255,255,255,0.78)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          borderColor: 'rgba(219,234,254,0.9)',
        }}
      >
        {/* Logo — icon only, 80px */}
        <div className="flex items-center justify-center h-20 border-b" style={{ borderColor: 'rgba(219,234,254,0.8)' }}>
          <div className="w-11 h-11 rounded-2xl flex items-center justify-center shadow-sm" style={{ background: 'linear-gradient(135deg, #2563eb, #1d4ed8)' }}>
            <svg width="22" height="22" viewBox="0 0 28 28" fill="none">
              <rect x="2" y="2" width="24" height="24" rx="3" stroke="white" strokeWidth="1.5"/>
              <line x1="7" y1="8" x2="21" y2="8" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
              <line x1="7" y1="13" x2="17" y2="13" stroke="white" strokeWidth="1.2" strokeLinecap="round" strokeOpacity="0.8"/>
              <line x1="7" y1="18" x2="14" y2="18" stroke="white" strokeWidth="1.2" strokeLinecap="round" strokeOpacity="0.6"/>
            </svg>
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
                className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all duration-200 group relative ${
                  active
                    ? 'text-blue-700'
                    : 'text-slate-500 hover:text-slate-800 hover:bg-blue-50/60'
                }`}
                style={active ? {
                  background: '#dbeafe',
                  borderLeft: '3px solid #2563eb',
                } : {}}
              >
                <Icon active={active} />
                {label}
              </Link>
            )
          })}
        </nav>

        {/* Profile + Pro Plan */}
        <div className="border-t p-4 space-y-3" style={{ borderColor: 'rgba(219,234,254,0.8)' }}>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center text-white text-xs font-bold flex-shrink-0 shadow-sm">
              {initials}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-slate-800 text-xs font-semibold truncate">
                {user?.user_metadata?.full_name || 'Contractor'}
              </div>
              <div className="text-slate-400 text-[10px] truncate">{user?.email}</div>
            </div>
          </div>
          <div className="flex items-center justify-between px-3 py-2 rounded-xl" style={{ background: 'rgba(219,234,254,0.6)' }}>
            <span className="text-blue-600 text-[11px] font-semibold tracking-wide">Pro Plan</span>
            <div className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
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
          className="h-[70px] flex items-center justify-between px-8 flex-shrink-0 border-b"
          style={{
            background: 'rgba(255,255,255,0.82)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            borderColor: 'rgba(219,234,254,0.8)',
          }}
        >
          {/* Search bar — pill shape */}
          <div className="relative w-[300px]">
            <svg className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <input
              type="text"
              placeholder="Search projects…"
              className="w-full rounded-full pl-10 pr-5 py-2.5 text-sm text-slate-700 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-200 transition-all"
              style={{ background: '#f1f5f9', border: '1px solid rgba(203,213,225,0.8)' }}
            />
          </div>

          <div className="flex items-center gap-3">
            {/* Notification bell */}
            <button className="relative w-10 h-10 flex items-center justify-center rounded-full text-slate-500 hover:text-blue-600 hover:bg-blue-50 transition-all">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/>
              </svg>
              <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-blue-500 rounded-full border-2 border-white" />
            </button>

            {/* Avatar */}
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center text-white text-xs font-bold cursor-pointer shadow-sm">
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
