'use client'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getUser } from '@/lib/auth'
import { api } from '@/lib/api'

const cardStyle = { boxShadow: '0 2px 12px rgba(59,130,246,0.07)', border: '1px solid rgba(219,234,254,0.8)' }

function fmt(n: any) {
  const num = parseFloat(n)
  if (isNaN(num)) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(num)
}

const SEVERITY_STYLE: Record<string, string> = {
  required:    'bg-red-50 text-red-700 border-red-200',
  recommended: 'bg-amber-50 text-amber-700 border-amber-200',
  info:        'bg-blue-50 text-blue-700 border-blue-200',
}
const SEVERITY_DOT: Record<string, string> = {
  required: 'bg-red-500', recommended: 'bg-amber-400', info: 'bg-blue-400',
}

// ── Editable field ────────────────────────────────────────────────────────────
function EditableText({ value, onSave, multiline = false, placeholder = 'Click to edit…', className = '' }: {
  value: string; onSave: (v: string) => void
  multiline?: boolean; placeholder?: string; className?: string
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft]     = useState(value)
  const ref = useRef<any>(null)

  useEffect(() => { setDraft(value) }, [value])
  useEffect(() => { if (editing) ref.current?.focus() }, [editing])

  function commit() {
    setEditing(false)
    if (draft !== value) onSave(draft)
  }

  if (editing) {
    const cls = `w-full border border-blue-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200 bg-white text-slate-700 ${className}`
    return multiline ? (
      <textarea ref={ref} value={draft} onChange={e => setDraft(e.target.value)}
        onBlur={commit} rows={4} className={cls} />
    ) : (
      <input ref={ref} value={draft} onChange={e => setDraft(e.target.value)}
        onBlur={commit} onKeyDown={e => e.key === 'Enter' && commit()} className={cls} />
    )
  }
  return (
    <div onClick={() => setEditing(true)}
      className={`group cursor-text rounded-lg px-3 py-1.5 hover:bg-blue-50/60 hover:ring-1 hover:ring-blue-200 transition-all relative ${className}`}>
      {value ? (
        <span className="text-slate-700 text-sm leading-relaxed whitespace-pre-wrap">{value}</span>
      ) : (
        <span className="text-slate-300 text-sm italic">{placeholder}</span>
      )}
      <span className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round">
          <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
          <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>
      </span>
    </div>
  )
}

