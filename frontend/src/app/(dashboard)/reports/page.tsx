'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getUser } from '@/lib/auth'
import { api } from '@/lib/api'
import type { Project } from '@/types'

type ReportFormat = 'pdf' | 'csv' | 'excel'

const REPORT_TYPES = [
  { id: 'full',      label: 'Full Project Report',  desc: 'Complete analysis with rooms, materials, costs, and compliance',  fmt: 'pdf' as ReportFormat,   icon: '📋' },
  { id: 'materials', label: 'Materials List',        desc: 'Itemized list of all materials with quantities and costs',         fmt: 'csv' as ReportFormat,   icon: '🏗️' },
  { id: 'cost',      label: 'Cost Breakdown',        desc: 'Detailed cost breakdown by category with labor estimates',         fmt: 'excel' as ReportFormat, icon: '💰' },
]

export default function ReportsPage() {
  const router = useRouter()
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<string>('')
  const [generating, setGenerating] = useState<string | null>(null)
  const [generated, setGenerated] = useState<string[]>([])

  useEffect(() => {
    async function load() {
      const u = await getUser()
      if (!u) { router.push('/login'); return }
      try {
        const data = await api.projects.list(u.id)
        const complete = (data || []).filter((p: Project) => p.status === 'complete')
        setProjects(complete)
        if (complete.length > 0) setSelected(complete[0].id)
      } catch {}
      setLoading(false)
    }
    load()
  }, [router])

  async function handleGenerate(reportId: string, fmt: ReportFormat) {
    if (!selected) return
    setGenerating(reportId)
    try {
      const { download_url } = await api.reports.download(selected, fmt)
      window.open(download_url)
      setGenerated(prev => [...prev, reportId])
    } catch {
      // show error state
    }
    setGenerating(null)
  }

  const selectedProject = projects.find(p => p.id === selected)

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-black text-white">Reports</h1>
        <p className="text-[#4a6a8a] text-sm mt-1">Generate and download reports for your projects.</p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-24 text-[#4a6a8a]">Loading…</div>
      ) : projects.length === 0 ? (
        <div className="bg-[#0f1e30] border border-[#1a2a3a] rounded-2xl p-16 text-center">
          <div className="text-4xl mb-3">📊</div>
          <div className="text-white font-semibold mb-1">No completed projects</div>
          <div className="text-[#4a6a8a] text-sm">Complete a blueprint analysis first, then generate reports here.</div>
        </div>
      ) : (
        <>
          {/* Project selector */}
          <div className="bg-[#0f1e30] border border-[#1a2a3a] rounded-xl p-5 mb-6">
            <label className="text-white font-semibold text-sm block mb-3">Select Project</label>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {projects.map(p => (
                <button
                  key={p.id}
                  onClick={() => setSelected(p.id)}
                  className={`flex items-center gap-3 p-3 rounded-xl border text-left transition-all ${
                    selected === p.id
                      ? 'bg-blue-600/15 border-blue-500/40 text-blue-300'
                      : 'bg-[#0a1628] border-[#1a2a3a] text-[#64748b] hover:border-[#2a3a4a] hover:text-white'
                  }`}
                >
                  <div className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 ${selected === p.id ? 'bg-blue-600/30' : 'bg-white/5'}`}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                    </svg>
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{p.name}</div>
                    <div className="text-xs opacity-60">{new Date(p.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>
                  </div>
                  {selected === p.id && (
                    <svg className="ml-auto flex-shrink-0" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Report types */}
          {selectedProject && (
            <div className="space-y-3">
              <div className="text-white font-semibold text-sm mb-4">
                Available Reports — <span className="text-blue-400">{selectedProject.name}</span>
              </div>
              {REPORT_TYPES.map(r => (
                <div
                  key={r.id}
                  className="bg-[#0f1e30] border border-[#1a2a3a] hover:border-[#2a3a4a] rounded-xl p-5 flex items-center gap-4 transition-all"
                >
                  <div className="w-12 h-12 bg-[#0a1628] border border-[#1a2a3a] rounded-xl flex items-center justify-center text-2xl flex-shrink-0">
                    {r.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-white font-semibold text-sm">{r.label}</div>
                    <div className="text-[#4a6a8a] text-xs mt-0.5">{r.desc}</div>
                    <div className="text-[#3a5a7a] text-[10px] mt-1 font-mono uppercase">{r.fmt} format</div>
                  </div>
                  {generated.includes(r.id) && (
                    <div className="flex items-center gap-1.5 text-green-400 text-xs font-medium mr-2">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                      Downloaded
                    </div>
                  )}
                  <button
                    onClick={() => handleGenerate(r.id, r.fmt)}
                    disabled={generating === r.id}
                    className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-white text-sm font-semibold px-4 py-2.5 rounded-xl transition-all flex-shrink-0"
                  >
                    {generating === r.id ? (
                      <>
                        <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>
                        Generating…
                      </>
                    ) : (
                      <>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                        Download
                      </>
                    )}
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
