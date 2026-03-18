'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { getUser } from '@/lib/auth'
import { api } from '@/lib/api'
import type { Project } from '@/types'

function StatCard({ label, value, sub, color, icon }: { label: string; value: string | number; sub?: string; color: string; icon: React.ReactNode }) {
  return (
    <div className={`bg-[#0f1e30] border border-[#1a2a3a] rounded-xl p-5 hover:border-[#2a3a4a] transition-all duration-200 group`}>
      <div className="flex items-start justify-between mb-4">
        <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${color}`}>
          {icon}
        </div>
      </div>
      <div className="text-2xl font-black text-white mb-0.5">{value}</div>
      <div className="text-[#4a6a8a] text-sm">{label}</div>
      {sub && <div className="text-xs text-[#3a5a7a] mt-1">{sub}</div>}
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    complete:   'bg-green-500/10 text-green-400 border border-green-500/20',
    processing: 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/20',
    pending:    'bg-yellow-500/10 text-yellow-400 border border-yellow-500/20',
    failed:     'bg-red-500/10 text-red-400 border border-red-500/20',
  }
  const labels: Record<string, string> = {
    complete: 'Complete', processing: 'Processing', pending: 'Processing', failed: 'Failed',
  }
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full ${map[status] || 'bg-slate-500/10 text-slate-400 border border-slate-500/20'}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${status === 'complete' ? 'bg-green-400' : status === 'failed' ? 'bg-red-400' : 'bg-yellow-400 animate-pulse'}`} />
      {labels[status] || status}
    </span>
  )
}

