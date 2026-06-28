'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { getUser } from '@/lib/auth'
import { api } from '@/lib/api'
import type { Project } from '@/types'

// ── helpers ──────────────────────────────────────────────────────────────────
function relTime(s?: string): string {
  if (!s) return ''
  const d = new Date(s)
  const diff = (Date.now() - d.getTime()) / 1000
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function StatusBadge({ status }: { status: string }) {
  // Electric-blue-only palette: blue for active/complete, muted rose only for errors.
  const map: Record<string, { cls: string; dot: string; label: string }> = {
    complete:   { cls: 'bg-blue-500/15 text-blue-200 border-blue-400/30', dot: 'bg-blue-400', label: 'Complete' },
    processing: { cls: 'bg-white/[0.05] text-slate-300 border-white/10', dot: 'bg-blue-400 animate-pulse', label: 'In progress' },
    pending:    { cls: 'bg-white/[0.05] text-slate-300 border-white/10', dot: 'bg-blue-400 animate-pulse', label: 'In progress' },
    failed:     { cls: 'bg-rose-500/15 text-rose-300 border-rose-400/30', dot: 'bg-rose-400', label: 'Failed' },
  }
  const s = map[status] || { cls: 'bg-white/[0.05] text-slate-400 border-white/10', dot: 'bg-slate-500', label: status }
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-full border ${s.cls}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  )
}

function ThumbPlaceholder({ id }: { id: string }) {
  // Slick dark blueprint placeholder for projects with no satellite tile yet.
  return (
    <div className="absolute inset-0 flex items-center justify-center" style={{ background: 'linear-gradient(135deg, #0a1322 0%, #060b16 100%)' }}>
      <svg className="absolute inset-0 w-full h-full opacity-[0.18]" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <pattern id={`bp-${id}`} width="22" height="22" patternUnits="userSpaceOnUse">
            <path d="M 22 0 L 0 0 0 22" fill="none" stroke="#3b82f6" strokeWidth="0.5" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill={`url(#bp-${id})`} />
      </svg>
      <div className="relative z-10 w-11 h-11 rounded-xl flex items-center justify-center" style={{ background: 'rgba(59,130,246,0.12)', border: '1px solid rgba(96,165,250,0.25)' }}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 11l9-8 9 8" /><path d="M5 10v10h14V10" /><path d="M9 21v-6h6v6" />
        </svg>
      </div>
    </div>
  )
}

function ProjectCard({
  project, onRename, onArchive,
}: {
  project: Project
  onRename: (id: string, name: string) => void
  onArchive: (id: string) => void
}) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [draftName, setDraftName] = useState(project.name)
  const [saving, setSaving] = useState(false)
  const [imgOk, setImgOk] = useState(!!project.thumbnail_url)

  const address = [project.address, project.city, project.zip_code].filter(Boolean).join(', ')

  async function saveRename() {
    const trimmed = draftName.trim()
    if (!trimmed || trimmed === project.name) { setEditing(false); return }
    setSaving(true)
    try { await api.projects.rename(project.id, trimmed); onRename(project.id, trimmed) } catch {}
    setSaving(false); setEditing(false)
  }

  return (
    <div
      onClick={() => router.push(`/projects/${project.id}`)}
      className="group relative cursor-pointer rounded-2xl overflow-hidden border border-white/10 bg-white/[0.04] backdrop-blur-sm transition-all duration-200 hover:-translate-y-1 hover:border-blue-400/40 hover:shadow-[0_14px_44px_rgba(59,130,246,0.22)]"
    >
      {/* Thumbnail */}
      <div className="relative aspect-[16/10] overflow-hidden">
        {imgOk && project.thumbnail_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={project.thumbnail_url}
            alt={project.name}
            loading="lazy"
            onError={() => setImgOk(false)}
            className="h-full w-full object-cover transition-transform duration-300"
          />
        ) : (
          <ThumbPlaceholder id={project.id} />
        )}
        {/* top edge sheen */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-white/15" />

        {/* hover actions */}
        <div className="absolute top-2 right-2 flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity duration-150 z-10">
          <button
            onClick={e => { e.stopPropagation(); setEditing(true); setDraftName(project.name) }}
            className="w-7 h-7 rounded-lg bg-slate-900/70 backdrop-blur-sm flex items-center justify-center text-slate-200 hover:bg-slate-900 hover:text-white transition-colors border border-white/10"
            title="Rename"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
          </button>
          <button
            onClick={e => { e.stopPropagation(); onArchive(project.id) }}
            className="w-7 h-7 rounded-lg bg-slate-900/70 backdrop-blur-sm flex items-center justify-center text-slate-400 hover:bg-slate-900 hover:text-rose-300 transition-colors border border-white/10"
            title="Move to Trash"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" /><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" /></svg>
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="p-4">
        {editing ? (
          <input
            autoFocus
            value={draftName}
            onClick={e => e.stopPropagation()}
            onChange={e => setDraftName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') saveRename(); if (e.key === 'Escape') { setEditing(false); setDraftName(project.name) } }}
            onBlur={saveRename}
            disabled={saving}
            className="w-full text-white font-semibold text-sm leading-tight border-b border-blue-400 outline-none bg-transparent"
          />
        ) : (
          <div className="text-white font-semibold text-sm leading-tight line-clamp-1">{project.name}</div>
        )}
        <div className="text-slate-400 text-xs mt-1 line-clamp-1 min-h-[16px]">
          {address || project.description || 'No address yet'}
        </div>

        <div className="mt-3 pt-3 border-t border-white/[0.07] flex items-center justify-between">
          <StatusBadge status={project.status} />
          <span className="text-[11px] text-slate-500">{relTime(project.updated_at || project.created_at)}</span>
        </div>
      </div>
    </div>
  )
}

