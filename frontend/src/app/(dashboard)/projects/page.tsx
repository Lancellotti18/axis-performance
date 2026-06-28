'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { getUser } from '@/lib/auth'
import { api } from '@/lib/api'
import type { Project } from '@/types'

type Filter = 'all' | 'complete' | 'processing' | 'failed'

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
  return (
    <div className="absolute inset-0 flex items-center justify-center" style={{ background: 'linear-gradient(135deg, #0a1322 0%, #060b16 100%)' }}>
      <svg className="absolute inset-0 w-full h-full opacity-[0.18]" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <pattern id={`pp-${id}`} width="22" height="22" patternUnits="userSpaceOnUse">
            <path d="M 22 0 L 0 0 0 22" fill="none" stroke="#3b82f6" strokeWidth="0.5" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill={`url(#pp-${id})`} />
      </svg>
      <div className="relative z-10 w-11 h-11 rounded-xl flex items-center justify-center" style={{ background: 'rgba(59,130,246,0.12)', border: '1px solid rgba(96,165,250,0.25)' }}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 11l9-8 9 8" /><path d="M5 10v10h14V10" /><path d="M9 21v-6h6v6" /></svg>
      </div>
    </div>
  )
}

function ProjectGridCard({ p }: { p: Project }) {
  const [imgOk, setImgOk] = useState(!!p.thumbnail_url)
  const address = [p.address, p.city, p.zip_code].filter(Boolean).join(', ')
  return (
    <Link
      href={`/projects/${p.id}`}
      className="group relative rounded-2xl overflow-hidden border border-white/10 bg-white/[0.04] backdrop-blur-sm transition-all duration-200 hover:-translate-y-1 hover:border-blue-400/40 hover:shadow-[0_14px_44px_rgba(59,130,246,0.22)]"
    >
      <div className="relative aspect-[16/10] overflow-hidden">
        {imgOk && p.thumbnail_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={p.thumbnail_url} alt={p.name} loading="lazy" onError={() => setImgOk(false)} className="h-full w-full object-cover" />
        ) : (
          <ThumbPlaceholder id={p.id} />
        )}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-white/15" />
      </div>
      <div className="p-4">
        <div className="text-white font-semibold text-sm leading-tight line-clamp-1">{p.name}</div>
        <div className="text-slate-400 text-xs mt-1 line-clamp-1 min-h-[16px]">{address || p.description || 'No address yet'}</div>
        <div className="mt-3 pt-3 border-t border-white/[0.07] flex items-center justify-between">
          <StatusBadge status={p.status} />
          <span className="text-[11px] text-slate-500">{relTime(p.updated_at || p.created_at)}</span>
        </div>
      </div>
    </Link>
  )
}

