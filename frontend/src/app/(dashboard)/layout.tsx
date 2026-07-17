'use client'
import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import { getUser, signOut } from '@/lib/auth'
import { PrecisionToggle } from '@/components/axis'
import { ChatContextProvider } from '@/lib/chat-context'
import AxisChat from '@/components/AxisChat'
import GlobalSearch from '@/components/GlobalSearch'
import NotificationBell from '@/components/NotificationBell'
import BusinessProfileBanner from '@/components/BusinessProfileBanner'

const API_BASE = (process.env.NEXT_PUBLIC_API_URL || 'https://build-backend-jcp9.onrender.com').trim()

const NAV_GROUPS: { title: string; items: { href: string; label: string; icon: (p: { active: boolean }) => React.ReactNode }[] }[] = [
  {
    title: 'Workspace',
    items: [
      { href: '/dashboard',    label: 'Dashboard',        icon: IconDashboard },
      { href: '/projects',     label: 'Projects',         icon: IconProjects },
      // Blueprint upload hidden — Axis is roofing-first (roofers measure roofs,
      // not architectural PDFs). Route + code kept; restore this line to re-enable.
      // { href: '/projects/new', label: 'Upload Blueprint', icon: IconUpload },
    ],
  },
  {
    title: 'Tools',
    items: [
      { href: '/roof-v2',         label: 'Roof Report',         icon: IconAerial },
      // Exterior Measurement Module hidden until it's past MVP — kept routable.
      // { href: '/exterior',     label: 'Exterior Module',     icon: IconAerial },
      { href: '/material-check',  label: 'Material Compliance', icon: IconMaterialCheck },
      { href: '/home-visualizer', label: 'Roof Visualizer',     icon: IconVisualizer },
      { href: '/storm-report',    label: 'Storm Risk Report',   icon: IconStorm },
      // Training Data retired as a user task — edge labels/corrections are now
      // captured silently as contractors work (see put_edges training capture).
      // { href: '/training-data',   label: 'Training Data',       icon: IconReports },
    ],
  },
  {
    title: 'Business',
    items: [
      { href: '/crm',      label: 'CRM',      icon: IconCRM },
      { href: '/schedule', label: 'Schedule', icon: IconSchedule },
      { href: '/reports',  label: 'Reports',  icon: IconReports },
      { href: '/permits',  label: 'Permits',  icon: IconPermits },
    ],
  },
]

// Flat lookup for deriving the current page title in the top bar.
const ALL_NAV = [...NAV_GROUPS.flatMap(g => g.items), { href: '/settings', label: 'Settings', icon: IconSettings }]
function titleFor(pathname: string): string {
  const hit = ALL_NAV
    .filter(n => pathname === n.href || (n.href !== '/dashboard' && pathname.startsWith(n.href)))
    .sort((a, b) => b.href.length - a.href.length)[0]
  return hit?.label || 'Dashboard'
}

function IconDashboard({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={active ? '#bfe6ff' : '#94a3b8'} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
      <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
    </svg>
  )
}
function IconProjects({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={active ? '#bfe6ff' : '#94a3b8'} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>
    </svg>
  )
}
function IconUpload({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={active ? '#bfe6ff' : '#94a3b8'} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
    </svg>
  )
}
function IconReports({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={active ? '#bfe6ff' : '#94a3b8'} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>
      <line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/>
    </svg>
  )
}
function IconPermits({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={active ? '#bfe6ff' : '#94a3b8'} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="4" width="16" height="16" rx="2"/>
      <path d="M9 12l2 2 4-4"/>
    </svg>
  )
}
function IconSettings({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={active ? '#bfe6ff' : '#94a3b8'} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/>
    </svg>
  )
}

function IconMaterialCheck({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={active ? '#bfe6ff' : '#94a3b8'} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>
    </svg>
  )
}

function IconVisualizer({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={active ? '#bfe6ff' : '#94a3b8'} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="14" rx="2"/>
      <path d="M3 9l4-4 4 4 4-4 4 4"/>
      <path d="M8 21h8M12 17v4"/>
    </svg>
  )
}

function IconAerial({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={active ? '#bfe6ff' : '#94a3b8'} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>
      <polyline points="9 22 9 12 15 12 15 22"/>
    </svg>
  )
}

