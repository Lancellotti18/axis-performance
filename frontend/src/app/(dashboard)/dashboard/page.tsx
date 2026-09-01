'use client'
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useRouter } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { getUser } from '@/lib/auth'
import { api } from '@/lib/api'
import type { Project } from '@/types'
import { ButtonLink, CountUp, PageTransition, StatusBadge } from '@/components/ui'
import MorningBriefing from '@/components/MorningBriefing'
import FirstRunGreeting, { WELCOME_COACH_KEY } from '@/components/FirstRunGreeting'

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

function ThumbPlaceholder({ id }: { id: string }) {
  // Slick dark blueprint placeholder for projects with no satellite tile yet.
  return (
    <div className="absolute inset-0 flex items-center justify-center" style={{ background: '#e4e4e2' }}>
      <svg className="absolute inset-0 w-full h-full opacity-[0.18]" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <pattern id={`bp-${id}`} width="22" height="22" patternUnits="userSpaceOnUse">
            <path d="M 22 0 L 0 0 0 22" fill="none" stroke="#3b82f6" strokeWidth="0.5" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill={`url(#bp-${id})`} />
      </svg>
      <div className="relative z-10 w-11 h-11 rounded-xl flex items-center justify-center" style={{ background: '#e8f2fd', border: '1px solid #d3e6fa' }}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--color-brand-600)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 11l9-8 9 8" /><path d="M5 10v10h14V10" /><path d="M9 21v-6h6v6" />
        </svg>
      </div>
    </div>
  )
}

function ProjectCard({
  project, onRename, onArchive, photoCount = 0,
}: {
  project: Project
  onRename: (id: string, name: string) => void
  onArchive: (id: string) => void
  /** Job photos on this project — 0 hides the badge entirely. */
  photoCount?: number
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
      className="group relative cursor-pointer rounded-2xl overflow-hidden border border-[#dededc] bg-[#f8f8f7] transition-all duration-200 hover:-translate-y-1 hover:border-blue-400/40 hover:shadow-[0_14px_44px_rgba(59,130,246,0.22)]"
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
            className="w-7 h-7 rounded-lg bg-[#f8f8f7] flex items-center justify-center text-[#1a1a1a] hover:bg-[#f8f8f7] hover:text-[#1a1a1a] transition-colors border border-[#dededc]"
            title="Rename"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
          </button>
          <button
            onClick={e => { e.stopPropagation(); onArchive(project.id) }}
            className="w-7 h-7 rounded-lg bg-[#f8f8f7] flex items-center justify-center text-[#6b7280] hover:bg-[#f8f8f7] hover:text-rose-300 transition-colors border border-[#dededc]"
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
            className="w-full text-[#1a1a1a] font-semibold text-sm leading-tight border-b border-blue-400 outline-none bg-transparent"
          />
        ) : (
          <div className="text-[#1a1a1a] font-semibold text-sm leading-tight line-clamp-1">{project.name}</div>
        )}
        <div className="text-[#6b7280] text-xs mt-1 line-clamp-1 min-h-[16px]">
          {address || project.description || 'No address yet'}
        </div>

        <div className="mt-3 pt-3 border-t border-white/[0.07] flex items-center justify-between">
          <StatusBadge status={project.status} />
          {photoCount > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-[#f8f8f7] px-1.5 py-0.5 text-[10px] font-semibold text-[#2d2d2d]"
              title={`${photoCount} job photo${photoCount === 1 ? '' : 's'}`}>
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="12" cy="12" r="3" />
              </svg>
              {photoCount}
            </span>
          )}
          <span className="text-[11px] text-[#6b7280]">{relTime(project.updated_at || project.created_at)}</span>
        </div>
      </div>
    </div>
  )
}

function StatTile({ label, value, icon }: { label: string; value: number | string; icon: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-[#dededc] bg-[#f8f8f7] p-5 flex items-center gap-4">
      <div className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(59,130,246,0.12)', border: '1px solid rgba(96,165,250,0.22)' }}>
        {icon}
      </div>
      <div>
        <div className="text-2xl font-bold text-[#1a1a1a] leading-none">
          {typeof value === 'number' ? <CountUp value={value} /> : value}
        </div>
        <div className="text-[#6b7280] text-xs mt-1">{label}</div>
      </div>
    </div>
  )
}

const ICON = {
  folder: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--color-brand-600)" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z" /></svg>,
  clock: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--color-brand-600)" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>,
  check: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--color-brand-600)" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>,
  roof: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--color-brand-600)" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M3 11l9-8 9 8" /><path d="M5 10v10h14V10" /></svg>,
}