export default function ProjectsPage() {
  const router = useRouter()
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<Filter>('all')
  const [search, setSearch] = useState('')
  const [view, setView] = useState<'grid' | 'table'>('grid')

  useEffect(() => {
    async function load() {
      const u = await getUser()
      if (!u) { router.push('/login'); return }
      try {
        const allData = await api.projects.listArchived(u.id)
        setProjects((allData || []).filter((p: Project) => !p.archived))
      } catch {}
      setLoading(false)
    }
    load()
  }, [router])

  const filtered = projects.filter(p => {
    const matchStatus = filter === 'all' || p.status === filter || (filter === 'processing' && p.status === 'pending')
    const matchSearch = !search || p.name.toLowerCase().includes(search.toLowerCase())
    return matchStatus && matchSearch
  })

  const newBtn = { background: 'linear-gradient(180deg, #3B82F6 0%, #1E40AF 100%)', boxShadow: '0 8px 24px rgba(59,130,246,0.4), inset 0 1px 0 rgba(255,255,255,0.2)' }

  return (
    <div className="relative min-h-full" style={{ background: '#040810' }}>
      <div className="pointer-events-none absolute inset-0 opacity-[0.11]" style={{ backgroundImage: 'linear-gradient(rgba(96,165,250,1) 1.5px, transparent 1.5px), linear-gradient(90deg, rgba(96,165,250,1) 1.5px, transparent 1.5px)', backgroundSize: '34px 34px' }} />
      <div className="pointer-events-none absolute -top-32 -right-24 h-[420px] w-[420px] rounded-full opacity-[0.10] blur-3xl" style={{ background: 'radial-gradient(circle, #3b82f6, transparent 60%)' }} />

      <div className="relative p-8 max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex items-end justify-between gap-4 mb-7">
          <div>
            <h1 className="text-2xl font-bold text-white">Projects</h1>
            <p className="text-slate-400 text-sm mt-1">{projects.length} project{projects.length !== 1 ? 's' : ''} total</p>
          </div>
          <Link href="/projects/new" className="flex items-center gap-2 text-white font-semibold px-5 py-2.5 rounded-xl text-sm transition-all hover:scale-[1.02]" style={newBtn}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
            New Project
          </Link>
        </div>

        {/* Filters + view toggle */}
        <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
          <div className="flex items-center gap-2">
            {(['all', 'complete', 'processing', 'failed'] as Filter[]).map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold capitalize transition-all border ${
                  filter === f ? 'bg-blue-500/20 border-blue-400/40 text-blue-100' : 'bg-white/[0.04] border-white/10 text-slate-400 hover:text-white hover:border-white/20'
                }`}
              >
                {f === 'all' ? `All (${projects.length})` : f === 'processing' ? 'In progress' : f}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Filter projects…" className="bg-white/[0.05] border border-white/10 rounded-lg pl-8 pr-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-400/40 w-48" />
            </div>
            <div className="flex bg-white/[0.05] border border-white/10 rounded-lg overflow-hidden">
              {(['grid', 'table'] as const).map(v => (
                <button key={v} onClick={() => setView(v)} className={`px-3 py-1.5 transition-colors ${view === v ? 'bg-blue-500/20 text-blue-300' : 'text-slate-500 hover:text-white'}`}>
                  {v === 'grid'
                    ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>
                    : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /></svg>}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Content */}
        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="rounded-2xl border border-white/10 bg-white/[0.04] overflow-hidden animate-pulse">
                <div className="aspect-[16/10] bg-white/[0.03]" />
                <div className="p-4 space-y-2"><div className="h-3.5 w-3/4 rounded bg-white/10" /><div className="h-3 w-1/2 rounded bg-white/[0.07]" /></div>
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-16 text-center">
            <div className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4" style={{ background: 'rgba(59,130,246,0.12)', border: '1px solid rgba(96,165,250,0.25)' }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 11l9-8 9 8" /><path d="M5 10v10h14V10" /></svg>
            </div>
            <div className="text-white font-semibold mb-1">{search || filter !== 'all' ? 'No matching projects' : 'No projects yet'}</div>
            <div className="text-slate-400 text-sm mb-5">{search || filter !== 'all' ? 'Try adjusting your filters' : 'Create your first project to get started'}</div>
            {filter === 'all' && !search && (
              <Link href="/projects/new" className="inline-block text-white font-semibold px-5 py-2.5 rounded-xl text-sm transition-all hover:scale-[1.03]" style={newBtn}>New Project</Link>
            )}
          </div>
        ) : view === 'grid' ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
            {filtered.map(p => <ProjectGridCard key={p.id} p={p} />)}
          </div>
        ) : (
          <div className="rounded-2xl border border-white/10 bg-white/[0.04] overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/10">
                  {['Project', 'Status', 'Updated', 'Actions'].map(h => (
                    <th key={h} className={`text-[10px] font-semibold text-slate-500 uppercase tracking-wider px-5 py-3.5 ${h === 'Actions' ? 'text-right' : 'text-left'}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((p, i) => (
                  <tr key={p.id} className={`hover:bg-white/[0.03] transition-colors ${i < filtered.length - 1 ? 'border-b border-white/[0.07]' : ''}`}>
                    <td className="px-5 py-4">
                      <div className="text-white text-sm font-medium">{p.name}</div>
                      <div className="text-slate-500 text-xs mt-0.5">{[p.address, p.city].filter(Boolean).join(', ') || p.description || '—'}</div>
                    </td>
                    <td className="px-5 py-4"><StatusBadge status={p.status} /></td>
                    <td className="px-5 py-4 text-slate-500 text-xs">{relTime(p.updated_at || p.created_at)}</td>
                    <td className="px-5 py-4 text-right">
                      <Link href={`/projects/${p.id}`} className="text-xs text-blue-300 hover:text-blue-200 font-medium px-2.5 py-1 rounded-lg bg-blue-500/15 hover:bg-blue-500/25 border border-blue-400/20 transition-all">Open</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
