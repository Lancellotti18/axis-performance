'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { getUser } from '@/lib/auth'
import { api } from '@/lib/api'
import type { Project } from '@/types'

function StatCard({
  label, value, sub, trend, trendUp, iconBg, icon,
}: {
  label: string
  value: string | number
  sub?: string
  trend?: string
  trendUp?: boolean
  iconBg: string
  icon: React.ReactNode
}) {
  return (
    <div
      className="rounded-[18px] bg-white p-5 flex flex-col gap-3 hover:shadow-md transition-all duration-200"
      style={{ boxShadow: '0 2px 12px rgba(59,130,246,0.08)', border: '1px solid rgba(219,234,254,0.8)' }}
    >
      <div className="flex items-start justify-between">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${iconBg}`}>
          {icon}
        </div>
        {trend && (
          <span className={`text-xs font-semibold flex items-center gap-0.5 ${trendUp ? 'text-emerald-500' : 'text-red-400'}`}>
            {trendUp ? '↑' : '↓'} {trend}
          </span>
        )}
      </div>
      <div>
        <div className="text-2xl font-black text-slate-800 leading-none mb-1">{value}</div>
        <div className="text-slate-400 text-sm">{label}</div>
        {sub && <div className="text-slate-300 text-xs mt-0.5">{sub}</div>}
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    complete:   'bg-emerald-50 text-emerald-600 border border-emerald-200',
    processing: 'bg-amber-50 text-amber-600 border border-amber-200',
    pending:    'bg-amber-50 text-amber-600 border border-amber-200',
    failed:     'bg-red-50 text-red-500 border border-red-200',
  }
  const labels: Record<string, string> = {
    complete: 'Complete', processing: 'Processing', pending: 'Processing', failed: 'Failed',
  }
  const dots: Record<string, string> = {
    complete: 'bg-emerald-500', processing: 'bg-amber-400 animate-pulse', pending: 'bg-amber-400 animate-pulse', failed: 'bg-red-400',
  }
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full ${styles[status] || 'bg-slate-100 text-slate-500 border border-slate-200'}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dots[status] || 'bg-slate-400'}`} />
      {labels[status] || status}
    </span>
  )
}

