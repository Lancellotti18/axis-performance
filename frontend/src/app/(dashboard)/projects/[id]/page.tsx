'use client'
import { useEffect, useState, useCallback } from 'react'
import { useRouter, useParams } from 'next/navigation'
import Link from 'next/link'
import { api } from '@/lib/api'
import type { ComplianceCheck, ComplianceItem, ComplianceSeverity } from '@/types'

type Tab = 'overview' | 'materials' | 'cost' | 'compliance' | 'permits'

function formatMoney(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}

const SEVERITY: Record<ComplianceSeverity, { badge: string; dot: string; label: string }> = {
  required:    { badge: 'bg-red-500/10 text-red-400 border border-red-500/20',        dot: 'bg-red-500',    label: 'Required' },
  recommended: { badge: 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/20', dot: 'bg-yellow-500', label: 'Recommended' },
  info:        { badge: 'bg-blue-500/10 text-blue-400 border border-blue-500/20',      dot: 'bg-blue-500',   label: 'Info' },
}

const RISK_BANNER: Record<string, string> = {
  low:    'bg-green-500/10 border-green-500/20 text-green-400',
  medium: 'bg-yellow-500/10 border-yellow-500/20 text-yellow-400',
  high:   'bg-red-500/10 border-red-500/20 text-red-400',
}

const CATEGORY_ICONS: Record<string, string> = {
  Licensing: '🪪', Permits: '📋', 'Contract Requirements': '📄',
  'Lien Laws': '⚖️', 'Insurance & Bonding': '🛡️', 'Building Codes': '🏗️', 'Labor Laws': '👷',
}

export default function ProjectPage() {
  const router = useRouter()
  const params = useParams()
  const projectId = params.id as string

  const [project, setProject] = useState<any>(null)
  const [analysis, setAnalysis] = useState<any>(null)
  const [estimate, setEstimate] = useState<any>(null)
  const [compliance, setCompliance] = useState<ComplianceCheck | null>(null)
  const [tab, setTab] = useState<Tab>('overview')
  const [loading, setLoading] = useState(true)
  const [blueprintStatus, setBlueprintStatus] = useState('pending')
  const [markup, setMarkup] = useState(15)
  const [expandedItem, setExpandedItem] = useState<string | null>(null)
  const [complianceFilter, setComplianceFilter] = useState<ComplianceSeverity | 'all'>('all')

  const loadData = useCallback(async () => {
    try {
      const proj = await api.projects.get(projectId)
      setProject(proj)
      const blueprints = proj.blueprints || []
      if (blueprints.length > 0) {
        const bp = blueprints[0]
        setBlueprintStatus(bp.status)
        if (bp.status === 'complete') {
          const [analysisData, estimateData] = await Promise.all([
            api.analyses.getByBlueprint(bp.id).catch(() => null),
            api.estimates.get(projectId).catch(() => null),
          ])
          setAnalysis(analysisData)
          setEstimate(estimateData)
          if (estimateData?.markup_pct) setMarkup(estimateData.markup_pct)
        }
      }
      const complianceData = await api.compliance.getForProject(projectId).catch(() => null)
      if (complianceData) setCompliance(complianceData)
    } catch (err) { console.error(err) }
    setLoading(false)
  }, [projectId])

  useEffect(() => { loadData() }, [loadData])
  useEffect(() => {
    if (blueprintStatus !== 'processing' && blueprintStatus !== 'pending') return
    const interval = setInterval(loadData, 4000)
    return () => clearInterval(interval)
  }, [blueprintStatus, loadData])
  useEffect(() => {
    if (compliance?.status !== 'processing' && compliance?.status !== 'pending') return
    const interval = setInterval(async () => {
      const data = await api.compliance.getForProject(projectId).catch(() => null)
      if (data) setCompliance(data)
    }, 5000)
    return () => clearInterval(interval)
  }, [compliance?.status, projectId])

  async function handleMarkupUpdate() {
    try { await api.estimates.update(projectId, { markup_pct: markup }); await loadData() } catch {}
  }

  const isProcessing = blueprintStatus === 'processing' || blueprintStatus === 'pending'
  const hasBlueprint = project?.blueprints?.length > 0
  const requiredCount = compliance?.items?.filter(i => i.severity === 'required').length ?? 0
  const recommendedCount = compliance?.items?.filter(i => i.severity === 'recommended').length ?? 0

  const complianceByCategory: Record<string, ComplianceItem[]> = {}
  if (compliance?.items) {
    const filtered = complianceFilter === 'all' ? compliance.items : compliance.items.filter(i => i.severity === complianceFilter)
    for (const item of filtered) {
      if (!complianceByCategory[item.category]) complianceByCategory[item.category] = []
      complianceByCategory[item.category].push(item)
    }
  }

  if (loading) return (
    <div className="flex items-center justify-center h-full">
      <div className="flex flex-col items-center gap-3">
        <svg className="animate-spin text-blue-400" width="28" height="28" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>
        <span className="text-[#4a6a8a] text-sm">Loading project…</span>
      </div>
    </div>
  )

  const TABS: { id: Tab; label: string; badge?: number }[] = [
    { id: 'overview',    label: 'Overview' },
    { id: 'materials',   label: 'Materials' },
    { id: 'cost',        label: 'Cost' },
    { id: 'compliance',  label: 'Compliance', badge: requiredCount || undefined },
    { id: 'permits',     label: 'Permits' },
  ]

  return (
    <div className="flex flex-col h-full">

      {/* ── Project Header ───────────────────────────────────────────────── */}
      <div className="bg-[#0b1626] border-b border-[#1a2a3a] px-6 py-4 flex items-center gap-4 flex-shrink-0">
        <Link href="/projects" className="text-[#4a6a8a] hover:text-white transition-colors">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
        </Link>
        <div className="w-px h-5 bg-[#1a2a3a]" />
        <div className="flex-1 min-w-0">
          <h1 className="text-white font-bold text-base truncate">{project?.name || 'Project'}</h1>
          {project?.description && <p className="text-[#4a6a8a] text-xs mt-0.5 truncate">{project.description}</p>}
        </div>

        <div className="flex items-center gap-3 flex-shrink-0">
          <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full ${
            blueprintStatus === 'complete' ? 'bg-green-500/10 text-green-400 border border-green-500/20' :
            blueprintStatus === 'failed'   ? 'bg-red-500/10 text-red-400 border border-red-500/20' :
            'bg-yellow-500/10 text-yellow-400 border border-yellow-500/20'
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${blueprintStatus === 'complete' ? 'bg-green-400' : blueprintStatus === 'failed' ? 'bg-red-400' : 'bg-yellow-400 animate-pulse'}`} />
            {blueprintStatus === 'complete' ? 'Analysis Complete' : blueprintStatus === 'failed' ? 'Failed' : 'Processing…'}
          </span>

          <Link
            href="/permits"
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white font-semibold px-4 py-2 rounded-xl text-sm transition-all hover:shadow-lg hover:shadow-blue-600/25"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 12l2 2 4-4"/></svg>
            Submit Permit
          </Link>
        </div>
      </div>

      {/* ── Content ───────────────────────────────────────────────────────── */}
      {!hasBlueprint ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="text-4xl mb-3">📐</div>
            <div className="text-white font-semibold mb-1">No blueprint uploaded</div>
            <Link href="/projects/new" className="text-blue-400 text-sm hover:text-blue-300">Upload a blueprint →</Link>
          </div>
        </div>
      ) : isProcessing ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="max-w-md text-center">
            <div className="w-20 h-20 bg-blue-500/10 border border-blue-500/20 rounded-full flex items-center justify-center mx-auto mb-6">
              <svg className="animate-spin text-blue-400" width="36" height="36" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>
            </div>
            <h2 className="text-xl font-bold text-white mb-2">Analyzing Blueprint</h2>
            <p className="text-[#4a6a8a] text-sm leading-relaxed">Detecting rooms, walls, electrical, plumbing — and generating cost estimates. This takes 30–90 seconds.</p>
            <div className="mt-6 h-1 bg-[#1a2a3a] rounded-full overflow-hidden">
              <div className="h-full bg-blue-600 rounded-full animate-pulse" style={{ width: '65%' }} />
            </div>
            <p className="text-[#3a5a7a] text-xs mt-3">Auto-refreshing every 4 seconds…</p>
          </div>
        </div>
      ) : blueprintStatus === 'failed' ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="text-4xl mb-3">⚠️</div>
            <div className="text-white font-semibold mb-1">Analysis Failed</div>
            <div className="text-[#4a6a8a] text-sm">The AI could not process this blueprint. Please try re-uploading.</div>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">

          {/* Tab bar */}
          <div className="flex border-b border-[#1a2a3a] px-6 bg-[#0b1626] flex-shrink-0">
            {TABS.map(t => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex items-center gap-1.5 px-4 py-3.5 text-sm font-semibold border-b-2 transition-all -mb-px ${
                  tab === t.id
                    ? 'border-blue-500 text-blue-400'
                    : 'border-transparent text-[#4a6a8a] hover:text-white'
                }`}
              >
                {t.label}
                {t.badge ? (
                  <span className="w-4 h-4 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center">{t.badge}</span>
                ) : null}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-y-auto p-6">

            {/* ── OVERVIEW ──────────────────────────────────────────────── */}
            {tab === 'overview' && (
              <div className="grid grid-cols-12 gap-6 max-w-6xl">
                {/* Blueprint preview */}
                <div className="col-span-7 space-y-4">
                  <div className="bg-[#0f1e30] border border-[#1a2a3a] rounded-xl overflow-hidden">
                    <div className="flex items-center justify-between px-5 py-3.5 border-b border-[#1a2a3a]">
                      <span className="text-white font-semibold text-sm">Blueprint</span>
                      {analysis?.confidence && (
                        <span className="text-xs text-[#4a6a8a]">AI Confidence: <span className="text-green-400 font-semibold">{Math.round(analysis.confidence * 100)}%</span></span>
                      )}
                    </div>
                    <div className="aspect-[4/3] bg-[#0a1628] flex items-center justify-center relative overflow-hidden">
                      <div className="absolute inset-0 opacity-10" style={{ backgroundImage: `linear-gradient(rgba(96,165,250,0.3) 1px, transparent 1px), linear-gradient(90deg, rgba(96,165,250,0.3) 1px, transparent 1px)`, backgroundSize: '20px 20px' }} />
                      {analysis?.overlay_url ? (
                        <img src={analysis.overlay_url} alt="Blueprint" className="w-full h-full object-contain" />
                      ) : (
                        <div className="text-center relative z-10">
                          <svg width="48" height="48" className="mx-auto mb-3 opacity-30" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="1" strokeLinecap="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                          <p className="text-[#4a6a8a] text-sm">Blueprint analyzed</p>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Key stats */}
                  {analysis && (
                    <div className="grid grid-cols-3 gap-3">
                      {[
                        { label: 'Total Sqft', value: `${(analysis.total_sqft || 0).toLocaleString()} sqft` },
                        { label: 'Rooms', value: analysis.rooms?.length || 0 },
                        { label: 'AI Confidence', value: `${Math.round((analysis.confidence || 0) * 100)}%` },
                      ].map(card => (
                        <div key={card.label} className="bg-[#0f1e30] border border-[#1a2a3a] rounded-xl p-4">
                          <div className="text-xl font-black text-white">{card.value}</div>
                          <div className="text-[#4a6a8a] text-xs mt-0.5">{card.label}</div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Compliance banner */}
                  {compliance?.status === 'complete' && compliance.risk_level && (
                    <div className={`flex items-start gap-3 rounded-xl border px-5 py-4 ${RISK_BANNER[compliance.risk_level]}`}>
                      <span className="text-lg mt-0.5">⚖️</span>
                      <div>
                        <div className="font-bold text-sm mb-0.5 capitalize">Compliance Risk: {compliance.risk_level}</div>
                        <p className="text-xs opacity-75 leading-relaxed">{compliance.summary}</p>
                        <div className="flex gap-4 mt-2 text-xs opacity-60">
                          <span>{requiredCount} required actions</span>
                          <span>{recommendedCount} recommendations</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Project summary */}
                <div className="col-span-5 space-y-4">
                  <div className="bg-[#0f1e30] border border-[#1a2a3a] rounded-xl p-5">
                    <h3 className="text-white font-bold text-sm mb-4">Project Summary</h3>
                    <div className="space-y-3">
                      {[
                        { label: 'Project Type', value: project?.blueprint_type || 'Residential' },
                        { label: 'Region', value: project?.region || '—' },
                        { label: 'Rooms Detected', value: analysis?.rooms?.length || '—' },
                        { label: 'Total Area', value: analysis?.total_sqft ? `${analysis.total_sqft.toLocaleString()} sqft` : '—' },
                        { label: 'Cost Estimate', value: estimate?.grand_total ? formatMoney(estimate.grand_total) : '—' },
                        { label: 'Uploaded', value: new Date(project?.created_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) },
                      ].map(row => (
                        <div key={row.label} className="flex justify-between items-center py-2 border-b border-[#1a2a3a] last:border-0">
                          <span className="text-[#4a6a8a] text-sm">{row.label}</span>
                          <span className="text-white text-sm font-medium">{row.value}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Room list preview */}
                  {analysis?.rooms?.length > 0 && (
                    <div className="bg-[#0f1e30] border border-[#1a2a3a] rounded-xl p-5">
                      <h3 className="text-white font-bold text-sm mb-3">Rooms Detected</h3>
                      <div className="space-y-2">
                        {analysis.rooms.slice(0, 5).map((room: any, i: number) => (
                          <div key={i} className="flex justify-between items-center py-2 border-b border-[#1a2a3a] last:border-0">
                            <span className="text-white text-sm">{room.name}</span>
                            <span className="text-blue-400 text-sm font-semibold">{room.sqft} sqft</span>
                          </div>
                        ))}
                        {analysis.rooms.length > 5 && (
                          <button onClick={() => setTab('overview')} className="text-[#4a6a8a] text-xs mt-1 hover:text-white transition-colors">
                            +{analysis.rooms.length - 5} more rooms
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── MATERIALS ─────────────────────────────────────────────── */}
            {tab === 'materials' && (
              <div className="max-w-3xl">
                <div className="flex items-center justify-between mb-5">
                  <h2 className="text-white font-bold">Materials List</h2>
                  <button
                    onClick={() => api.reports.download(projectId, 'csv').then(({ download_url }) => window.open(download_url))}
                    className="flex items-center gap-2 bg-[#0f1e30] hover:bg-white/5 border border-[#1a2a3a] hover:border-[#2a3a4a] text-white text-sm font-medium px-4 py-2 rounded-xl transition-all"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                    Export Materials List
                  </button>
                </div>
                {!estimate?.material_estimates?.length ? (
                  <div className="bg-[#0f1e30] border border-[#1a2a3a] rounded-xl p-12 text-center text-[#4a6a8a]">No materials estimated.</div>
                ) : (
                  <div className="bg-[#0f1e30] border border-[#1a2a3a] rounded-xl overflow-hidden">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-[#1a2a3a]">
                          {['Category', 'Item', 'Qty', 'Unit Cost', 'Total'].map(h => (
                            <th key={h} className={`text-left text-[10px] font-semibold text-[#4a6a8a] uppercase tracking-wider px-5 py-3 ${h === 'Total' ? 'text-right' : ''}`}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {estimate.material_estimates.map((m: any, i: number) => (
                          <tr key={i} className={`hover:bg-white/[0.02] transition-colors ${i < estimate.material_estimates.length - 1 ? 'border-b border-[#1a2a3a]' : ''}`}>
                            <td className="px-5 py-3.5">
                              <span className="inline-block text-[10px] font-semibold uppercase tracking-wider text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded">{m.category}</span>
                            </td>
                            <td className="px-5 py-3.5 text-white text-sm">{m.item_name}</td>
                            <td className="px-5 py-3.5 text-[#4a6a8a] text-sm">{m.quantity} {m.unit}</td>
                            <td className="px-5 py-3.5 text-[#4a6a8a] text-sm">{formatMoney(m.unit_cost)}/{m.unit}</td>
                            <td className="px-5 py-3.5 text-white font-semibold text-sm text-right">{formatMoney(m.total_cost)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* ── COST ──────────────────────────────────────────────────── */}
            {tab === 'cost' && (
              <div className="max-w-2xl">
                {!estimate ? (
                  <div className="bg-[#0f1e30] border border-[#1a2a3a] rounded-xl p-12 text-center text-[#4a6a8a]">No cost estimate available.</div>
                ) : (
                  <div className="space-y-4">
                    {/* Grand total */}
                    <div className="bg-blue-600/10 border border-blue-500/25 rounded-xl p-6 text-center">
                      <div className="text-[#4a6a8a] text-sm mb-1">Total Estimated Cost</div>
                      <div className="text-5xl font-black text-white mb-1">{formatMoney(estimate.grand_total)}</div>
                      <div className="text-[#4a6a8a] text-xs">{estimate.region} · {estimate.labor_hours?.toFixed(0)} labor hours</div>
                    </div>

                    {/* Breakdown */}
                    <div className="bg-[#0f1e30] border border-[#1a2a3a] rounded-xl overflow-hidden">
                      <div className="px-5 py-4 border-b border-[#1a2a3a]">
                        <span className="text-white font-bold text-sm">Cost Breakdown</span>
                      </div>
                      {[
                        { label: 'Materials', value: estimate.materials_total, pct: (estimate.materials_total / estimate.grand_total * 100).toFixed(0), color: 'bg-blue-500' },
                        { label: 'Labor', value: estimate.labor_total, pct: (estimate.labor_total / estimate.grand_total * 100).toFixed(0), color: 'bg-purple-500' },
                        { label: 'Overhead (10%)', value: estimate.materials_total * 0.1, pct: ((estimate.materials_total * 0.1) / estimate.grand_total * 100).toFixed(0), color: 'bg-slate-500' },
                      ].map(row => (
                        <div key={row.label} className="px-5 py-4 border-b border-[#1a2a3a] last:border-0">
                          <div className="flex justify-between items-center mb-2">
                            <span className="text-[#4a6a8a] text-sm">{row.label}</span>
                            <span className="text-white font-semibold text-sm">{formatMoney(row.value)}</span>
                          </div>
                          <div className="h-1.5 bg-[#1a2a3a] rounded-full overflow-hidden">
                            <div className={`h-full ${row.color} rounded-full`} style={{ width: `${row.pct}%` }} />
                          </div>
                          <div className="text-[#3a5a7a] text-xs mt-1">{row.pct}% of total</div>
                        </div>
                      ))}

                      {/* Markup control */}
                      <div className="px-5 py-4 bg-[#0a1628]">
                        <div className="flex items-center justify-between mb-3">
                          <span className="text-[#4a6a8a] text-sm">Contractor Markup</span>
                          <div className="flex items-center gap-2">
                            <input
                              type="number" min={0} max={100} value={markup}
                              onChange={e => setMarkup(Number(e.target.value))}
                              className="w-16 bg-[#0f1e30] border border-[#1a2a3a] rounded-lg px-2 py-1 text-sm text-white text-right focus:outline-none focus:border-blue-500/50"
                            />
                            <span className="text-[#4a6a8a] text-sm">%</span>
                            <button onClick={handleMarkupUpdate} className="text-xs text-blue-400 hover:text-blue-300 font-medium ml-1 transition-colors">Apply</button>
                          </div>
                        </div>
                        <div className="flex justify-between items-center pt-3 border-t border-[#1a2a3a]">
                          <span className="text-white font-bold">Grand Total</span>
                          <span className="text-blue-400 font-black text-xl">{formatMoney(estimate.grand_total)}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ── COMPLIANCE ────────────────────────────────────────────── */}
            {tab === 'compliance' && (
              <div className="max-w-3xl">
                {!compliance || compliance.status === 'not_run' ? (
                  <div className="bg-[#0f1e30] border border-[#1a2a3a] rounded-xl p-12 text-center">
                    <div className="text-4xl mb-3">⚖️</div>
                    <div className="text-white font-semibold mb-1">No compliance check run</div>
                    <div className="text-[#4a6a8a] text-sm">A compliance check will run automatically when your blueprint is analyzed.</div>
                  </div>
                ) : compliance.status === 'processing' || compliance.status === 'pending' ? (
                  <div className="bg-[#0f1e30] border border-[#1a2a3a] rounded-xl p-12 text-center">
                    <svg className="animate-spin text-blue-400 mx-auto mb-4" width="28" height="28" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>
                    <div className="text-[#4a6a8a] text-sm">Analyzing {compliance.region} building codes and requirements…</div>
                  </div>
                ) : compliance.status === 'complete' ? (
                  <div className="space-y-4">
                    {/* Header + filter */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className="text-white font-bold text-sm">{compliance.city ? `${compliance.city}, ` : ''}{compliance.region}</span>
                        {compliance.risk_level && (
                          <span className={`text-xs px-2.5 py-1 rounded-full font-semibold capitalize border ${RISK_BANNER[compliance.risk_level]}`}>
                            {compliance.risk_level} risk
                          </span>
                        )}
                      </div>
                      <span className="text-[#4a6a8a] text-xs">{compliance.items.length} items</span>
                    </div>

                    <div className="flex gap-2 flex-wrap">
                      {(['all', 'required', 'recommended', 'info'] as const).map(f => (
                        <button
                          key={f}
                          onClick={() => setComplianceFilter(f)}
                          className={`text-xs px-3 py-1.5 rounded-full font-semibold transition-all capitalize ${
                            complianceFilter === f ? 'bg-blue-600 text-white' : 'bg-[#0f1e30] border border-[#1a2a3a] text-[#4a6a8a] hover:text-white'
                          }`}
                        >
                          {f === 'all' ? `All (${compliance.items.length})` :
                           f === 'required' ? `Required (${requiredCount})` :
                           f === 'recommended' ? `Recommended (${recommendedCount})` :
                           `Info (${compliance.items.filter(i => i.severity === 'info').length})`}
                        </button>
                      ))}
                    </div>

                    {/* Items */}
                    {Object.entries(complianceByCategory).map(([category, items]) => (
                      <div key={category}>
                        <div className="flex items-center gap-2 mb-2 mt-4">
                          <span>{CATEGORY_ICONS[category] || '📌'}</span>
                          <span className="text-xs font-bold text-[#64748b] uppercase tracking-wider">{category}</span>
                          <span className="text-xs text-[#3a5a7a]">({items.length})</span>
                        </div>
                        <div className="space-y-2">
                          {items.map(item => (
                            <div
                              key={item.id}
                              className="bg-[#0f1e30] border border-[#1a2a3a] hover:border-[#2a3a4a] rounded-xl overflow-hidden cursor-pointer transition-all"
                              onClick={() => setExpandedItem(expandedItem === item.id ? null : item.id)}
                            >
                              <div className="px-4 py-3.5 flex items-start gap-3">
                                <div className={`w-2 h-2 rounded-full mt-2 flex-shrink-0 ${SEVERITY[item.severity].dot}`} />
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-start justify-between gap-3">
                                    <span className="text-white text-sm font-medium leading-snug">{item.title}</span>
                                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold flex-shrink-0 capitalize ${SEVERITY[item.severity].badge}`}>
                                      {SEVERITY[item.severity].label}
                                    </span>
                                  </div>
                                </div>
                                <svg className={`flex-shrink-0 text-[#4a6a8a] transition-transform mt-0.5 ${expandedItem === item.id ? 'rotate-180' : ''}`} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="6 9 12 15 18 9"/></svg>
                              </div>
                              {expandedItem === item.id && (
                                <div className="px-4 pb-4 border-t border-[#1a2a3a] pt-3 space-y-3">
                                  <p className="text-[#64748b] text-sm leading-relaxed">{item.description}</p>
                                  {item.action && (
                                    <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl px-4 py-3">
                                      <div className="text-[10px] font-bold text-blue-400 uppercase tracking-wider mb-1">Action Required</div>
                                      <p className="text-white text-xs">{item.action}</p>
                                    </div>
                                  )}
                                  <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-[#4a6a8a]">
                                    {item.deadline && <span>⏱ {item.deadline}</span>}
                                    {item.penalty && <span>⚠️ {item.penalty}</span>}
                                    {item.source && <span>📖 {item.source}</span>}
                                  </div>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                    {Object.keys(complianceByCategory).length === 0 && (
                      <div className="text-center py-8 text-[#4a6a8a] text-sm">No items match this filter.</div>
                    )}
                  </div>
                ) : (
                  <div className="bg-[#0f1e30] border border-[#1a2a3a] rounded-xl p-12 text-center text-red-400">Compliance check failed.</div>
                )}
              </div>
            )}

            {/* ── PERMITS ───────────────────────────────────────────────── */}
            {tab === 'permits' && (
              <div className="max-w-xl">
                <div className="bg-[#0f1e30] border border-[#1a2a3a] rounded-xl p-8 text-center">
                  <div className="w-14 h-14 bg-blue-600/10 border border-blue-500/20 rounded-2xl flex items-center justify-center mx-auto mb-4">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="1.5" strokeLinecap="round"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 12l2 2 4-4"/></svg>
                  </div>
                  <div className="text-white font-bold mb-2">Ready to File a Permit?</div>
                  <div className="text-[#4a6a8a] text-sm mb-6 leading-relaxed">
                    Go to the Permits page to select your jurisdiction, confirm required documents, and submit your application automatically.
                  </div>
                  <Link
                    href="/permits"
                    className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white font-bold px-6 py-3 rounded-xl text-sm transition-all hover:shadow-lg hover:shadow-blue-600/25"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 12l2 2 4-4"/></svg>
                    Go to Permit Filing
                  </Link>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
