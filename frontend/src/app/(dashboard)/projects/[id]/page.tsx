'use client'
import { useEffect, useState, useCallback } from 'react'
import { useRouter, useParams } from 'next/navigation'
import Link from 'next/link'
import { api } from '@/lib/api'
import type { ComplianceCheck, ComplianceItem, ComplianceSeverity } from '@/types'

type Tab = 'rooms' | 'materials' | 'costs' | 'compliance' | 'export'

function formatMoney(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}

const SEVERITY_STYLES: Record<ComplianceSeverity, { badge: string; dot: string }> = {
  required:    { badge: 'bg-red-500/10 text-red-400 border border-red-500/20',    dot: 'bg-red-500' },
  recommended: { badge: 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/20', dot: 'bg-yellow-500' },
  info:        { badge: 'bg-blue-500/10 text-blue-400 border border-blue-500/20', dot: 'bg-blue-500' },
}

const RISK_STYLES = {
  low:    'bg-green-500/10 text-green-400 border border-green-500/20',
  medium: 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/20',
  high:   'bg-red-500/10 text-red-400 border border-red-500/20',
}

const CATEGORY_ICONS: Record<string, string> = {
  'Licensing': '🪪',
  'Permits': '📋',
  'Contract Requirements': '📄',
  'Lien Laws': '⚖️',
  'Insurance & Bonding': '🛡️',
  'Building Codes': '🏗️',
  'Labor Laws': '👷',
}

export default function ProjectPage() {
  const router = useRouter()
  const params = useParams()
  const projectId = params.id as string

  const [project, setProject] = useState<any>(null)
  const [analysis, setAnalysis] = useState<any>(null)
  const [estimate, setEstimate] = useState<any>(null)
  const [compliance, setCompliance] = useState<ComplianceCheck | null>(null)
  const [tab, setTab] = useState<Tab>('rooms')
  const [loading, setLoading] = useState(true)
  const [blueprintStatus, setBlueprintStatus] = useState<string>('pending')
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

      // Always load compliance (runs independently of blueprint analysis)
      const complianceData = await api.compliance.getForProject(projectId).catch(() => null)
      if (complianceData) setCompliance(complianceData)
    } catch (err) {
      console.error(err)
    }
    setLoading(false)
  }, [projectId])

  useEffect(() => {
    loadData()
  }, [loadData])

  // Poll while blueprint processing
  useEffect(() => {
    if (blueprintStatus !== 'processing' && blueprintStatus !== 'pending') return
    const interval = setInterval(loadData, 4000)
    return () => clearInterval(interval)
  }, [blueprintStatus, loadData])

  // Poll compliance while it's processing
  useEffect(() => {
    if (compliance?.status !== 'processing' && compliance?.status !== 'pending') return
    const interval = setInterval(async () => {
      const data = await api.compliance.getForProject(projectId).catch(() => null)
      if (data) setCompliance(data)
    }, 5000)
    return () => clearInterval(interval)
  }, [compliance?.status, projectId])

  async function handleMarkupUpdate() {
    try {
      await api.estimates.update(projectId, { markup_pct: markup })
      await loadData()
    } catch {}
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="text-slate-400">Loading project...</div>
      </div>
    )
  }

  const isProcessing = blueprintStatus === 'processing' || blueprintStatus === 'pending'
  const hasBlueprint = project?.blueprints?.length > 0

  // Group compliance items by category
  const complianceByCategory: Record<string, ComplianceItem[]> = {}
  if (compliance?.items) {
    const filtered = complianceFilter === 'all'
      ? compliance.items
      : compliance.items.filter(i => i.severity === complianceFilter)
    for (const item of filtered) {
      if (!complianceByCategory[item.category]) complianceByCategory[item.category] = []
      complianceByCategory[item.category].push(item)
    }
  }

  const requiredCount = compliance?.items?.filter(i => i.severity === 'required').length ?? 0
  const recommendedCount = compliance?.items?.filter(i => i.severity === 'recommended').length ?? 0

  return (
    <div className="min-h-screen bg-slate-950">
      <nav className="border-b border-slate-800 px-6 py-4 flex items-center gap-4">
        <Link href="/dashboard" className="text-slate-400 hover:text-white transition-colors text-sm">← Dashboard</Link>
        <span className="text-slate-600">/</span>
        <span className="text-white text-sm font-medium">{project?.name || 'Project'}</span>
        {blueprintStatus && (
          <span className={`ml-auto text-xs px-2.5 py-1 rounded-full font-medium ${
            blueprintStatus === 'complete' ? 'bg-green-500/10 text-green-400' :
            blueprintStatus === 'processing' ? 'bg-yellow-500/10 text-yellow-400' :
            blueprintStatus === 'failed' ? 'bg-red-500/10 text-red-400' :
            'bg-slate-500/10 text-slate-400'
          }`}>
            {blueprintStatus}
          </span>
        )}
      </nav>

      <main className="max-w-7xl mx-auto px-6 py-8">
        {!hasBlueprint ? (
          <div className="text-center py-20">
            <p className="text-slate-400 mb-4">No blueprints uploaded yet.</p>
            <Link href="/projects/new" className="text-blue-400 hover:text-blue-300">Upload a blueprint</Link>
          </div>
        ) : isProcessing ? (
          <div className="max-w-lg mx-auto text-center py-20">
            <div className="w-20 h-20 bg-blue-500/20 rounded-full flex items-center justify-center mx-auto mb-6">
              <svg className="w-10 h-10 text-blue-400 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
              </svg>
            </div>
            <h2 className="text-xl font-semibold text-white mb-2">AI Analysis in Progress</h2>
            <p className="text-slate-400">
              The AI is analyzing your blueprint — detecting rooms, walls, electrical, plumbing, and generating estimates.
              This takes 30–90 seconds.
            </p>
            <p className="text-slate-500 text-sm mt-4">Auto-refreshing every 4 seconds...</p>
          </div>
        ) : blueprintStatus === 'failed' ? (
          <div className="text-center py-20">
            <div className="text-5xl mb-4">⚠️</div>
            <h2 className="text-xl font-semibold text-white mb-2">Analysis Failed</h2>
            <p className="text-slate-400">The AI could not process this blueprint. Please try re-uploading.</p>
          </div>
        ) : (
          <div className="grid grid-cols-12 gap-6">
            {/* Blueprint preview */}
            <div className="col-span-7">
              <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
                <div className="p-4 border-b border-slate-800 flex items-center justify-between">
                  <span className="text-sm font-medium text-white">Blueprint</span>
                  {analysis?.confidence && (
                    <span className="text-xs text-slate-400">
                      AI Confidence: <span className="text-green-400">{Math.round(analysis.confidence * 100)}%</span>
                    </span>
                  )}
                </div>
                <div className="aspect-[4/3] bg-slate-800 flex items-center justify-center">
                  {analysis?.overlay_url ? (
                    <img src={analysis.overlay_url} alt="Analyzed blueprint" className="w-full h-full object-contain" />
                  ) : (
                    <div className="text-center">
                      <div className="text-4xl mb-2">📐</div>
                      <p className="text-slate-400 text-sm">Blueprint analyzed</p>
                      <p className="text-slate-500 text-xs mt-1">Visual overlay coming soon</p>
                    </div>
                  )}
                </div>
              </div>

              {/* Summary cards */}
              {analysis && (
                <div className="grid grid-cols-3 gap-4 mt-4">
                  {[
                    { label: 'Total Sqft', value: `${analysis.total_sqft?.toLocaleString() || 0} sqft` },
                    { label: 'Rooms', value: analysis.rooms?.length || 0 },
                    { label: 'Confidence', value: `${Math.round((analysis.confidence || 0) * 100)}%` },
                  ].map(card => (
                    <div key={card.label} className="bg-slate-900 border border-slate-800 rounded-xl p-4">
                      <div className="text-lg font-bold text-white">{card.value}</div>
                      <div className="text-xs text-slate-400 mt-0.5">{card.label}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* Compliance summary banner */}
              {compliance?.status === 'complete' && compliance.risk_level && (
                <div className={`mt-4 rounded-xl border p-4 flex items-start gap-3 ${RISK_STYLES[compliance.risk_level]}`}>
                  <span className="text-xl mt-0.5">⚖️</span>
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-semibold text-sm">Compliance Risk:</span>
                      <span className="text-sm font-bold capitalize">{compliance.risk_level}</span>
                    </div>
                    <p className="text-xs opacity-80">{compliance.summary}</p>
                    <div className="flex gap-3 mt-2 text-xs">
                      <span>{requiredCount} required actions</span>
                      <span>{recommendedCount} recommendations</span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Tabs panel */}
            <div className="col-span-5">
              <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
                {/* Tab bar */}
                <div className="flex border-b border-slate-800 overflow-x-auto">
                  {(['rooms', 'materials', 'costs', 'compliance', 'export'] as Tab[]).map(t => (
                    <button
                      key={t} onClick={() => setTab(t)}
                      className={`flex-1 py-3 text-xs font-medium uppercase tracking-wider transition-colors whitespace-nowrap px-2 relative ${tab === t ? 'text-blue-400 border-b-2 border-blue-400' : 'text-slate-500 hover:text-slate-300'}`}
                    >
                      {t}
                      {t === 'compliance' && requiredCount > 0 && (
                        <span className="ml-1 inline-flex items-center justify-center w-4 h-4 bg-red-500 text-white text-[10px] rounded-full font-bold">
                          {requiredCount}
                        </span>
                      )}
                    </button>
                  ))}
                </div>

                <div className="p-4 max-h-[680px] overflow-y-auto">
                  {/* Rooms tab */}
                  {tab === 'rooms' && (
                    <div className="space-y-2">
                      {!analysis?.rooms?.length ? (
                        <p className="text-slate-400 text-sm py-4">No rooms detected.</p>
                      ) : analysis.rooms.map((room: any, i: number) => (
                        <div key={i} className="bg-slate-800 rounded-lg px-4 py-3 flex items-center justify-between">
                          <div>
                            <div className="text-sm font-medium text-white">{room.name}</div>
                            {room.dimensions && (
                              <div className="text-xs text-slate-400 mt-0.5">
                                {room.dimensions.width}&apos; × {room.dimensions.height}&apos;
                              </div>
                            )}
                          </div>
                          <div className="text-sm font-semibold text-blue-400">{room.sqft} sqft</div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Materials tab */}
                  {tab === 'materials' && (
                    <div className="space-y-2">
                      {!estimate?.material_estimates?.length ? (
                        <p className="text-slate-400 text-sm py-4">No materials estimated.</p>
                      ) : estimate.material_estimates.map((m: any, i: number) => (
                        <div key={i} className="bg-slate-800 rounded-lg px-4 py-3">
                          <div className="flex justify-between items-start">
                            <div>
                              <div className="text-xs text-slate-500 uppercase tracking-wider">{m.category}</div>
                              <div className="text-sm font-medium text-white mt-0.5">{m.item_name}</div>
                              <div className="text-xs text-slate-400 mt-0.5">{m.quantity} {m.unit} @ ${m.unit_cost}/{m.unit}</div>
                            </div>
                            <div className="text-sm font-semibold text-white">{formatMoney(m.total_cost)}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Costs tab */}
                  {tab === 'costs' && (
                    <div>
                      {!estimate ? (
                        <p className="text-slate-400 text-sm py-4">No cost estimate available.</p>
                      ) : (
                        <div className="space-y-3">
                          {[
                            { label: 'Materials', value: estimate.materials_total },
                            { label: 'Labor', value: estimate.labor_total },
                            { label: 'Overhead (10%)', value: estimate.materials_total * 0.1 },
                          ].map(row => (
                            <div key={row.label} className="flex justify-between py-2 border-b border-slate-800">
                              <span className="text-sm text-slate-400">{row.label}</span>
                              <span className="text-sm font-medium text-white">{formatMoney(row.value)}</span>
                            </div>
                          ))}

                          <div className="py-3 border-b border-slate-800">
                            <div className="flex justify-between items-center mb-2">
                              <span className="text-sm text-slate-400">Markup</span>
                              <div className="flex items-center gap-2">
                                <input
                                  type="number" min={0} max={100} value={markup}
                                  onChange={e => setMarkup(Number(e.target.value))}
                                  className="w-16 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm text-white text-right focus:outline-none focus:ring-1 focus:ring-blue-500"
                                />
                                <span className="text-slate-400 text-sm">%</span>
                                <button onClick={handleMarkupUpdate} className="text-xs text-blue-400 hover:text-blue-300 ml-1">Apply</button>
                              </div>
                            </div>
                          </div>

                          <div className="flex justify-between py-3 bg-blue-600/10 rounded-lg px-3">
                            <span className="font-semibold text-white">Total Estimate</span>
                            <span className="font-bold text-blue-400 text-lg">{formatMoney(estimate.grand_total)}</span>
                          </div>

                          <div className="text-xs text-slate-500 mt-2">
                            Region: {estimate.region} · Labor: {estimate.labor_hours?.toFixed(0)} hrs
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Compliance tab */}
                  {tab === 'compliance' && (
                    <div>
                      {!compliance || compliance.status === 'not_run' ? (
                        <div className="text-center py-8">
                          <div className="text-3xl mb-3">⚖️</div>
                          <p className="text-slate-400 text-sm">No compliance check has been run for this project.</p>
                        </div>
                      ) : compliance.status === 'processing' || compliance.status === 'pending' ? (
                        <div className="text-center py-8">
                          <svg className="w-8 h-8 text-blue-400 animate-spin mx-auto mb-3" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                          </svg>
                          <p className="text-slate-400 text-sm">Analyzing {compliance.region} laws and requirements...</p>
                          <p className="text-slate-500 text-xs mt-1">This takes about 15–30 seconds</p>
                        </div>
                      ) : compliance.status === 'failed' ? (
                        <div className="text-center py-8">
                          <p className="text-red-400 text-sm">Compliance check failed. Please try again.</p>
                        </div>
                      ) : (
                        <div className="space-y-4">
                          {/* Header */}
                          <div className="flex items-center justify-between">
                            <div>
                              <div className="text-xs text-slate-500 uppercase tracking-wider mb-1">
                                {compliance.city ? `${compliance.city}, ` : ''}{compliance.region} · {compliance.project_type}
                              </div>
                              {compliance.risk_level && (
                                <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${RISK_STYLES[compliance.risk_level]}`}>
                                  {compliance.risk_level} risk
                                </span>
                              )}
                            </div>
                            <div className="text-xs text-slate-500">
                              {compliance.items.length} items
                            </div>
                          </div>

                          {/* Filter pills */}
                          <div className="flex gap-2 flex-wrap">
                            {(['all', 'required', 'recommended', 'info'] as const).map(f => (
                              <button
                                key={f}
                                onClick={() => setComplianceFilter(f)}
                                className={`text-xs px-3 py-1 rounded-full font-medium transition-colors capitalize ${
                                  complianceFilter === f
                                    ? 'bg-blue-600 text-white'
                                    : 'bg-slate-800 text-slate-400 hover:text-white border border-slate-700'
                                }`}
                              >
                                {f === 'all' ? `All (${compliance.items.length})` :
                                  f === 'required' ? `Required (${requiredCount})` :
                                  f === 'recommended' ? `Recommended (${recommendedCount})` :
                                  `Info (${compliance.items.filter(i => i.severity === 'info').length})`}
                              </button>
                            ))}
                          </div>

                          {/* Items grouped by category */}
                          {Object.entries(complianceByCategory).map(([category, items]) => (
                            <div key={category}>
                              <div className="flex items-center gap-2 mb-2">
                                <span className="text-base">{CATEGORY_ICONS[category] || '📌'}</span>
                                <span className="text-xs font-semibold text-slate-300 uppercase tracking-wider">{category}</span>
                                <span className="text-xs text-slate-600">({items.length})</span>
                              </div>
                              <div className="space-y-2">
                                {items.map(item => (
                                  <div
                                    key={item.id}
                                    className="bg-slate-800 rounded-lg overflow-hidden cursor-pointer"
                                    onClick={() => setExpandedItem(expandedItem === item.id ? null : item.id)}
                                  >
                                    <div className="px-3 py-2.5 flex items-start gap-2.5">
                                      <div className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${SEVERITY_STYLES[item.severity].dot}`} />
                                      <div className="flex-1 min-w-0">
                                        <div className="flex items-start justify-between gap-2">
                                          <span className="text-sm font-medium text-white leading-snug">{item.title}</span>
                                          <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium flex-shrink-0 capitalize ${SEVERITY_STYLES[item.severity].badge}`}>
                                            {item.severity}
                                          </span>
                                        </div>
                                      </div>
                                    </div>

                                    {expandedItem === item.id && (
                                      <div className="px-3 pb-3 border-t border-slate-700 pt-2.5 space-y-2">
                                        <p className="text-xs text-slate-300 leading-relaxed">{item.description}</p>

                                        {item.action && (
                                          <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg px-3 py-2">
                                            <div className="text-[10px] font-semibold text-blue-400 uppercase tracking-wider mb-1">Action Required</div>
                                            <p className="text-xs text-slate-300">{item.action}</p>
                                          </div>
                                        )}

                                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-slate-500">
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
                            <p className="text-slate-500 text-sm text-center py-4">No items match this filter.</p>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Export tab */}
                  {tab === 'export' && (
                    <div className="space-y-3 py-2">
                      <p className="text-sm text-slate-400 mb-4">Download your construction report</p>
                      {['pdf', 'excel', 'csv'].map(fmt => (
                        <button
                          key={fmt}
                          onClick={() => api.reports.download(projectId, fmt).then(({ download_url }) => window.open(download_url))}
                          className="w-full bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg px-4 py-3 text-left flex items-center justify-between transition-colors"
                        >
                          <div>
                            <div className="text-sm font-medium text-white uppercase">{fmt}</div>
                            <div className="text-xs text-slate-400 mt-0.5">
                              {fmt === 'pdf' ? 'Full report with charts' : fmt === 'excel' ? 'Spreadsheet breakdown' : 'Raw data export'}
                            </div>
                          </div>
                          <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                          </svg>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