function ProjectCard({
  project,
  onDelete,
  onRename,
  onArchive,
}: {
  project: Project
  onDelete: (id: string) => void
  onRename: (id: string, name: string) => void
  onArchive: (id: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draftName, setDraftName] = useState(project.name)
  const [saving, setSaving] = useState(false)

  async function saveRename() {
    const trimmed = draftName.trim()
    if (!trimmed || trimmed === project.name) { setEditing(false); return }
    setSaving(true)
    try {
      await api.projects.rename(project.id, trimmed)
      onRename(project.id, trimmed)
    } catch {}
    setSaving(false)
    setEditing(false)
  }

  return (
    <div
      className="rounded-[20px] bg-white overflow-hidden group transition-all duration-200 hover:-translate-y-1 cursor-pointer relative"
      style={{
        boxShadow: '0 2px 12px rgba(59,130,246,0.08)',
        border: '1px solid rgba(219,234,254,0.8)',
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.boxShadow = '0 8px 32px rgba(59,130,246,0.16)' }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.boxShadow = '0 2px 12px rgba(59,130,246,0.08)' }}
    >
      {/* Blueprint thumbnail */}
      <div className="h-[100px] flex items-center justify-center relative overflow-hidden" style={{ background: 'linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%)' }}>
        {/* Action icons — top right */}
        <div className="absolute top-2 right-2 flex gap-1.5 opacity-0 group-hover:opacity-100 transition-all duration-150 z-10">
          <button
            onClick={e => { e.stopPropagation(); setEditing(true); setDraftName(project.name) }}
            className="w-7 h-7 rounded-lg bg-white/80 backdrop-blur-sm flex items-center justify-center hover:bg-white transition-all shadow-sm"
            title="Rename"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
          <button
            onClick={e => { e.stopPropagation(); onArchive(project.id) }}
            className="w-7 h-7 rounded-lg bg-white/80 backdrop-blur-sm flex items-center justify-center hover:bg-slate-100 transition-all shadow-sm"
            title="Move to Trash"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
            </svg>
          </button>
        </div>

        {/* Mini grid */}
        <svg className="absolute inset-0 w-full h-full opacity-20" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <pattern id={`g-${project.id}`} width="20" height="20" patternUnits="userSpaceOnUse">
              <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#2563eb" strokeWidth="0.5"/>
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill={`url(#g-${project.id})`} />
        </svg>
        {/* Blueprint icon */}
        <div className="relative z-10 w-12 h-12 rounded-xl bg-white/70 backdrop-blur-sm flex items-center justify-center shadow-sm">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>
            <line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="12" y2="17"/>
          </svg>
        </div>
      </div>

      {/* Card body */}
      <div className="p-4">
        <div className="flex items-start justify-between gap-2 mb-2">
          {editing ? (
            <input
              autoFocus
              value={draftName}
              onChange={e => setDraftName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') saveRename(); if (e.key === 'Escape') { setEditing(false); setDraftName(project.name) } }}
              onBlur={saveRename}
              disabled={saving}
              className="text-slate-800 font-semibold text-sm leading-tight border-b border-blue-400 outline-none bg-transparent flex-1 min-w-0"
            />
          ) : (
            <div className="text-slate-800 font-semibold text-sm leading-tight line-clamp-1">{project.name}</div>
          )}
          <StatusBadge status={project.status} />
        </div>
        {project.description && (
          <div className="text-slate-400 text-xs mb-3 line-clamp-1">{project.description}</div>
        )}

        {/* Bottom row */}
        <div className="flex items-center justify-between pt-2 border-t" style={{ borderColor: 'rgba(219,234,254,0.6)' }}>
          <div className="text-slate-400 text-xs">
            {new Date(project.updated_at || project.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
          </div>
          {/* Hover action buttons */}
          <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-all duration-200 translate-x-2 group-hover:translate-x-0">
            <Link
              href={`/projects/${project.id}`}
              className="text-xs text-blue-600 hover:text-blue-800 font-semibold px-2.5 py-1 rounded-lg bg-blue-50 hover:bg-blue-100 transition-all"
              onClick={e => e.stopPropagation()}
            >
              Open
            </Link>
            <Link
              href="/permits"
              className="text-xs text-slate-500 hover:text-slate-700 font-medium px-2.5 py-1 rounded-lg bg-slate-50 hover:bg-slate-100 transition-all"
              onClick={e => e.stopPropagation()}
            >
              Submit
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function DashboardPage() {
  const router = useRouter()
  const [user, setUser] = useState<any>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [archivedProjects, setArchivedProjects] = useState<Project[]>([])
  const [showTrash, setShowTrash] = useState(false)
  const [loading, setLoading] = useState(true)
  const [fabOpen, setFabOpen] = useState(false)

  useEffect(() => {
    async function load() {
      const u = await getUser()
      if (!u) { router.push('/login'); return }
      setUser(u)
      setLoading(false)
      try {
        const allData = await api.projects.listArchived(u.id)
        const activeProjects = (allData || []).filter((p: any) => !p.archived)
        const archived = (allData || []).filter((p: any) => p.archived)
        setProjects(activeProjects)
        setArchivedProjects(archived)
      } catch {}
    }
    load()
  }, [router])

  async function handleDelete(id: string) {
    try {
      await api.projects.delete(id)
    } catch {}
    setProjects(prev => prev.filter(p => p.id !== id))
    setArchivedProjects(prev => prev.filter(p => p.id !== id))
  }

  function handleRename(id: string, newName: string) {
    setProjects(prev => prev.map(p => p.id === id ? { ...p, name: newName } : p))
  }

  async function handleArchive(id: string) {
    try {
      await api.projects.archive(id)
      const proj = projects.find(p => p.id === id)
      if (proj) setArchivedProjects(prev => [{ ...proj, archived: true } as any, ...prev])
      setProjects(prev => prev.filter(p => p.id !== id))
    } catch {}
  }

  async function handleRestore(id: string) {
    try {
      await api.projects.restore(id)
      const proj = archivedProjects.find(p => p.id === id)
      if (proj) setProjects(prev => [{ ...proj, archived: false } as any, ...prev])
      setArchivedProjects(prev => prev.filter(p => p.id !== id))
    } catch {}
  }

  const complete = projects.filter(p => p.status === 'complete').length
  const processing = projects.filter(p => p.status === 'processing' || p.status === 'pending').length
  const pendingPermits = 0
  const recent = projects.slice(0, 6)
  const name = user?.user_metadata?.full_name?.split(' ')[0] || 'there'

  return (
    <div className="p-8 max-w-7xl mx-auto animate-[fadeIn_0.3s_ease]" style={{ animationFillMode: 'both' }}>
      <style>{`
        @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>

      {/* ── HERO STRIP ──────────────────────────────────────────────── */}
      <div
        className="rounded-[20px] px-8 py-6 flex items-center justify-between mb-8 relative overflow-hidden"
        style={{
          background: 'linear-gradient(135deg, #dbeafe 0%, #bfdbfe 100%)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.6), 0 4px 24px rgba(59,130,246,0.12)',
          minHeight: 120,
        }}
      >
        {/* Inner glow */}
        <div className="absolute top-0 left-0 w-48 h-48 rounded-full opacity-30 pointer-events-none" style={{ background: 'radial-gradient(circle, #93c5fd, transparent)', transform: 'translate(-30%, -40%)' }} />
        <div>
          <h1 className="text-2xl font-black text-slate-800 leading-tight">Welcome back, {name}</h1>
          <p className="text-blue-600/80 text-sm mt-1 font-medium">
            {pendingPermits > 0
              ? `You have ${pendingPermits} permit${pendingPermits > 1 ? 's' : ''} ready for submission`
              : projects.length === 0
              ? 'Upload your first blueprint to get started'
              : `${complete} project${complete !== 1 ? 's' : ''} complete · ${processing} in progress`}
          </p>
        </div>
        <Link
          href="/projects/new"
          className="flex items-center gap-2 bg-white text-blue-600 font-bold px-5 py-2.5 rounded-full text-sm transition-all duration-200 hover:scale-[1.03] flex-shrink-0"
          style={{ boxShadow: '0 2px 12px rgba(59,130,246,0.18)' }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Upload Blueprint
        </Link>
      </div>

      {/* ── STATS ROW ───────────────────────────────────────────────── */}
      <div className="grid grid-cols-4 gap-5 mb-8">
        <StatCard
          label="Active Projects" value={projects.length}
          sub={`${complete} complete`}
          trend="12%" trendUp
          iconBg="bg-blue-50 text-blue-500"
          icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>}
        />
        <StatCard
          label="Pending Permits" value={pendingPermits}
          sub="No submissions yet"
          iconBg="bg-amber-50 text-amber-500"
          icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 12l2 2 4-4"/></svg>}
        />
        <StatCard
          label="Issues Detected" value={0}
          sub="Across all projects"
          iconBg="bg-red-50 text-red-400"
          icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>}
        />
        <StatCard
          label="Total Project Value" value="—"
          sub="Awaiting analysis"
          iconBg="bg-emerald-50 text-emerald-500"
          icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>}
        />
      </div>

      {/* ── PROJECTS SECTION ────────────────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-black text-slate-800">Your Projects</h2>
          <Link href="/projects" className="text-blue-500 hover:text-blue-700 text-sm font-semibold transition-colors">
            View All →
          </Link>
        </div>

        {loading ? (
          <div className="grid grid-cols-3 gap-5">
            {[1,2,3].map(i => (
              <div key={i} className="h-[220px] rounded-[20px] bg-white animate-pulse" style={{ border: '1px solid rgba(219,234,254,0.8)' }} />
            ))}
          </div>
        ) : recent.length === 0 ? (
          <div
            className="rounded-[20px] bg-white py-16 flex flex-col items-center justify-center text-center"
            style={{ boxShadow: '0 2px 12px rgba(59,130,246,0.08)', border: '1px solid rgba(219,234,254,0.8)' }}
          >
            <div className="w-16 h-16 rounded-2xl bg-blue-50 flex items-center justify-center mb-4">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>
              </svg>
            </div>
            <div className="text-slate-800 font-bold text-base mb-1">No projects yet</div>
            <div className="text-slate-400 text-sm mb-5">Upload your first blueprint to get started</div>
            <Link
              href="/projects/new"
              className="bg-blue-600 hover:bg-blue-500 text-white font-semibold px-6 py-2.5 rounded-full text-sm transition-all hover:scale-[1.03]"
              style={{ boxShadow: '0 4px 14px rgba(59,130,246,0.3)' }}
            >
              Upload Blueprint
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-5">
            {recent.map(p => <ProjectCard key={p.id} project={p} onDelete={handleDelete} onRename={handleRename} onArchive={handleArchive} />)}
          </div>
        )}
      </div>

      {/* Trash section */}
      {archivedProjects.length > 0 && (
        <div className="mt-10">
          <button
            onClick={() => setShowTrash(o => !o)}
            className="flex items-center gap-2 text-slate-400 hover:text-slate-600 text-sm font-semibold transition-colors mb-4"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
            </svg>
            Trash ({archivedProjects.length})
            <span className="ml-1">{showTrash ? '↑' : '↓'}</span>
          </button>
          {showTrash && (
            <div className="grid grid-cols-3 gap-5 opacity-60">
              {archivedProjects.map(p => (
                <div key={p.id} className="rounded-[20px] bg-white p-4 relative" style={{ boxShadow: '0 2px 12px rgba(0,0,0,0.06)', border: '1px solid rgba(203,213,225,0.8)' }}>
                  <div className="text-slate-600 font-semibold text-sm mb-1 line-clamp-1">{p.name}</div>
                  <div className="text-slate-400 text-xs mb-3">{new Date(p.updated_at || p.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleRestore(p.id)}
                      className="flex-1 text-xs font-semibold text-blue-600 bg-blue-50 hover:bg-blue-100 py-1.5 rounded-lg transition-all"
                    >
                      Restore
                    </button>
                    <button
                      onClick={() => handleDelete(p.id)}
                      className="flex-1 text-xs font-semibold text-red-500 bg-red-50 hover:bg-red-100 py-1.5 rounded-lg transition-all"
                    >
                      Delete Forever
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── FLOATING ACTION BUTTON ──────────────────────────────────── */}
      <div className="fixed bottom-8 right-8 flex flex-col items-end gap-3" style={{ zIndex: 50 }}>
        {fabOpen && (
          <div className="flex flex-col items-end gap-2 animate-[fadeIn_0.2s_ease]">
            {[
              { href: '/projects/new', label: 'Upload Blueprint', icon: '📤' },
              { href: '/reports',      label: 'Generate Report',  icon: '📊' },
              { href: '/permits',      label: 'Submit Permit',    icon: '📑' },
            ].map(a => (
              <Link
                key={a.href}
                href={a.href}
                onClick={() => setFabOpen(false)}
                className="flex items-center gap-2.5 bg-white text-slate-700 font-semibold text-sm px-4 py-2.5 rounded-full shadow-lg hover:shadow-xl hover:scale-[1.03] transition-all duration-150"
                style={{ border: '1px solid rgba(219,234,254,0.9)' }}
              >
                <span>{a.icon}</span>
                {a.label}
              </Link>
            ))}
          </div>
        )}
        <button
          onClick={() => setFabOpen(o => !o)}
          className="w-14 h-14 rounded-full text-white font-bold text-2xl flex items-center justify-center transition-all duration-200 hover:scale-110"
          style={{
            background: 'linear-gradient(135deg, #3b82f6, #1d4ed8)',
            boxShadow: '0 6px 24px rgba(59,130,246,0.4)',
            transform: fabOpen ? 'rotate(45deg)' : 'rotate(0deg)',
          }}
        >
          +
        </button>
      </div>
    </div>
  )
}
