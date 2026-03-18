'use client'
import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import { getUser, signOut } from '@/lib/auth'

const NAV = [
  { href: '/dashboard',        label: 'Dashboard',       icon: IconDashboard },
  { href: '/projects',         label: 'Projects',        icon: IconProjects },
  { href: '/projects/new',     label: 'Upload Blueprint', icon: IconUpload },
  { href: '/reports',          label: 'Reports',         icon: IconReports },
  { href: '/permits',          label: 'Permits',         icon: IconPermits },
  { href: '/settings',         label: 'Settings',        icon: IconSettings },
]

function IconDashboard({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={active ? '#60a5fa' : '#64748b'} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
      <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
    </svg>
  )
}
function IconProjects({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={active ? '#60a5fa' : '#64748b'} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>
    </svg>
  )
}
function IconUpload({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={active ? '#60a5fa' : '#64748b'} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
    </svg>
  )
}
function IconReports({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={active ? '#60a5fa' : '#64748b'} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>
      <line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/>
    </svg>
  )
}
function IconPermits({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={active ? '#60a5fa' : '#64748b'} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="4" width="16" height="16" rx="2"/>
      <path d="M9 12l2 2 4-4"/>
    </svg>
  )
}
function IconSettings({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={active ? '#60a5fa' : '#64748b'} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
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

  useEffect(() => {
    getUser().then(u => {
      if (!u) router.push('/login')
      else setUser(u)
    })
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
    <div className="flex h-screen bg-[#080f1a] font-sans overflow-hidden">

      {/* ── SIDEBAR ──────────────────────────────────────────────────────── */}
      <aside className="w-60 flex-shrink-0 flex flex-col bg-[#0b1626] border-r border-[#1a2a3a]">

        {/* Logo */}
        <div className="flex items-center gap-2.5 px-5 py-5 border-b border-[#1a2a3a]">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center flex-shrink-0">
            <svg width="16" height="16" viewBox="0 0 28 28" fill="none">
              <rect x="2" y="2" width="24" height="24" rx="3" stroke="white" strokeWidth="1.5"/>
              <line x1="7" y1="8" x2="21" y2="8" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
              <line x1="7" y1="13" x2="17" y2="13" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
              <line x1="7" y1="18" x2="14" y2="18" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </div>
          <div>
            <div className="text-white font-bold text-sm leading-none">Axis</div>
            <div className="text-[#4a6a8a] text-[10px] font-medium tracking-wider uppercase leading-none mt-0.5">Performance</div>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || (href !== '/dashboard' && pathname.startsWith(href) && href !== '/projects/new')
            return (
              <Link
                key={href}
                href={href}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-150 group ${
                  active
                    ? 'bg-blue-600/15 text-blue-400 border border-blue-500/20'
                    : 'text-[#64748b] hover:text-white hover:bg-white/5'
                }`}
              >
                <Icon active={active} />
                {label}
                {active && <div className="ml-auto w-1.5 h-1.5 rounded-full bg-blue-400" />}
              </Link>
            )
          })}
        </nav>

        {/* User + plan */}
        <div className="border-t border-[#1a2a3a] p-3 space-y-2">
          <div className="flex items-center gap-3 px-2 py-2">
            <div className="w-8 h-8 rounded-lg bg-blue-600/20 border border-blue-500/30 flex items-center justify-center text-blue-400 text-xs font-bold flex-shrink-0">
              {initials}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-white text-xs font-semibold truncate">
                {user?.user_metadata?.full_name || 'Contractor'}
              </div>
              <div className="text-[#4a6a8a] text-[10px] truncate">{user?.email}</div>
            </div>
          </div>
          <div className="flex items-center justify-between px-2 py-1.5 bg-blue-600/10 border border-blue-500/20 rounded-lg">
            <span className="text-blue-400 text-[10px] font-semibold uppercase tracking-wider">Pro Plan</span>
            <div className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
          </div>
          <button
            onClick={handleSignOut}
            disabled={signingOut}
            className="w-full text-left text-xs text-[#4a6a8a] hover:text-white transition-colors px-2 py-1"
          >
            {signingOut ? 'Signing out...' : 'Sign out'}
          </button>
        </div>
      </aside>

      {/* ── MAIN AREA ─────────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0">

        {/* Top nav */}
        <header className="h-14 flex items-center justify-between px-6 bg-[#0b1626] border-b border-[#1a2a3a] flex-shrink-0">
          <div className="relative w-72">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-[#4a6a8a]" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <input
              type="text"
              placeholder="Search projects…"
              className="w-full bg-[#0f1e30] border border-[#1a2a3a] rounded-lg pl-9 pr-4 py-2 text-sm text-white placeholder-[#4a6a8a] focus:outline-none focus:border-blue-500/50 focus:bg-[#111f32] transition-all"
            />
          </div>

          <div className="flex items-center gap-3">
            {/* Notifications */}
            <button className="relative w-8 h-8 flex items-center justify-center rounded-lg text-[#4a6a8a] hover:text-white hover:bg-white/5 transition-all">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/>
              </svg>
              <span className="absolute top-1 right-1 w-2 h-2 bg-blue-500 rounded-full border-2 border-[#0b1626]" />
            </button>

            {/* Avatar */}
            <div className="w-8 h-8 rounded-lg bg-blue-600/20 border border-blue-500/30 flex items-center justify-center text-blue-400 text-xs font-bold cursor-pointer">
              {initials}
            </div>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto bg-[#080f1a]">
          {children}
        </main>
      </div>
    </div>
  )
}
