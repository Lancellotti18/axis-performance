'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { getUser } from '@/lib/auth'
import { api } from '@/lib/api'
import type { Project } from '@/types'

type Filter = 'all' | 'complete' | 'processing' | 'failed'

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    complete:   'bg-green-500/10 text-green-400 border-green-500/20',
    processing: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
    pending:    'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
    failed:     'bg-red-500/10 text-red-400 border-red-500/20',
  }
  const labels: Record<string, string> = { complete: 'Complete', processing: 'Processing', pending: 'Processing', failed: 'Failed' }
  const dots: Record<string, string> = { complete: 'bg-green-400', processing: 'bg-yellow-400 animate-pulse', pending: 'bg-yellow-400 animate-pulse', failed: 'bg-red-400' }
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full border ${styles[status] || 'bg-slate-500/10 text-slate-400 border-slate-500/20'}`}>
      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dots[status] || 'bg-slate-400'}`} />
      {labels[status] || status}
    </span>
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
        const data = await api.projects.list(u.id)
        setProjects(data || [])
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

  return (
    <div className="p-6 max-w-7xl mx-auto">

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-black text-white">Projects</h1>
          <p className="text-[#4a6a8a] text-sm mt-0.5">{projects.length} blueprint{projects.length !== 1 ? 's' : ''} total</p>
        </div>
        <Link
          href="/projects/new"
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white font-semibold px-4 py-2.5 rounded-xl text-sm transition-all hover:shadow-lg hover:shadow-blue-600/25"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Upload Blueprint
        </Link>
      </div>

      {/* Filters + view toggle */}
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-2">
          {(['all', 'complete', 'processing', 'failed'] as Filter[]).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold capitalize transition-all ${
                filter === f
                  ? 'bg-blue-600 text-white'
                  : 'bg-[#0f1e30] border border-[#1a2a3a] text-[#4a6a8a] hover:text-white hover:border-[#2a3a4a]'
              }`}
            >
              {f === 'all' ? `All (${projects.length})` : f}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#4a6a8a]" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input
              value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Filter projects…"
              className="bg-[#0f1e30] border border-[#1a2a3a] rounded-lg pl-8 pr-3 py-1.5 text-xs text-white placeholder-[#4a6a8a] focus:outline-none focus:border-blue-500/50 w-48"
            />
          </div>
          {/* View toggle */}
          <div className="flex bg-[#0f1e30] border border-[#1a2a3a] rounded-lg overflow-hidden">
            {(['grid', 'table'] as const).map(v => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`px-3 py-1.5 transition-colors ${view === v ? 'bg-blue-600/20 text-blue-400' : 'text-[#4a6a8a] hover:text-white'}`}
              >
                {v === 'grid'
                  ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
                  : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
                }
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center py-24 text-[#4a6a8a]">Loading projects…</div>
      ) : filtered.length === 0 ? (
        <div className="bg-[#0f1e30] border border-[#1a2a3a] rounded-2xl p-16 text-center">
          <div className="w-14 h-14 bg-blue-600/10 border border-blue-500/20 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>
            </svg>
          </div>
          <div className="text-white font-semibold mb-1">{search || filter !== 'all' ? 'No matching projects' : 'No projects yet'}</div>
          <div className="text-[#4a6a8a] text-sm mb-5">
            {search || filter !== 'all' ? 'Try adjusting your filters' : 'Upload your first blueprint to get started'}
          </div>
          {filter === 'all' && !search && (
            <Link href="/projects/new" className="inline-block bg-blue-600 hover:bg-blue-500 text-white font-semibold px-5 py-2.5 rounded-xl text-sm transition-all">
              Upload Blueprint
            </Link>
          )}
        </div>
      ) : view === 'grid' ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map(p => (
            <Link
              key={p.id}
              href={`/projects/${p.id}`}
              className="bg-[#0f1e30] border border-[#1a2a3a] hover:border-blue-500/30 rounded-xl overflow-hidden transition-all duration-200 hover:-translate-y-0.5 hover:shadow-xl hover:shadow-black/30 group"
            >
              {/* Blueprint preview */}
              <div className="h-36 bg-[#0a1628] flex items-center justify-center border-b border-[#1a2a3a] relative overflow-hidden">
                <div
                  className="absolute inset-0 opacity-10"
                  style={{
                    backgroundImage: `linear-gradient(rgba(96,165,250,0.3) 1px, transparent 1px), linear-gradient(90deg, rgba(96,165,250,0.3) 1px, transparent 1px)`,
                    backgroundSize: '20px 20px',
                  }}
                />
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="rgba(96,165,250,0.4)" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>
                  <line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/>
                </svg>
                <div className="absolute top-2 right-2"><StatusBadge status={p.status} /></div>
              </div>

              <div className="p-4">
                <div className="font-semibold text-white text-sm mb-1 group-hover:text-blue-300 transition-colors">{p.name}</div>
                {p.description && <div className="text-[#4a6a8a] text-xs mb-3 line-clamp-1">{p.description}</div>}
                <div className="flex items-center justify-between text-xs text-[#4a6a8a]">
                  <span>{new Date(p.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                  <span className="text-blue-400 font-medium group-hover:text-blue-300">Open →</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <div className="bg-[#0f1e30] border border-[#1a2a3a] rounded-xl overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-[#1a2a3a]">
                {['Project Name', 'Status', 'Created', 'Actions'].map(h => (
                  <th key={h} className={`text-left text-[10px] font-semibold text-[#4a6a8a] uppercase tracking-wider px-5 py-3.5 ${h === 'Actions' ? 'text-right' : ''}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((p, i) => (
                <tr key={p.id} className={`hover:bg-white/[0.02] transition-colors ${i < filtered.length - 1 ? 'border-b border-[#1a2a3a]' : ''}`}>
                  <td className="px-5 py-4">
                    <div className="text-white text-sm font-medium">{p.name}</div>
                    {p.description && <div className="text-[#4a6a8a] text-xs mt-0.5">{p.description}</div>}
                  </td>
                  <td className="px-5 py-4"><StatusBadge status={p.status} /></td>
                  <td className="px-5 py-4 text-[#4a6a8a] text-xs">{new Date(p.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
                  <td className="px-5 py-4 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <Link href={`/projects/${p.id}`} className="text-xs text-blue-400 hover:text-blue-300 font-medium px-2 py-1 rounded hover:bg-blue-500/10 transition-all">Open</Link>
                      <button className="text-xs text-[#4a6a8a] hover:text-white px-2 py-1 rounded hover:bg-white/5 transition-all">Export</button>
                      <Link href="/permits" className="text-xs text-[#4a6a8a] hover:text-white px-2 py-1 rounded hover:bg-white/5 transition-all">Submit</Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
