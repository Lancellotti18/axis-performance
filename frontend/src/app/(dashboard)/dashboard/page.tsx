'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { getUser, signOut } from '@/lib/auth'
import { api } from '@/lib/api'
import type { Project } from '@/types'

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

  async function handleSignOut() {
    await signOut()
    router.push('/')
  }

  function statusColor(status: string) {
    if (status === 'complete') return 'text-green-400 bg-green-500/10'
    if (status === 'processing') return 'text-yellow-400 bg-yellow-500/10'
    if (status === 'failed') return 'text-red-400 bg-red-500/10'
    return 'text-slate-400 bg-slate-500/10'
  }

  return (
    <div className="min-h-screen bg-slate-950">
      {/* Nav */}
      <nav className="border-b border-slate-800 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-8">
          <span className="text-xl font-bold text-white">BuildAI</span>
          <Link href="/dashboard" className="text-sm text-blue-400">Dashboard</Link>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-slate-400">{user?.email}</span>
          <button onClick={handleSignOut} className="text-sm text-slate-400 hover:text-white transition-colors">
            Sign out
          </button>
        </div>
      </nav>

      <main className="max-w-6xl mx-auto px-6 py-10">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-white">Projects</h1>
            <p className="text-slate-400 mt-1">{projects.length} blueprint{projects.length !== 1 ? 's' : ''} analyzed</p>
          </div>
          <Link
            href="/projects/new"
            className="bg-blue-600 hover:bg-blue-500 text-white font-semibold px-5 py-2.5 rounded-lg transition-colors text-sm"
          >
            + New Project
          </Link>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-4 mb-8">
          {[
            { label: 'Total Projects', value: projects.length },
            { label: 'Completed', value: projects.filter(p => p.status === 'complete').length },
            { label: 'Processing', value: projects.filter(p => p.status === 'processing').length },
          ].map(stat => (
            <div key={stat.label} className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <div className="text-2xl font-bold text-white">{stat.value}</div>
              <div className="text-sm text-slate-400 mt-1">{stat.label}</div>
            </div>
          ))}
        </div>

        {/* Projects table */}
        {loading ? (
          <div className="text-center py-20 text-slate-400">Loading projects...</div>
        ) : projects.length === 0 ? (
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-16 text-center">
            <div className="text-5xl mb-4">📐</div>
            <h3 className="text-lg font-semibold text-white mb-2">No projects yet</h3>
            <p className="text-slate-400 mb-6">Upload your first blueprint to get started</p>
            <Link
              href="/projects/new"
              className="inline-block bg-blue-600 hover:bg-blue-500 text-white font-semibold px-6 py-2.5 rounded-lg transition-colors"
            >
              Upload Blueprint
            </Link>
          </div>
        ) : (
          <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-800">
                  <th className="text-left text-xs font-medium text-slate-400 uppercase tracking-wider px-6 py-4">Project</th>
                  <th className="text-left text-xs font-medium text-slate-400 uppercase tracking-wider px-6 py-4">Status</th>
                  <th className="text-left text-xs font-medium text-slate-400 uppercase tracking-wider px-6 py-4">Created</th>
                  <th className="px-6 py-4"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {projects.map(project => (
                  <tr key={project.id} className="hover:bg-slate-800/50 transition-colors">
                    <td className="px-6 py-4">
                      <div className="font-medium text-white">{project.name}</div>
                      {project.description && (
                        <div className="text-sm text-slate-400 mt-0.5">{project.description}</div>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex text-xs font-medium px-2.5 py-1 rounded-full ${statusColor(project.status)}`}>
                        {project.status}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-sm text-slate-400">
                      {new Date(project.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <Link
                        href={`/projects/${project.id}`}
                        className="text-sm text-blue-400 hover:text-blue-300 transition-colors"
                      >
                        View →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  )
}