export default function DashboardPage() {
  const router = useRouter()
  const [user, setUser] = useState<any>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      const u = await getUser()
      if (!u) { router.push('/login'); return }
      setUser(u)
      try {
        const data = await api.projects.list(u.id)
        setProjects(data || [])
      } catch {}
      setLoading(false)
    }
    load()
  }, [router])

  const complete = projects.filter(p => p.status === 'complete').length
  const processing = projects.filter(p => p.status === 'processing' || p.status === 'pending').length
  const recent = projects.slice(0, 6)
  const name = user?.user_metadata?.full_name?.split(' ')[0] || 'there'

  return (
    <div className="p-6 max-w-7xl mx-auto">

      {/* Header */}
      <div className="flex items-start justify-between mb-8">
        <div>
          <h1 className="text-2xl font-black text-white">Good morning, {name} 👋</h1>
          <p className="text-[#4a6a8a] text-sm mt-1">Here&apos;s your project overview for today.</p>
        </div>
        <Link
          href="/projects/new"
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white font-semibold px-4 py-2.5 rounded-xl text-sm transition-all duration-200 hover:shadow-lg hover:shadow-blue-600/25"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Upload Blueprint
        </Link>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-4 gap-4 mb-8">
        <StatCard
          label="Active Projects" value={projects.length}
          sub={`${complete} complete`}
          color="bg-blue-500/15 text-blue-400"
          icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>}
        />
        <StatCard
          label="Pending Permits" value={0}
          sub="No submissions yet"
          color="bg-yellow-500/15 text-yellow-400"
          icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 12l2 2 4-4"/></svg>}
        />
        <StatCard
          label="Issues Detected" value={0}
          sub="Across all projects"
          color="bg-red-500/15 text-red-400"
          icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>}
        />
        <StatCard
          label="Est. Project Value" value="—"
          sub="Awaiting analysis"
          color="bg-green-500/15 text-green-400"
          icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>}
        />
      </div>

      <div className="grid grid-cols-12 gap-6">

        {/* Recent Projects */}
        <div className="col-span-8">
          <div className="bg-[#0f1e30] border border-[#1a2a3a] rounded-xl overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-[#1a2a3a]">
              <h2 className="text-white font-bold text-sm">Recent Projects</h2>
              <Link href="/projects" className="text-blue-400 hover:text-blue-300 text-xs font-medium transition-colors">View all →</Link>
            </div>

            {loading ? (
              <div className="p-8 text-center text-[#4a6a8a] text-sm">Loading projects…</div>
            ) : recent.length === 0 ? (
              <div className="p-16 text-center">
                <div className="w-14 h-14 bg-blue-600/10 border border-blue-500/20 rounded-2xl flex items-center justify-center mx-auto mb-4">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>
                  </svg>
                </div>
                <div className="text-white font-semibold mb-1">No projects yet</div>
                <div className="text-[#4a6a8a] text-sm mb-4">Upload your first blueprint to get started</div>
                <Link href="/projects/new" className="inline-block bg-blue-600 hover:bg-blue-500 text-white font-semibold px-5 py-2.5 rounded-xl text-sm transition-all">
                  Upload Blueprint
                </Link>
              </div>
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="border-b border-[#1a2a3a]">
                    {['Project Name', 'Status', 'Last Updated', 'Actions'].map(h => (
                      <th key={h} className={`text-left text-[10px] font-semibold text-[#4a6a8a] uppercase tracking-wider px-5 py-3 ${h === 'Actions' ? 'text-right' : ''}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {recent.map((p, i) => (
                    <tr key={p.id} className={`hover:bg-white/[0.02] transition-colors ${i < recent.length - 1 ? 'border-b border-[#1a2a3a]' : ''}`}>
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 bg-blue-600/10 border border-blue-500/20 rounded-lg flex items-center justify-center flex-shrink-0">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>
                            </svg>
                          </div>
                          <div>
                            <div className="text-white text-sm font-medium">{p.name}</div>
                            {p.description && <div className="text-[#4a6a8a] text-xs mt-0.5 truncate max-w-[180px]">{p.description}</div>}
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-3.5"><StatusBadge status={p.status} /></td>
                      <td className="px-5 py-3.5 text-[#4a6a8a] text-xs">{new Date(p.updated_at || p.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
                      <td className="px-5 py-3.5 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <Link href={`/projects/${p.id}`} className="text-xs text-[#4a6a8a] hover:text-blue-400 transition-colors px-2 py-1 rounded hover:bg-blue-500/10">View</Link>
                          <Link href={`/projects/${p.id}`} className="text-xs text-[#4a6a8a] hover:text-white transition-colors px-2 py-1 rounded hover:bg-white/5">Export</Link>
                          <Link href="/permits" className="text-xs text-blue-400 hover:text-blue-300 font-medium transition-colors px-2 py-1 rounded hover:bg-blue-500/10">Submit Permit</Link>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Quick Actions */}
        <div className="col-span-4 space-y-4">
          <div className="bg-[#0f1e30] border border-[#1a2a3a] rounded-xl p-5">
            <h2 className="text-white font-bold text-sm mb-4">Quick Actions</h2>
            <div className="space-y-2">
              {[
                { href: '/projects/new', label: 'Upload New Blueprint', icon: '📤', desc: 'Analyze a new PDF' },
                { href: '/reports', label: 'Generate Report', icon: '📊', desc: 'Export project data' },
                { href: '/permits', label: 'Submit Pending Permit', icon: '📑', desc: 'File with jurisdiction' },
              ].map(a => (
                <Link
                  key={a.href}
                  href={a.href}
                  className="flex items-center gap-3 p-3 bg-white/[0.03] hover:bg-white/[0.06] border border-[#1a2a3a] hover:border-[#2a3a4a] rounded-xl transition-all duration-150 group"
                >
                  <span className="text-xl">{a.icon}</span>
                  <div>
                    <div className="text-white text-sm font-medium group-hover:text-blue-300 transition-colors">{a.label}</div>
                    <div className="text-[#4a6a8a] text-xs">{a.desc}</div>
                  </div>
                </Link>
              ))}
            </div>
          </div>

          {/* Status summary */}
          <div className="bg-[#0f1e30] border border-[#1a2a3a] rounded-xl p-5">
            <h2 className="text-white font-bold text-sm mb-4">Processing Status</h2>
            <div className="space-y-3">
              {[
                { label: 'Complete', count: complete, color: 'bg-green-500' },
                { label: 'Processing', count: processing, color: 'bg-yellow-500 animate-pulse' },
                { label: 'Total', count: projects.length, color: 'bg-blue-500' },
              ].map(s => (
                <div key={s.label} className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${s.color}`} />
                    <span className="text-[#64748b] text-sm">{s.label}</span>
                  </div>
                  <span className="text-white text-sm font-bold">{s.count}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