// ── Section wrapper ───────────────────────────────────────────────────────────
function Section({ title, icon, children, defaultOpen = true }: {
  title: string; icon: string; children: React.ReactNode; defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="bg-white rounded-2xl overflow-hidden" style={cardStyle}>
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 px-6 py-4 text-left hover:bg-slate-50/50 transition-colors"
        style={{ borderBottom: open ? '1px solid rgba(219,234,254,0.8)' : 'none' }}>
        <span className="text-lg">{icon}</span>
        <span className="font-bold text-slate-800 text-sm flex-1">{title}</span>
        <svg className={`text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}
          width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>
      {open && <div className="px-6 py-5">{children}</div>}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function ReportsPage() {
  const router = useRouter()
  const [user, setUser]         = useState<any>(null)
  const [projects, setProjects] = useState<any[]>([])
  const [selectedId, setSelectedId] = useState<string>('')
  const [loadingProjects, setLoadingProjects] = useState(true)
  const [loadingReport, setLoadingReport]     = useState(false)
  const [reportData, setReportData] = useState<any>(null)
  const [overrides, setOverrides]   = useState<Record<string, any>>({})
  const [saving, setSaving]         = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [exporting, setExporting]   = useState(false)
  const saveTimer = useRef<any>(null)

  useEffect(() => {
    getUser().then(u => {
      if (!u) { router.push('/login'); return }
      setUser(u)
      api.projects.list(u.id).then(data => {
        const all = (data || []).filter((p: any) => !p.archived)
        setProjects(all)
        if (all.length > 0) setSelectedId(all[0].id)
      }).catch(() => {}).finally(() => setLoadingProjects(false))
    })
  }, [router])

  useEffect(() => {
    if (!selectedId) return
    setLoadingReport(true)
    setReportData(null)
    api.reports.getFull(selectedId)
      .then(data => {
        setReportData(data)
        setOverrides(data.overrides || {})
      })
      .catch(() => setReportData(null))
      .finally(() => setLoadingReport(false))
  }, [selectedId])

  function ov(key: string, fallback: any) {
    return overrides[key] !== undefined ? overrides[key] : fallback
  }

  function setOv(key: string, val: any) {
    const next = { ...overrides, [key]: val }
    setOverrides(next)
    // debounced auto-save
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      setSaving(true)
      try {
        await api.reports.saveOverrides(selectedId, next)
        setSavedFlash(true)
        setTimeout(() => setSavedFlash(false), 2000)
      } catch {}
      setSaving(false)
    }, 800)
  }

  async function handleExportPdf() {
    if (!selectedId) return
    setExporting(true)
    try {
      const blob = await api.reports.downloadPdf(selectedId)
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href     = url
      a.download = `${reportData?.project?.name || 'report'}_report.pdf`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err: any) {
      alert(err.message || 'PDF export failed.')
    }
    setExporting(false)
  }

  const project         = reportData?.project
  const analysis        = reportData?.analysis
  const materials       = reportData?.materials || []
  const cost            = reportData?.cost
  const complianceItems = reportData?.compliance_items || []
  const compliance      = reportData?.compliance
  const permitInfo      = reportData?.permit_info

  const totalMaterialCost = materials.reduce((s: number, m: any) =>
    s + parseFloat(m.total_cost || m.total || 0), 0)
  const totalCost = parseFloat(cost?.total_cost || cost?.total || 0) || totalMaterialCost

  const requiredItems = complianceItems.filter((i: any) => i.severity === 'required')
  const warnItems     = complianceItems.filter((i: any) => i.severity === 'recommended')
  const infoItems     = complianceItems.filter((i: any) => i.severity === 'info')

  return (
    <div className="min-h-screen" style={{ background: 'linear-gradient(135deg, #f0f7ff 0%, #f8faff 100%)' }}>

      {/* Top bar */}
      <div className="bg-white border-b px-6 py-4 flex items-center gap-4 sticky top-0 z-30"
        style={{ borderColor: 'rgba(219,234,254,0.9)' }}>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-black text-slate-800">Reports</h1>
          <p className="text-slate-400 text-xs mt-0.5">Build, edit, and export project reports</p>
        </div>

        {/* Save status */}
        <div className="flex items-center gap-2 text-xs">
          {saving && <span className="text-slate-400 flex items-center gap-1.5"><svg className="animate-spin" width="11" height="11" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>Saving…</span>}
          {savedFlash && !saving && <span className="text-emerald-600 flex items-center gap-1"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>Saved</span>}
        </div>

        {/* Export PDF */}
        {reportData && (
          <button onClick={handleExportPdf} disabled={exporting}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-white text-sm font-semibold transition-all disabled:opacity-50"
            style={{ background: 'linear-gradient(135deg, #7c3aed, #5b21b6)', boxShadow: '0 4px 14px rgba(124,58,237,0.25)' }}>
            {exporting ? (
              <><svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>Exporting…</>
            ) : (
              <><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Export PDF</>
            )}
          </button>
        )}
      </div>

      <div className="flex gap-0">

        {/* Project sidebar */}
        <div className="w-64 flex-shrink-0 border-r bg-white min-h-screen p-4 sticky top-[61px] self-start"
          style={{ borderColor: 'rgba(219,234,254,0.8)', maxHeight: 'calc(100vh - 61px)', overflowY: 'auto' }}>
          <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Projects</div>
          {loadingProjects ? (
            <div className="text-slate-300 text-sm text-center py-8">Loading…</div>
          ) : projects.length === 0 ? (
            <div className="text-slate-400 text-xs text-center py-8">No projects yet</div>
          ) : (
            <div className="space-y-1">
              {projects.map(p => (
                <button key={p.id} onClick={() => setSelectedId(p.id)}
                  className={`w-full text-left px-3 py-2.5 rounded-xl text-sm transition-all ${
                    selectedId === p.id
                      ? 'bg-blue-600 text-white font-semibold'
                      : 'text-slate-600 hover:bg-slate-50 hover:text-slate-800'
                  }`}>
                  <div className="truncate font-medium">{p.name}</div>
                  <div className={`text-[10px] mt-0.5 ${selectedId === p.id ? 'text-blue-200' : 'text-slate-400'}`}>
                    {new Date(p.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Report body */}
        <div className="flex-1 p-6 space-y-4 max-w-4xl">

          {loadingReport ? (
            <div className="flex items-center justify-center py-32">
              <div className="text-center">
                <svg className="animate-spin text-blue-400 mx-auto mb-3" width="28" height="28" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/>
                </svg>
                <div className="text-slate-500 text-sm">Loading report data…</div>
              </div>
            </div>
          ) : !reportData || !project ? (
            <div className="text-center py-32 text-slate-400">Select a project to view its report.</div>
          ) : (
            <>
              {/* Edit hint */}
              <div className="flex items-center gap-2 text-xs text-slate-400 bg-blue-50/60 border border-blue-100 rounded-xl px-4 py-2.5">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                Click any text field to edit it. Changes save automatically and are included in your PDF export.
              </div>

              {/* ── Project header ───────────────────────────────────────── */}
              <div className="bg-white rounded-2xl px-6 py-5" style={cardStyle}>
                <EditableText
                  value={ov('project_name', project.name || '')}
                  onSave={v => setOv('project_name', v)}
                  placeholder="Project name"
                  className="text-2xl font-black text-slate-800 !px-0 !py-0"
                />
                <div className="flex flex-wrap gap-x-5 gap-y-1 mt-2 text-xs text-slate-500">
                  {project.city && <span>📍 {[project.city, (project.region || '').replace('US-', '')].filter(Boolean).join(', ')}</span>}
                  {project.blueprint_type && <span>🏗 {project.blueprint_type.replace(/_/g,' ').replace(/\b\w/g, (c: string) => c.toUpperCase())}</span>}
                  <span>📅 {new Date(project.created_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</span>
                </div>
                {/* Summary stats */}
                <div className="grid grid-cols-3 gap-4 mt-4 pt-4 border-t" style={{ borderColor: 'rgba(219,234,254,0.8)' }}>
                  <div className="text-center">
                    <div className="text-xl font-black text-blue-600">{fmt(totalCost)}</div>
                    <div className="text-slate-400 text-xs">Total Estimate</div>
                  </div>
                  <div className="text-center">
                    <div className="text-xl font-black text-slate-700">{materials.length}</div>
                    <div className="text-slate-400 text-xs">Material Items</div>
                  </div>
                  <div className="text-center">
                    <div className={`text-xl font-black ${requiredItems.length > 0 ? 'text-red-500' : 'text-emerald-500'}`}>
                      {requiredItems.length > 0 ? `${requiredItems.length} Required` : complianceItems.length > 0 ? '✓ Compliant' : '—'}
                    </div>
                    <div className="text-slate-400 text-xs">Compliance</div>
                  </div>
                </div>
              </div>

              {/* ── Project Summary ──────────────────────────────────────── */}
              <Section title="Project Summary" icon="📋">
                <EditableText
                  value={ov('summary', project.description || analysis?.summary || '')}
                  onSave={v => setOv('summary', v)}
                  multiline
                  placeholder="Add a project summary — describe the scope, goals, and key details of this project…"
                />
                {analysis && (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4">
                    {[
                      { label: 'Floor Area',  value: analysis.total_sqft ? `${parseFloat(analysis.total_sqft).toLocaleString()} sqft` : '—' },
                      { label: 'Rooms',       value: analysis.room_count || (analysis.rooms?.length) || '—' },
                      { label: 'Confidence',  value: analysis.confidence ? `${Math.round(parseFloat(analysis.confidence) * 100)}%` : '—' },
                      { label: 'Blueprint',   value: reportData.blueprint?.file_type?.toUpperCase() || '—' },
                    ].map(m => (
                      <div key={m.label} className="bg-slate-50 rounded-xl px-4 py-3 text-center" style={{ border: '1px solid rgba(219,234,254,0.8)' }}>
                        <div className="text-slate-800 font-bold text-base">{m.value}</div>
                        <div className="text-slate-400 text-xs mt-0.5">{m.label}</div>
                      </div>
                    ))}
                  </div>
                )}
              </Section>

              {/* ── Materials List ───────────────────────────────────────── */}
              <Section title={`Materials List (${materials.length} items)`} icon="🏗️">
                {materials.length === 0 ? (
                  <div className="text-slate-400 text-sm text-center py-6">
                    No materials found. Run a blueprint analysis or add materials manually in the project page.
                  </div>
                ) : (
                  <>
                    <div className="overflow-x-auto rounded-xl" style={{ border: '1px solid rgba(219,234,254,0.8)' }}>
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="bg-slate-50" style={{ borderBottom: '1px solid rgba(219,234,254,0.8)' }}>
                            {['Item', 'Category', 'Qty', 'Unit', 'Unit Cost', 'Total'].map(h => (
                              <th key={h} className="text-left px-4 py-2.5 text-slate-500 font-semibold">{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {materials.map((m: any, i: number) => (
                            <tr key={i} className="hover:bg-blue-50/30 transition-colors" style={{ borderBottom: '1px solid rgba(219,234,254,0.4)' }}>
                              <td className="px-4 py-2.5 text-slate-700 font-medium">{m.item_name || m.name || '—'}</td>
                              <td className="px-4 py-2.5 text-slate-500 capitalize">{m.category || '—'}</td>
                              <td className="px-4 py-2.5 text-slate-600">{m.quantity || '—'}</td>
                              <td className="px-4 py-2.5 text-slate-500">{m.unit || '—'}</td>
                              <td className="px-4 py-2.5 text-slate-600">{m.unit_cost ? fmt(m.unit_cost) : '—'}</td>
                              <td className="px-4 py-2.5 text-slate-700 font-semibold">{m.total_cost || m.total ? fmt(m.total_cost || m.total) : '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          <tr className="bg-emerald-50/60" style={{ borderTop: '2px solid rgba(167,243,208,0.8)' }}>
                            <td colSpan={5} className="px-4 py-3 text-slate-700 font-bold text-right text-sm">Total</td>
                            <td className="px-4 py-3 text-emerald-700 font-black text-sm">{fmt(totalMaterialCost)}</td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                    <div className="mt-3">
                      <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Materials Notes</div>
                      <EditableText
                        value={ov('materials_notes', '')}
                        onSave={v => setOv('materials_notes', v)}
                        multiline
                        placeholder="Add any notes about the materials list — substitutions, lead times, supplier preferences…"
                      />
                    </div>
                  </>
                )}
              </Section>

              {/* ── Cost Breakdown ───────────────────────────────────────── */}
              <Section title="Projected Cost" icon="💰">
                {!cost && totalMaterialCost === 0 ? (
                  <div className="text-slate-400 text-sm text-center py-6">
                    No cost data yet. Analyze a blueprint to generate estimates.
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      {[
                        { label: 'Materials',       value: fmt(cost?.materials_cost || totalMaterialCost), color: 'text-blue-600' },
                        { label: 'Labor',           value: fmt(cost?.labor_cost || 0),                     color: 'text-violet-600' },
                        { label: 'Total Estimate',  value: fmt(totalCost),                                  color: 'text-emerald-600' },
                        { label: 'Per Sqft',        value: analysis?.total_sqft && totalCost > 0 ? fmt(totalCost / parseFloat(analysis.total_sqft)) + '/sqft' : '—', color: 'text-slate-700' },
                      ].map(m => (
                        <div key={m.label} className="bg-slate-50 rounded-xl px-4 py-3 text-center" style={{ border: '1px solid rgba(219,234,254,0.8)' }}>
                          <div className={`text-lg font-black ${m.color}`}>{m.value}</div>
                          <div className="text-slate-400 text-xs mt-0.5">{m.label}</div>
                        </div>
                      ))}
                    </div>
                    {cost?.categories && typeof cost.categories === 'object' && (
                      <div className="overflow-x-auto rounded-xl" style={{ border: '1px solid rgba(219,234,254,0.8)' }}>
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="bg-slate-50" style={{ borderBottom: '1px solid rgba(219,234,254,0.8)' }}>
                              <th className="text-left px-4 py-2.5 text-slate-500 font-semibold">Category</th>
                              <th className="text-right px-4 py-2.5 text-slate-500 font-semibold">Amount</th>
                            </tr>
                          </thead>
                          <tbody>
                            {Object.entries(cost.categories).map(([k, v]: any) => (
                              <tr key={k} className="hover:bg-blue-50/20 transition-colors" style={{ borderBottom: '1px solid rgba(219,234,254,0.4)' }}>
                                <td className="px-4 py-2.5 text-slate-700 capitalize">{k.replace(/_/g, ' ')}</td>
                                <td className="px-4 py-2.5 text-right text-slate-600 font-semibold">{fmt(v)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    <div>
                      <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Cost Notes</div>
                      <EditableText
                        value={ov('cost_notes', '')}
                        onSave={v => setOv('cost_notes', v)}
                        multiline
                        placeholder="Add cost notes — contingency budget, value engineering opportunities, price lock dates…"
                      />
                    </div>
                  </div>
                )}
              </Section>

              {/* ── Compliance ───────────────────────────────────────────── */}
              <Section title={`Code Compliance (${complianceItems.length} items)`} icon="⚖️">
                {complianceItems.length === 0 ? (
                  <div className="text-slate-400 text-sm text-center py-6">
                    No compliance check run. Go to the project page → Compliance tab to run a check.
                  </div>
                ) : (
                  <div className="space-y-4">
                    {/* Summary banner */}
                    {compliance && (
                      <div className={`rounded-xl px-4 py-3 flex items-start gap-3 ${
                        compliance.risk_level === 'high'   ? 'bg-red-50 border border-red-200' :
                        compliance.risk_level === 'medium' ? 'bg-amber-50 border border-amber-200' :
                        'bg-emerald-50 border border-emerald-200'
                      }`}>
                        <span className="text-lg mt-0.5">⚖️</span>
                        <div>
                          <div className="font-bold text-sm text-slate-800 capitalize">
                            {compliance.risk_level || 'Unknown'} Risk · {[compliance.city, compliance.region].filter(Boolean).join(', ')}
                          </div>
                          <p className="text-slate-600 text-xs mt-0.5 leading-relaxed">{compliance.summary}</p>
                        </div>
                      </div>
                    )}
                    {/* Stats */}
                    <div className="flex gap-3">
                      {[
                        { label: 'Required',    count: requiredItems.length,   cls: 'text-red-600 bg-red-50 border-red-100' },
                        { label: 'Recommended', count: warnItems.length,       cls: 'text-amber-600 bg-amber-50 border-amber-100' },
                        { label: 'Info',        count: infoItems.length,       cls: 'text-blue-600 bg-blue-50 border-blue-100' },
                      ].map(s => (
                        <div key={s.label} className={`flex-1 rounded-xl px-3 py-2.5 text-center border ${s.cls}`}>
                          <div className="font-black text-lg leading-none">{s.count}</div>
                          <div className="text-xs mt-0.5 font-semibold">{s.label}</div>
                        </div>
                      ))}
                    </div>
                    {/* Items */}
                    <div className="space-y-2">
                      {complianceItems.map((item: any) => (
                        <div key={item.id} className={`rounded-xl px-4 py-3 flex items-start gap-3 border ${SEVERITY_STYLE[item.severity] || SEVERITY_STYLE.info}`}>
                          <div className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${SEVERITY_DOT[item.severity] || SEVERITY_DOT.info}`} />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-sm font-semibold text-slate-800">{item.title}</span>
                              <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/60 font-semibold capitalize flex-shrink-0">{item.severity}</span>
                            </div>
                            {item.description && <p className="text-xs text-slate-600 mt-0.5 leading-relaxed">{item.description}</p>}
                            {item.action && <p className="text-xs font-semibold text-slate-700 mt-1">→ {item.action}</p>}
                            {item.source && <p className="text-[10px] text-slate-400 mt-1">📖 {item.source}</p>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </Section>

              {/* ── Permits ──────────────────────────────────────────────── */}
              <Section title="Permits Required" icon="📄">
                <div className="space-y-4">
                  <div className="text-sm text-slate-600 leading-relaxed">
                    Permit requirements for <strong>{[project.city, (project.region || '').replace('US-', '')].filter(Boolean).join(', ')}</strong> · {(project.blueprint_type || 'residential').replace(/_/g,' ').replace(/\b\w/g, (c: string) => c.toUpperCase())} project.
                    Always verify with your local building department before starting work.
                  </div>

                  {permitInfo ? (
                    <div className="space-y-3">
                      {permitInfo.portal_url && (
                        <div className="flex items-start gap-3 bg-blue-50 border border-blue-100 rounded-xl px-4 py-3">
                          <svg className="flex-shrink-0 mt-0.5 text-blue-500" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>
                          <div>
                            <div className="text-xs font-bold text-blue-700 mb-0.5">Permit Portal</div>
                            <a href={permitInfo.portal_url} target="_blank" rel="noopener noreferrer"
                              className="text-blue-600 text-xs hover:underline break-all">{permitInfo.portal_name || permitInfo.portal_url}</a>
                          </div>
                        </div>
                      )}
                      {permitInfo.instructions && (
                        <div className="bg-slate-50 rounded-xl px-4 py-3 border border-slate-200">
                          <div className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-1.5">Instructions</div>
                          <p className="text-slate-600 text-sm leading-relaxed">{permitInfo.instructions}</p>
                        </div>
                      )}
                      {permitInfo.form_url && (
                        <div className="flex items-center gap-3 bg-slate-50 border border-slate-200 rounded-xl px-4 py-3">
                          <svg className="flex-shrink-0 text-slate-500" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                          <div className="flex-1">
                            <div className="text-xs font-bold text-slate-500 uppercase tracking-wider">Application Form</div>
                            <a href={permitInfo.form_url} target="_blank" rel="noopener noreferrer"
                              className="text-blue-600 text-xs hover:underline break-all">{permitInfo.form_url}</a>
                          </div>
                          <a href={permitInfo.form_url} target="_blank" rel="noopener noreferrer"
                            className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-blue-50 text-blue-600 hover:bg-blue-100 transition-all flex-shrink-0">
                            View Form →
                          </a>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="bg-amber-50 border border-amber-100 rounded-xl px-4 py-3 text-amber-700 text-sm">
                      No permit data cached for this location. Go to the project's <strong>Permits tab</strong> to look up your jurisdiction's requirements — they'll appear here automatically once fetched.
                    </div>
                  )}

                  <div>
                    <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Permit Notes</div>
                    <EditableText
                      value={ov('permit_notes', '')}
                      onSave={v => setOv('permit_notes', v)}
                      multiline
                      placeholder="Add permit notes — fees, contact info, submission timeline, inspector name…"
                    />
                  </div>
                </div>
              </Section>

              {/* ── Additional Notes ─────────────────────────────────────── */}
              <Section title="Additional Notes" icon="📝" defaultOpen={false}>
                <EditableText
                  value={ov('report_notes', '')}
                  onSave={v => setOv('report_notes', v)}
                  multiline
                  placeholder="Add any additional notes, contractor details, special conditions, or next steps…"
                />
              </Section>

            </>
          )}
        </div>
      </div>
    </div>
  )
}
