'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'
import { getUser } from '@/lib/auth'
import { api } from '@/lib/api'
import type { Project } from '@/types'

// PermitPortalSection is a client component — dynamic import keeps the
// initial permits-page bundle small while reusing the production-grade
// permit flow that already lives on the projects tab.
const PermitPortalSection = dynamic(
  () => import('../projects/[id]/PermitPortalSection'),
  { ssr: false, loading: () => <LoadingCard /> }
)

function LoadingCard() {
  return (
    <div className="bg-white/[0.04] rounded-2xl p-10 flex items-center justify-center" style={{ boxShadow: '0 8px 32px rgba(0,0,0,0.30)', border: '1px solid rgba(255,255,255,0.10)' }}>
      <svg className="animate-spin text-blue-400" width="22" height="22" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>
    </div>
  )
}

export default function PermitsPage() {
  const router = useRouter()
  const [projects, setProjects] = useState<Project[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [ready, setReady] = useState(false)
  const [selectedProject, setSelectedProject] = useState('')

  useEffect(() => {
    async function load() {
      let u: Awaited<ReturnType<typeof getUser>> = null
      try {
        u = await getUser()
        if (!u) { router.push('/login'); return }
      } catch {
        router.push('/login'); return
      }
      setReady(true)
      try {
        const data = await api.projects.list(u.id).catch(() => [] as Project[])
        setProjects(data || [])
        if (data?.length) setSelectedProject(data[0].id)
      } catch {}
      setProjectsLoading(false)
    }
    load()
  }, [router])

  const project = projects.find(p => p.id === selectedProject)
  const missingLocation = project && (!project.city || !project.region)

  const cardStyle = { boxShadow: '0 8px 32px rgba(0,0,0,0.30)', border: '1px solid rgba(255,255,255,0.10)' }
  const selectCls = 'w-full bg-white/[0.06] border border-white/12 focus:border-blue-400 focus:ring-2 focus:ring-blue-500/20 rounded-xl px-3 py-2.5 text-slate-200 text-sm focus:outline-none transition-all'

  return (
    <div className="relative min-h-full" style={{ background: '#040810' }}>
      <div className="pointer-events-none absolute inset-0 opacity-[0.11]" style={{ backgroundImage: 'linear-gradient(rgba(96,165,250,1) 1.5px, transparent 1.5px), linear-gradient(90deg, rgba(96,165,250,1) 1.5px, transparent 1.5px)', backgroundSize: '34px 34px' }} />
      <div className="relative p-8 max-w-4xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-black text-white">Permit Filing</h1>
        <p className="text-slate-400 text-sm mt-1">Auto-fetch the official form for your jurisdiction, fill it from your uploads, and download a completed PDF.</p>
      </div>

      {!ready ? (
        <div className="flex items-center justify-center py-24">
          <svg className="animate-spin text-blue-400" width="24" height="24" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>
        </div>
      ) : (
        <div className="space-y-5">
          {/* Project selector */}
          <div className="bg-white/[0.04] rounded-2xl p-6 space-y-3" style={cardStyle}>
            <label className="text-slate-200 font-semibold text-sm block">Project</label>
            {projectsLoading ? (
              <div className="h-10 bg-white/[0.06] rounded-xl animate-pulse" />
            ) : projects.length === 0 ? (
              <div className="text-center py-6">
                <p className="text-slate-500 text-sm mb-3">No projects yet.</p>
                <button
                  onClick={() => router.push('/projects')}
                  className="bg-blue-600 hover:bg-blue-700 text-white font-semibold px-5 py-2 rounded-xl text-sm transition-all"
                >
                  Upload a blueprint first →
                </button>
              </div>
            ) : (
              <select
                value={selectedProject}
                onChange={e => setSelectedProject(e.target.value)}
                className={selectCls}
              >
                {projects.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.name}{p.city ? ` — ${p.city}, ${p.region?.replace('US-', '') || ''}` : ' (no location set)'}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Missing-location warning: PermitPortalSection needs city+region */}
          {missingLocation && (
            <div className="bg-amber-500/10 border border-amber-400/30 rounded-2xl p-4">
              <div className="flex items-start gap-3">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2" strokeLinecap="round" className="flex-shrink-0 mt-0.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                <div className="flex-1">
                  <div className="text-amber-200 font-bold text-sm">Project is missing its city or state</div>
                  <p className="text-amber-300/90 text-xs mt-1">We need the project&apos;s city and state to fetch the right permit form. Edit the project to add them.</p>
                  <button
                    onClick={() => router.push(`/projects/${selectedProject}`)}
                    className="mt-3 text-amber-300/90 font-semibold text-xs underline hover:text-amber-900"
                  >
                    Open project →
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Main permit flow — only once a project with a location is selected */}
          {project && !missingLocation && (
            <PermitPortalSection project={project} projectId={project.id} />
          )}
        </div>
      )}
      </div>
    </div>
  )
}