function IconStorm({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={active ? '#bfe6ff' : '#94a3b8'} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 16.9A5 5 0 0018 7h-1.26A8 8 0 104 15.3"/>
      <polyline points="13 11 9 17 15 17 11 23"/>
    </svg>
  )
}

function IconCRM({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={active ? '#bfe6ff' : '#94a3b8'} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/>
      <circle cx="9" cy="7" r="4"/>
      <path d="M23 21v-2a4 4 0 00-3-3.87"/>
      <path d="M16 3.13a4 4 0 010 7.75"/>
    </svg>
  )
}

function IconSchedule({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={active ? '#bfe6ff' : '#94a3b8'} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2"/>
      <path d="M16 2v4M8 2v4M3 10h18"/>
      <path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/>
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
  const [collapsed, setCollapsed] = useState(false)

  // Restore the sidebar collapsed preference.
  useEffect(() => {
    try { setCollapsed(localStorage.getItem('axis_sidebar_collapsed') === '1') } catch {}
  }, [])
  function toggleCollapsed() {
    setCollapsed(c => {
      const n = !c
      try { localStorage.setItem('axis_sidebar_collapsed', n ? '1' : '0') } catch {}
      return n
    })
  }

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
    <ChatContextProvider>
    <div className="flex flex-col h-screen overflow-hidden font-sans axis-bench">

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

      {/* ── SIDEBAR ──────────────────────────────────────────────────────── */}
      <aside
        className={`relative flex-shrink-0 flex flex-col transition-[width] duration-200 ${collapsed ? 'w-[76px]' : 'w-64'}`}
        style={{ zIndex: 10, background: 'rgba(7,11,19,0.92)', backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)' }}
      >
        {/* Soft blue glow line on the right edge */}
        <div className="absolute top-0 bottom-0 right-0 w-px pointer-events-none"
          style={{ background: 'linear-gradient(180deg, rgba(96,165,250,0) 0%, rgba(96,165,250,0.5) 30%, rgba(96,165,250,0.5) 70%, rgba(96,165,250,0) 100%)' }} />

        {/* Collapse toggle — floating on the edge */}
        <button
          onClick={toggleCollapsed}
          title={collapsed ? 'Expand' : 'Collapse'}
          className="absolute -right-3 top-7 z-20 w-6 h-6 rounded-full flex items-center justify-center text-slate-300 hover:text-white transition-colors"
          style={{ background: 'rgba(15,23,42,0.95)', border: '1px solid rgba(96,165,250,0.4)', boxShadow: '0 0 10px rgba(59,130,246,0.3)' }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ transform: collapsed ? 'rotate(180deg)' : 'none' }}>
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>

        {/* Logo */}
        <div className={`flex items-center gap-2.5 h-20 border-b ${collapsed ? 'justify-center' : 'px-5'}`} style={{ borderColor: 'rgba(96,165,250,0.14)' }}>
          <div className="relative w-11 h-11 rounded-2xl flex items-center justify-center flex-shrink-0"
            style={{ background: 'linear-gradient(180deg, #1B2433 0%, #06090E 100%)', border: '1px solid rgba(127,201,244,0.45)', boxShadow: '0 0 0 1px rgba(127,201,244,0.20), 0 4px 12px -4px rgba(127,201,244,0.45)' }}>
            <svg width="20" height="20" viewBox="0 0 28 28" fill="none">
              <path d="M14 4 L24 24 H19 L17 19 H11 L9 24 H4 Z" fill="#BFE6FF" />
              <path d="M12.5 15 H15.5 L14 11 Z" fill="#06090E" />
            </svg>
          </div>
          {!collapsed && (
            <div className="leading-none">
              <div className="text-[14px] font-black tracking-tight text-white">AXIS</div>
              <div className="text-[9px] font-bold tracking-[0.3em] text-blue-300/70 mt-0.5">PERFORMANCE</div>
            </div>
          )}
        </div>

        {/* Navigation — grouped */}
        <nav className="flex-1 px-3 py-4 overflow-y-auto overflow-x-hidden">
          {NAV_GROUPS.map(group => (
            <div key={group.title} className="mb-4">
              {!collapsed && (
                <div className="px-3 mb-1.5 text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500">{group.title}</div>
              )}
              <div className="space-y-1">
                {group.items.map(({ href, label, icon: Icon }) => {
                  const active = pathname === href || (href !== '/dashboard' && pathname.startsWith(href) && href !== '/projects/new')
                  return (
                    <Link
                      key={href}
                      href={href}
                      title={collapsed ? label : undefined}
                      className={`relative flex items-center gap-3 rounded-xl text-sm font-semibold transition-all duration-200 ${collapsed ? 'justify-center px-0 py-2.5' : 'px-3.5 py-2.5'} ${active ? 'text-white' : 'text-slate-400 hover:text-white hover:bg-white/[0.04]'}`}
                      style={active ? {
                        background: 'linear-gradient(90deg, rgba(59,130,246,0.22) 0%, rgba(59,130,246,0.08) 100%)',
                        boxShadow: '0 0 0 1px rgba(96,165,250,0.35), 0 0 16px rgba(59,130,246,0.22)',
                      } : {}}
                    >
                      <Icon active={active} />
                      {!collapsed && <span className="truncate">{label}</span>}
                    </Link>
                  )
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* Footer — account + precision + sign out */}
        <div className="border-t p-3" style={{ borderColor: 'rgba(96,165,250,0.14)' }}>
          {!collapsed && (
            <div className="px-1 pb-3">
              <PrecisionToggle />
            </div>
          )}
          <div className={`flex items-center gap-3 ${collapsed ? 'justify-center' : ''}`}>
            <Link
              href="/settings"
              title="Account settings"
              className="w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
              style={{ background: 'linear-gradient(180deg, #1B2433 0%, #06090E 100%)', border: '1px solid rgba(127,201,244,0.55)', boxShadow: '0 0 0 1px rgba(127,201,244,0.20), 0 0 10px rgba(127,201,244,0.30)', color: '#BFE6FF' }}
            >
              {initials}
            </Link>
            {!collapsed && (
              <div className="flex-1 min-w-0">
                <div className="text-slate-200 text-xs font-semibold truncate">{user?.user_metadata?.full_name || 'Contractor'}</div>
                <button onClick={handleSignOut} disabled={signingOut} className="text-slate-500 hover:text-slate-300 text-[11px] transition-colors">
                  {signingOut ? 'Signing out…' : 'Sign out'}
                </button>
              </div>
            )}
          </div>
        </div>
      </aside>

        {/* ── MAIN AREA ─────────────────────────────────────────────────────── */}
        <div className="flex-1 flex flex-col min-w-0 relative" style={{ zIndex: 1 }}>

        {/* Top bar — 70px */}
        <header
          className="h-[70px] flex items-center justify-between gap-6 px-7 flex-shrink-0 relative"
          style={{ background: 'rgba(7,11,19,0.85)', backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)' }}
        >
          {/* Bottom edge blue glow */}
          <div className="absolute left-0 right-0 bottom-0 h-px pointer-events-none"
            style={{ background: 'linear-gradient(90deg, rgba(96,165,250,0) 0%, rgba(96,165,250,0.5) 50%, rgba(96,165,250,0) 100%)' }} />

          {/* Current page title */}
          <h1 className="text-lg font-semibold text-white flex-shrink-0">{titleFor(pathname)}</h1>

          {/* Working global search */}
          <div className="flex-1 flex justify-end max-w-[440px] ml-auto">
            <GlobalSearch />
          </div>

          {/* Notifications */}
          <NotificationBell />

          {/* Account */}
          <Link
            href="/settings"
            title="Account settings"
            className="w-10 h-10 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 transition-transform hover:scale-105"
            style={{
              background: 'linear-gradient(180deg, #1B2433 0%, #06090E 100%)',
              border: '1px solid rgba(127,201,244,0.55)',
              boxShadow: '0 0 0 1px rgba(127,201,244,0.20), 0 0 10px rgba(127,201,244,0.30)',
              color: '#BFE6FF',
            }}
          >
            {initials}
          </Link>
        </header>

        {/* Onboarding: brand everything from one profile */}
        {user?.id && <BusinessProfileBanner userId={user.id} />}

        {/* Page content */}
        <main className="flex-1 overflow-y-auto">
          {children}
        </main>
        </div>
      </div>

      {/* Floating AI assistant — sees the current page's context */}
      <AxisChat />
    </div>
    </ChatContextProvider>
  )
}
