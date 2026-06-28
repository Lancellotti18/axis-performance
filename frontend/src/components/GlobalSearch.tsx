'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getUser } from '@/lib/auth'
import { api } from '@/lib/api'
import type { Project } from '@/types'

const PAGES: { label: string; href: string }[] = [
  { label: 'Dashboard', href: '/dashboard' },
  { label: 'Projects', href: '/projects' },
  { label: 'Upload Blueprint', href: '/projects/new' },
  { label: 'Roof Report', href: '/roof-v2' },
  { label: 'Exterior Module', href: '/exterior' },
  { label: 'Material Compliance', href: '/material-check' },
  { label: 'Home Visualizer', href: '/home-visualizer' },
  { label: 'Storm Risk Report', href: '/storm-report' },
  { label: 'Training Data', href: '/training-data' },
  { label: 'CRM', href: '/crm' },
  { label: 'Reports', href: '/reports' },
  { label: 'Permits', href: '/permits' },
  { label: 'Settings', href: '/settings' },
]

type Result = { type: 'project' | 'page'; label: string; sub?: string; href: string }

export default function GlobalSearch() {
  const router = useRouter()
  const [projects, setProjects] = useState<Project[]>([])
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [idx, setIdx] = useState(0)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    getUser().then(u => { if (u) api.projects.list(u.id).then(p => setProjects((p || []) as Project[])).catch(() => {}) })
  }, [])

  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const results = useMemo<Result[]>(() => {
    const term = q.trim().toLowerCase()
    if (!term) return []
    const proj: Result[] = projects
      .filter(p => (p.name || '').toLowerCase().includes(term)
        || [p.address, p.city].filter(Boolean).join(' ').toLowerCase().includes(term))
      .slice(0, 6)
      .map(p => ({ type: 'project', label: p.name, sub: [p.address, p.city].filter(Boolean).join(', ') || undefined, href: `/projects/${p.id}` }))
    const pages: Result[] = PAGES
      .filter(pg => pg.label.toLowerCase().includes(term))
      .slice(0, 5)
      .map(pg => ({ type: 'page', label: pg.label, href: pg.href }))
    return [...proj, ...pages]
  }, [q, projects])

  function go(href: string) { setOpen(false); setQ(''); router.push(href) }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => Math.min(i + 1, results.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(i => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter') { if (results[idx]) go(results[idx].href) }
    else if (e.key === 'Escape') { setOpen(false) }
  }

  return (
    <div ref={boxRef} className="relative w-full max-w-[440px]">
      <svg className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <input
        value={q}
        onChange={e => { setQ(e.target.value); setOpen(true); setIdx(0) }}
        onFocus={() => { if (q) setOpen(true) }}
        onKeyDown={onKey}
        placeholder="Search projects & pages…"
        className="w-full rounded-xl pl-9 pr-4 py-2 text-sm text-slate-100 placeholder-slate-500 bg-white/[0.05] border border-white/10 focus:border-blue-400/40 focus:bg-white/[0.08] outline-none transition-colors"
      />

      {open && q.trim() && (
        <div className="absolute left-0 right-0 top-full mt-2 rounded-xl border border-white/10 shadow-2xl overflow-hidden z-50"
          style={{ background: 'rgba(10,16,28,0.96)', backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)' }}>
          {results.length === 0 ? (
            <div className="px-4 py-3 text-sm text-slate-500">No matches for “{q.trim()}”</div>
          ) : (
            <ul className="max-h-[360px] overflow-y-auto py-1">
              {results.map((r, i) => (
                <li key={`${r.href}-${i}`}>
                  <button
                    onMouseEnter={() => setIdx(i)}
                    onClick={() => go(r.href)}
                    className={`w-full text-left px-3.5 py-2 flex items-center gap-3 transition-colors ${i === idx ? 'bg-blue-500/15' : 'hover:bg-white/[0.04]'}`}
                  >
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg" style={{ background: 'rgba(59,130,246,0.12)', border: '1px solid rgba(96,165,250,0.22)' }}>
                      {r.type === 'project' ? (
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M3 11l9-8 9 8" /><path d="M5 10v10h14V10" /></svg>
                      ) : (
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 8v4l3 2" /></svg>
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm text-slate-100 truncate">{r.label}</span>
                      {r.sub && <span className="block text-[11px] text-slate-500 truncate">{r.sub}</span>}
                    </span>
                    <span className="ml-2 text-[9px] uppercase tracking-[0.15em] text-slate-500">{r.type}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