export default function DashboardPage() {
  const router = useRouter()
  const qc = useQueryClient()
  const [user, setUser] = useState<{ id?: string; user_metadata?: { full_name?: string } } | null>(null)
  const [showTrash, setShowTrash] = useState(false)

  useEffect(() => {
    getUser().then(u => { if (!u) router.push('/login'); else setUser(u) })
  }, [router])

  // Projects live in the app-wide cache, so coming back from CRM or Dispatch
  // paints instantly instead of blanking and refetching (see lib/app-query).
  const { data: allProjects = [], isLoading } = useQuery<Project[]>({
    queryKey: ['projects', user?.id],
    queryFn: () => api.projects.listArchived(user!.id!) as Promise<Project[]>,
    enabled: !!user?.id,
  })

  // Photo counts for the cards. Until now a project's photos were invisible from
  // anywhere except its own page, so there was no way to see a job had any.
  const { data: photoIndex } = useQuery({
    queryKey: ['photo-counts', user?.id],
    queryFn: () => api.projectPhotos.counts(),
    enabled: !!user?.id,
    staleTime: 5 * 60_000,
  })

  const projects = useMemo(() => allProjects.filter(p => !p.archived), [allProjects])
  const archivedProjects = useMemo(() => allProjects.filter(p => p.archived), [allProjects])

  // One place to write the cached list, so every mutation below stays in sync
  // with whatever Projects and the rest of the app are reading.
  const patchCache = useCallback((fn: (rows: Project[]) => Project[]) => {
    qc.setQueryData<Project[]>(['projects', user?.id], old => fn(old || []))
  }, [qc, user?.id])

  async function handleDelete(id: string) {
    try { await api.projects.delete(id) } catch {}
    patchCache(rows => rows.filter(p => p.id !== id))
  }
  function handleRename(id: string, newName: string) {
    patchCache(rows => rows.map(p => p.id === id ? { ...p, name: newName } : p))
  }
  async function handleArchive(id: string) {
    try {
      await api.projects.archive(id)
      patchCache(rows => rows.map(p => p.id === id ? { ...p, archived: true } : p))
    } catch {}
  }
  async function handleRestore(id: string) {
    try {
      await api.projects.restore(id)
      patchCache(rows => rows.map(p => p.id === id ? { ...p, archived: false } : p))
    } catch {}
  }

  const completed = projects.filter(p => p.status === 'complete').length
  const inProgress = projects.filter(p => p.status === 'processing' || p.status === 'pending').length
  const recent = projects.slice(0, 8)
  const name = user?.user_metadata?.full_name?.split(' ')[0] || 'there'
  const loading = isLoading || !user

  // Read the dismissal without setState-in-an-effect. The server snapshot says
  // "dismissed" so the greeting never flashes during SSR for someone who has
  // already sent it away; the client then reports the real value.
  const storedDismissed = useSyncExternalStore(
    () => () => {},
    () => { try { return localStorage.getItem(WELCOME_COACH_KEY) === '1' } catch { return true } },
    () => true,
  )
  const [justDismissed, setJustDismissed] = useState(false)
  const dismissWelcome = useCallback(() => {
    try { localStorage.setItem(WELCOME_COACH_KEY, '1') } catch { /* private mode */ }
    setJustDismissed(true)
  }, [])
  // Having no projects is the honest signal of a new account — far more
  // reliable than counting logins, which misses someone who has signed in
  // repeatedly without ever tracing a roof.
  const showWelcome = !loading && projects.length === 0 && !storedDismissed && !justDismissed

  return (
    <div className="relative min-h-full">
      {/* Blueprint-grid background + corner glow */}
      <div className="pointer-events-none absolute -top-32 -right-24 h-[420px] w-[420px] rounded-full opacity-[0.10] blur-3xl" style={{ background: 'radial-gradient(circle, #3b82f6, transparent 60%)' }} />

      <PageTransition className="relative p-8 max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex items-end justify-between gap-4 mb-7">
          <div>
            <h1 className="text-2xl font-bold text-[#1a1a1a] leading-tight">Welcome back, {name}</h1>
            <p className="text-[#6b7280] text-sm mt-1">
              {projects.length === 0
                ? 'Start your first project to get going.'
                : `${completed} complete · ${inProgress} in progress`}
            </p>
          </div>
          <ButtonLink
            href="/projects/new"
            variant="primary"
            className="flex-shrink-0"
            leftIcon={<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>}
          >
            New Project
          </ButtonLink>
        </div>

        {/* The briefing leads: what needs doing today, before the file list.
            On a brand-new account it has nothing to report, so the welcome
            takes its place rather than stacking two near-empty cards. */}
        {showWelcome ? <FirstRunGreeting name={name} onDismiss={dismissWelcome} /> : <MorningBriefing />}

        {/* Stats bar */}
        <div className="grid grid-cols-2 gap-4 mb-9 sm:grid-cols-4">
          <StatTile label="Total projects" value={projects.length} icon={ICON.folder} />
          <StatTile label="In progress" value={inProgress} icon={ICON.clock} />
          <StatTile label="Completed" value={completed} icon={ICON.check} />
          <StatTile label="Measured roofs" value={projects.filter(p => p.thumbnail_url).length} icon={ICON.roof} />
        </div>

        {/* Projects */}
        <div className="flex items-center justify-between mb-4">
          {/* Named "Recent" and counted on purpose: this grid is a glance at the
              8 newest, while /projects is the working list with status filters,
              search and a table view. Without the count it reads as "all your
              projects", which makes the Projects nav item look redundant. */}
          <h2 className="text-base font-semibold text-[#1a1a1a]">
            Recent projects
            {projects.length > recent.length && (
              <span className="ml-2 text-xs font-normal text-[#6b7280]">
                {recent.length} of {projects.length}
              </span>
            )}
          </h2>
          {projects.length > 0 && (
            <Link href="/projects" className="text-blue-400 hover:text-blue-300 text-sm font-medium transition-colors">
              {projects.length > recent.length ? `View all ${projects.length} →` : 'View all →'}
            </Link>
          )}
        </div>

        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="rounded-2xl border border-[#dededc] bg-[#f8f8f7] overflow-hidden animate-pulse">
                <div className="aspect-[16/10] bg-[#f8f8f7]" />
                <div className="p-4 space-y-2">
                  <div className="h-3.5 w-3/4 rounded bg-[#eeeeed]" />
                  <div className="h-3 w-1/2 rounded bg-[#f8f8f7]" />
                </div>
              </div>
            ))}
          </div>
        ) : recent.length === 0 ? (
          <div className="rounded-2xl border border-[#dededc] bg-[#f8f8f7] py-16 flex flex-col items-center justify-center text-center">
            <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-4" style={{ background: '#e8f2fd', border: '1px solid #d3e6fa' }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--color-brand-600)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 11l9-8 9 8" /><path d="M5 10v10h14V10" /></svg>
            </div>
            <div className="text-[#1a1a1a] font-semibold text-base mb-1">No projects yet</div>
            <div className="text-[#6b7280] text-sm mb-5">Create your first project to get started.</div>
            <ButtonLink href="/projects/new" variant="primary" size="lg">New Project</ButtonLink>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
            {recent.map(p => (
              <ProjectCard key={p.id} project={p} onRename={handleRename} onArchive={handleArchive}
                photoCount={photoIndex?.counts?.[p.id] ?? 0} />
            ))}
          </div>
        )}

        {/* Trash */}
        {archivedProjects.length > 0 && (
          <div className="mt-10">
            <button onClick={() => setShowTrash(o => !o)} className="flex items-center gap-2 text-[#6b7280] hover:text-[#1a1a1a] text-sm font-medium transition-colors mb-4">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" /></svg>
              Trash ({archivedProjects.length}) <span>{showTrash ? '↑' : '↓'}</span>
            </button>
            {showTrash && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
                {archivedProjects.map(p => (
                  <div key={p.id} className="rounded-2xl border border-[#dededc] bg-[#f8f8f7] p-4">
                    <div className="text-[#1a1a1a] font-semibold text-sm mb-1 line-clamp-1">{p.name}</div>
                    <div className="text-[#6b7280] text-xs mb-3">{relTime(p.updated_at || p.created_at)}</div>
                    <div className="flex gap-2">
                      <button onClick={() => handleRestore(p.id)} className="flex-1 text-xs font-semibold text-blue-800 bg-blue-50 hover:bg-blue-500/25 py-1.5 rounded-lg transition-colors border border-blue-400/20">Restore</button>
                      <button onClick={() => handleDelete(p.id)} className="flex-1 text-xs font-semibold text-rose-800 bg-rose-50 hover:bg-rose-500/20 py-1.5 rounded-lg transition-colors border border-rose-400/20">Delete</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </PageTransition>
    </div>
  )
}