function StatTile({ label, value, icon }: { label: string; value: number | string; icon: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] backdrop-blur-sm p-5 flex items-center gap-4">
      <div className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(59,130,246,0.12)', border: '1px solid rgba(96,165,250,0.22)' }}>
        {icon}
      </div>
      <div>
        <div className="text-2xl font-bold text-white leading-none">{value}</div>
        <div className="text-slate-400 text-xs mt-1">{label}</div>
      </div>
    </div>
  )
}

const ICON = {
  folder: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z" /></svg>,
  clock: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>,
  check: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>,
}

export default function DashboardPage() {
  const router = useRouter()
  const [user, setUser] = useState<{ user_metadata?: { full_name?: string } } | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [archivedProjects, setArchivedProjects] = useState<Project[]>([])
  const [showTrash, setShowTrash] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    (async () => {
      const u = await getUser()
      if (!u) { router.push('/login'); return }
      setUser(u)
      setLoading(false)
      try {
        const allData = await api.projects.listArchived(u.id)
        setProjects((allData || []).filter((p: Project) => !p.archived))
        setArchivedProjects((allData || []).filter((p: Project) => p.archived))
      } catch {}
    })()
  }, [router])

  async function handleDelete(id: string) {
    try { await api.projects.delete(id) } catch {}
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
      if (proj) setArchivedProjects(prev => [{ ...proj, archived: true }, ...prev])
      setProjects(prev => prev.filter(p => p.id !== id))
    } catch {}
  }
  async function handleRestore(id: string) {
    try {
      await api.projects.restore(id)
      const proj = archivedProjects.find(p => p.id === id)
      if (proj) setProjects(prev => [{ ...proj, archived: false }, ...prev])
      setArchivedProjects(prev => prev.filter(p => p.id !== id))
    } catch {}
  }

  const completed = projects.filter(p => p.status === 'complete').length
  const inProgress = projects.filter(p => p.status === 'processing' || p.status === 'pending').length
  const recent = projects.slice(0, 8)
  const name = user?.user_metadata?.full_name?.split(' ')[0] || 'there'

  return (
    <div className="relative min-h-full" style={{ background: '#040810' }}>
      {/* Blueprint-grid background + corner glow */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.11]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(96,165,250,1) 1.5px, transparent 1.5px), linear-gradient(90deg, rgba(96,165,250,1) 1.5px, transparent 1.5px)',
          backgroundSize: '34px 34px',
        }}
      />
      <div className="pointer-events-none absolute -top-32 -right-24 h-[420px] w-[420px] rounded-full opacity-[0.10] blur-3xl" style={{ background: 'radial-gradient(circle, #3b82f6, transparent 60%)' }} />

      <div className="relative p-8 max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex items-end justify-between gap-4 mb-7">
          <div>
            <h1 className="text-2xl font-bold text-white leading-tight">Welcome back, {name}</h1>
            <p className="text-slate-400 text-sm mt-1">
              {projects.length === 0
                ? 'Start your first project to get going.'
                : `${completed} complete · ${inProgress} in progress`}
            </p>
          </div>
          <Link
            href="/projects/new"
            className="flex items-center gap-2 text-white font-semibold text-sm px-5 py-2.5 rounded-xl transition-all hover:scale-[1.02] flex-shrink-0"
            style={{ background: 'linear-gradient(180deg, #3B82F6 0%, #1E40AF 100%)', boxShadow: '0 8px 24px rgba(59,130,246,0.4), inset 0 1px 0 rgba(255,255,255,0.2)' }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
            New Project
          </Link>
        </div>

        {/* Stats bar */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-9">
          <StatTile label="Total projects" value={projects.length} icon={ICON.folder} />
          <StatTile label="In progress" value={inProgress} icon={ICON.clock} />
          <StatTile label="Completed" value={completed} icon={ICON.check} />
        </div>

        {/* Projects */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-white">Your projects</h2>
          {projects.length > 0 && (
            <Link href="/projects" className="text-blue-400 hover:text-blue-300 text-sm font-medium transition-colors">View all →</Link>
          )}
        </div>

        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="rounded-2xl border border-white/10 bg-white/[0.04] overflow-hidden animate-pulse">
                <div className="aspect-[16/10] bg-white/[0.03]" />
                <div className="p-4 space-y-2">
                  <div className="h-3.5 w-3/4 rounded bg-white/10" />
                  <div className="h-3 w-1/2 rounded bg-white/[0.07]" />
                </div>
              </div>
            ))}
          </div>
        ) : recent.length === 0 ? (
          <div className="rounded-2xl border border-white/10 bg-white/[0.04] py-16 flex flex-col items-center justify-center text-center">
            <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-4" style={{ background: 'rgba(59,130,246,0.12)', border: '1px solid rgba(96,165,250,0.25)' }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 11l9-8 9 8" /><path d="M5 10v10h14V10" /></svg>
            </div>
            <div className="text-white font-semibold text-base mb-1">No projects yet</div>
            <div className="text-slate-400 text-sm mb-5">Create your first project to get started.</div>
            <Link href="/projects/new" className="text-white font-semibold px-6 py-2.5 rounded-xl text-sm transition-all hover:scale-[1.03]" style={{ background: 'linear-gradient(180deg, #3B82F6 0%, #1E40AF 100%)', boxShadow: '0 8px 24px rgba(59,130,246,0.4)' }}>New Project</Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
            {recent.map(p => <ProjectCard key={p.id} project={p} onRename={handleRename} onArchive={handleArchive} />)}
          </div>
        )}

        {/* Trash */}
        {archivedProjects.length > 0 && (
          <div className="mt-10">
            <button onClick={() => setShowTrash(o => !o)} className="flex items-center gap-2 text-slate-400 hover:text-slate-200 text-sm font-medium transition-colors mb-4">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" /></svg>
              Trash ({archivedProjects.length}) <span>{showTrash ? '↑' : '↓'}</span>
            </button>
            {showTrash && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
                {archivedProjects.map(p => (
                  <div key={p.id} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                    <div className="text-slate-200 font-semibold text-sm mb-1 line-clamp-1">{p.name}</div>
                    <div className="text-slate-500 text-xs mb-3">{relTime(p.updated_at || p.created_at)}</div>
                    <div className="flex gap-2">
                      <button onClick={() => handleRestore(p.id)} className="flex-1 text-xs font-semibold text-blue-300 bg-blue-500/15 hover:bg-blue-500/25 py-1.5 rounded-lg transition-colors border border-blue-400/20">Restore</button>
                      <button onClick={() => handleDelete(p.id)} className="flex-1 text-xs font-semibold text-rose-300 bg-rose-500/10 hover:bg-rose-500/20 py-1.5 rounded-lg transition-colors border border-rose-400/20">Delete</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
