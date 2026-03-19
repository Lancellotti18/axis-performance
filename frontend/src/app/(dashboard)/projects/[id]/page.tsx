'use client'
import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useRouter, useParams } from 'next/navigation'
import Link from 'next/link'
import { api } from '@/lib/api'
import type { ComplianceCheck, ComplianceItem, ComplianceSeverity } from '@/types'

type Tab = 'overview' | 'materials' | 'cost' | 'view3d' | 'compliance' | 'permits'
type SortMode = 'lowest_price' | 'best_value'

// Labor split by trade (fractions of total labor cost)
const LABOR_TRADE_SPLIT: Record<string, number> = {
  'Framing & Rough Carpentry': 0.222,
  'Drywall & Painting':        0.167,
  'Electrical':                0.111,
  'Plumbing':                  0.111,
  'Roofing':                   0.067,
  'Flooring':                  0.067,
  'Finishing & Trim':          0.089,
  'Concrete & Foundation':     0.089,
  'Windows & Doors':           0.044,
  'Insulation':                0.033,
}

function formatMoney(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}
function formatMoneyExact(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(n)
}

const CATEGORY_META: Record<string, { label: string; icon: string; color: string }> = {
  lumber:        { label: 'Lumber & Framing',      icon: '🪵', color: 'bg-amber-50 text-amber-700 border-amber-200' },
  sheathing:     { label: 'Sheathing & Subfloor',  icon: '📐', color: 'bg-yellow-50 text-yellow-700 border-yellow-200' },
  drywall:       { label: 'Drywall',               icon: '🧱', color: 'bg-gray-50 text-gray-700 border-gray-200' },
  insulation:    { label: 'Insulation',            icon: '🌡️', color: 'bg-orange-50 text-orange-700 border-orange-200' },
  roofing:       { label: 'Roofing',               icon: '🏠', color: 'bg-red-50 text-red-700 border-red-200' },
  concrete:      { label: 'Concrete & Foundation', icon: '⚙️', color: 'bg-slate-50 text-slate-700 border-slate-200' },
  flooring:      { label: 'Flooring',              icon: '🪟', color: 'bg-teal-50 text-teal-700 border-teal-200' },
  doors_windows: { label: 'Doors & Windows',       icon: '🚪', color: 'bg-cyan-50 text-cyan-700 border-cyan-200' },
  electrical:    { label: 'Electrical',            icon: '⚡', color: 'bg-yellow-50 text-yellow-800 border-yellow-300' },
  plumbing:      { label: 'Plumbing',              icon: '🔧', color: 'bg-blue-50 text-blue-700 border-blue-200' },
  finishing:     { label: 'Finishing Materials',   icon: '🎨', color: 'bg-purple-50 text-purple-700 border-purple-200' },
}

const SEVERITY: Record<ComplianceSeverity, { badge: string; dot: string; label: string }> = {
  required:    { badge: 'bg-red-50 text-red-600 border border-red-200',       dot: 'bg-red-500',    label: 'Required' },
  recommended: { badge: 'bg-yellow-50 text-yellow-600 border border-yellow-200', dot: 'bg-yellow-500', label: 'Recommended' },
  info:        { badge: 'bg-blue-50 text-blue-600 border border-blue-200',    dot: 'bg-blue-500',   label: 'Info' },
}
const RISK_BANNER: Record<string, string> = {
  low:    'bg-emerald-50 border-emerald-200 text-emerald-700',
  medium: 'bg-amber-50 border-amber-200 text-amber-700',
  high:   'bg-red-50 border-red-200 text-red-700',
}

// ── Isometric 3D floor plan renderer ─────────────────────────────────────────
const ISO_COLORS = [
  ['#bfdbfe','#93c5fd','#60a5fa'],
  ['#bbf7d0','#86efac','#4ade80'],
  ['#fde68a','#fcd34d','#fbbf24'],
  ['#fecdd3','#fda4af','#fb7185'],
  ['#e9d5ff','#d8b4fe','#c084fc'],
  ['#a5f3fc','#67e8f9','#22d3ee'],
  ['#fed7aa','#fdba74','#fb923c'],
  ['#d1fae5','#6ee7b7','#34d399'],
]

function Blueprint3D({ analysis }: { analysis: any }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [rotY, setRotY] = useState(Math.PI / 4)
  const [zoom, setZoom] = useState(1)
  const dragging = useRef(false)
  const lastX = useRef(0)
  const rooms: any[] = analysis?.rooms || []

  const placedRooms = useMemo(() => {
    if (!rooms.length) return []
    const sorted = [...rooms].sort((a: any, b: any) => (b.sqft || 0) - (a.sqft || 0))
    const UNIT = 0.5
    const totalSqft = sorted.reduce((s: number, r: any) => s + (r.sqft || 100), 0)
    const maxRowW = Math.sqrt(totalSqft) * UNIT * 1.3
    const placed: { room: any; x: number; z: number; w: number; d: number }[] = []
    let rowX = 0, rowZ = 0, rowMaxD = 0
    for (const room of sorted) {
      const w = (room.dimensions?.width  || Math.sqrt(room.sqft || 100)) * UNIT
      const d = (room.dimensions?.height || Math.sqrt(room.sqft || 100)) * UNIT
      if (rowX + w > maxRowW && placed.length > 0) { rowZ += rowMaxD + 0.8; rowX = 0; rowMaxD = 0 }
      placed.push({ room, x: rowX, z: rowZ, w, d })
      rowX += w + 0.4
      rowMaxD = Math.max(rowMaxD, d)
    }
    return placed
  }, [rooms])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
    if (!ctx) return
    const W = canvas.width, H = canvas.height
    ctx.clearRect(0, 0, W, H)
    const bg = ctx.createLinearGradient(0, 0, 0, H)
    bg.addColorStop(0, '#eef6ff'); bg.addColorStop(1, '#f8faff')
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H)

    if (!placedRooms.length) {
      ctx.fillStyle = '#94a3b8'; ctx.font = '14px system-ui'; ctx.textAlign = 'center'
      ctx.fillText('No room data available — run analysis first', W / 2, H / 2)
      return
    }

    const SCALE = 38 * zoom
    const WALL_H = 3.2
    const cx = W / 2, cy = H * 0.58

    function project(wx: number, wy: number, wz: number) {
      const rx = wx * Math.cos(rotY) - wz * Math.sin(rotY)
      const rz = wx * Math.sin(rotY) + wz * Math.cos(rotY)
      return { x: cx + rx * SCALE, y: cy - wy * SCALE + rz * 0.45 * SCALE }
    }

    const sorted = [...placedRooms].sort((a, b) => {
      const da = (a.x + a.w / 2) * Math.sin(rotY) + (a.z + a.d / 2) * Math.cos(rotY)
      const db = (b.x + b.w / 2) * Math.sin(rotY) + (b.z + b.d / 2) * Math.cos(rotY)
      return db - da
    })

    for (let i = 0; i < sorted.length; i++) {
      const pr = sorted[i]
      const origIdx = placedRooms.indexOf(pr)
      const colors = ISO_COLORS[origIdx % ISO_COLORS.length]
      const { x, z, w, d } = pr
      const p = [
        project(x,   0,      z),
        project(x+w, 0,      z),
        project(x+w, 0,      z+d),
        project(x,   0,      z+d),
        project(x,   WALL_H, z),
        project(x+w, WALL_H, z),
        project(x+w, WALL_H, z+d),
        project(x,   WALL_H, z+d),
      ]

      function poly(pts: {x:number,y:number}[], fill: string, stroke = 'rgba(255,255,255,0.35)') {
        ctx.beginPath()
        ctx.moveTo(pts[0].x, pts[0].y)
        for (let j = 1; j < pts.length; j++) ctx.lineTo(pts[j].x, pts[j].y)
        ctx.closePath()
        ctx.fillStyle = fill; ctx.fill()
        ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke()
      }

      // floor
      poly([p[0],p[1],p[2],p[3]], colors[0])

      const showFront = Math.cos(rotY) > 0
      const showRight = Math.sin(rotY) > 0

      // front/back wall
      if (showFront) poly([p[0],p[1],p[5],p[4]], colors[1])
      else           poly([p[3],p[2],p[6],p[7]], colors[1])

      // left/right wall
      if (showRight) poly([p[1],p[2],p[6],p[5]], colors[2])
      else           poly([p[0],p[3],p[7],p[4]], colors[2])

      // top (semi-transparent)
      ctx.globalAlpha = 0.55
      poly([p[4],p[5],p[6],p[7]], colors[0], 'rgba(100,150,255,0.4)')
      ctx.globalAlpha = 1

      // label
      const lp = project(x + w / 2, WALL_H + 0.3, z + d / 2)
      ctx.textAlign = 'center'
      ctx.fillStyle = '#1e3a5f'
      ctx.font = `bold ${Math.max(9, Math.round(11 * zoom))}px system-ui`
      ctx.fillText(pr.room.name, lp.x, lp.y)
      ctx.font = `${Math.max(7, Math.round(9 * zoom))}px system-ui`
      ctx.fillStyle = '#3b6494'
      if (pr.room.sqft) ctx.fillText(`${Math.round(pr.room.sqft)} sqft`, lp.x, lp.y + Math.round(13 * zoom))
    }

    // compass rose
    ctx.font = '11px system-ui'; ctx.fillStyle = '#94a3b8'; ctx.textAlign = 'center'
    ctx.fillText('↻ drag to rotate  ·  scroll to zoom', W / 2, H - 12)
  }, [placedRooms, rotY, zoom])

  return (
    <div className="bg-white rounded-2xl overflow-hidden" style={{ boxShadow: '0 2px 12px rgba(59,130,246,0.08)', border: '1px solid rgba(219,234,254,0.8)' }}>
      <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: 'rgba(219,234,254,0.7)' }}>
        <span className="text-slate-800 font-bold text-sm">3D Floor Plan</span>
        <div className="flex items-center gap-3">
          <button onClick={() => setRotY(r => r - Math.PI / 4)} className="text-xs text-slate-500 hover:text-blue-600 font-medium px-2 py-1 rounded-lg bg-slate-50 hover:bg-blue-50 transition-all">← Rotate</button>
          <button onClick={() => setZoom(z => Math.max(0.3, z - 0.15))} className="text-xs text-slate-500 hover:text-blue-600 font-medium px-2 py-1 rounded-lg bg-slate-50 hover:bg-blue-50 transition-all">Zoom −</button>
          <button onClick={() => setZoom(z => Math.min(3, z + 0.15))} className="text-xs text-slate-500 hover:text-blue-600 font-medium px-2 py-1 rounded-lg bg-slate-50 hover:bg-blue-50 transition-all">Zoom +</button>
          <button onClick={() => setRotY(r => r + Math.PI / 4)} className="text-xs text-slate-500 hover:text-blue-600 font-medium px-2 py-1 rounded-lg bg-slate-50 hover:bg-blue-50 transition-all">Rotate →</button>
        </div>
      </div>
      <canvas
        ref={canvasRef}
        width={860}
        height={500}
        className="w-full cursor-grab active:cursor-grabbing select-none"
        style={{ display: 'block', touchAction: 'none' }}
        onMouseDown={e => { dragging.current = true; lastX.current = e.clientX }}
        onMouseMove={e => { if (!dragging.current) return; setRotY(r => r + (e.clientX - lastX.current) * 0.012); lastX.current = e.clientX }}
        onMouseUp={() => { dragging.current = false }}
        onMouseLeave={() => { dragging.current = false }}
        onWheel={e => { e.preventDefault(); setZoom(z => Math.max(0.3, Math.min(3, z - e.deltaY * 0.001))) }}
      />
    </div>
  )
}

export default function ProjectPage() {
  const router = useRouter()
  const params = useParams()
  const projectId = params.id as string

  const [project, setProject]         = useState<any>(null)
  const [analysis, setAnalysis]       = useState<any>(null)
  const [estimate, setEstimate]       = useState<any>(null)
  const [compliance, setCompliance]   = useState<ComplianceCheck | null>(null)
  const [tab, setTab]                 = useState<Tab>('overview')
  const [loading, setLoading]         = useState(true)
  const [blueprintStatus, setBlueprintStatus] = useState('pending')
  const [markup, setMarkup]           = useState(15)
  const [expandedItem, setExpandedItem] = useState<string | null>(null)
  const [complianceFilter, setComplianceFilter] = useState<ComplianceSeverity | 'all'>('all')
  const [sortMode, setSortMode]       = useState<SortMode>('lowest_price')
  const [expandedMaterial, setExpandedMaterial] = useState<string | null>(null)
  const [categoryFilter, setCategoryFilter] = useState<string>('all')

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

  async function handleMarkupUpdate() {
    try { await api.estimates.update(projectId, { markup_pct: markup }); await loadData() } catch {}
  }

  const isProcessing = blueprintStatus === 'processing' || blueprintStatus === 'pending'
  const hasBlueprint = project?.blueprints?.length > 0
  const requiredCount = compliance?.items?.filter(i => i.severity === 'required').length ?? 0
  const recommendedCount = compliance?.items?.filter(i => i.severity === 'recommended').length ?? 0

  // ── Materials grouped by category ─────────────────────────────────────────
  const materials: any[] = estimate?.material_estimates || []
  const categoriesInData = Array.from(new Set(materials.map(m => m.category)))

  const filteredMaterials = categoryFilter === 'all'
    ? materials
    : materials.filter(m => m.category === categoryFilter)

  const byCategory: Record<string, any[]> = {}
  for (const m of filteredMaterials) {
    if (!byCategory[m.category]) byCategory[m.category] = []
    byCategory[m.category].push(m)
  }

  // ── Cost totals ────────────────────────────────────────────────────────────
  const categoryTotals: Record<string, number> = {}
  for (const m of materials) {
    categoryTotals[m.category] = (categoryTotals[m.category] || 0) + (m.total_cost || 0)
  }

  // ── Compliance grouped ─────────────────────────────────────────────────────
  const complianceByCategory: Record<string, ComplianceItem[]> = {}
  if (compliance?.items) {
    const filtered = complianceFilter === 'all' ? compliance.items : compliance.items.filter(i => i.severity === complianceFilter)
    for (const item of filtered) {
      if (!complianceByCategory[item.category]) complianceByCategory[item.category] = []
      complianceByCategory[item.category].push(item)
    }
  }

  if (loading) return (
    <div className="flex items-center justify-center h-full" style={{ background: 'linear-gradient(135deg, #eef6ff 0%, #ffffff 100%)' }}>
      <div className="flex flex-col items-center gap-3">
        <svg className="animate-spin text-blue-500" width="28" height="28" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>
        <span className="text-slate-500 text-sm">Loading project…</span>
      </div>
    </div>
  )

  const cardStyle = { boxShadow: '0 2px 12px rgba(59,130,246,0.08)', border: '1px solid rgba(219,234,254,0.8)' }
  const TABS: { id: Tab; label: string; badge?: number }[] = [
    { id: 'overview',   label: 'Overview' },
    { id: 'materials',  label: 'Materials', badge: materials.length || undefined },
    { id: 'cost',       label: 'Cost Estimate' },
    { id: 'view3d',     label: '3D View' },
    { id: 'compliance', label: 'Compliance', badge: requiredCount || undefined },
    { id: 'permits',    label: 'Permits' },
  ]

  return (
    <div className="flex flex-col h-full" style={{ background: 'linear-gradient(135deg, #eef6ff 0%, #ffffff 100%)' }}>

      {/* Header */}
      <div className="bg-white border-b px-6 py-4 flex items-center gap-4 flex-shrink-0" style={{ borderColor: 'rgba(219,234,254,0.9)' }}>
        <Link href="/projects" className="text-slate-400 hover:text-slate-700 transition-colors">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
        </Link>
        <div className="w-px h-5 bg-slate-200" />
        <div className="flex-1 min-w-0">
          <h1 className="text-slate-800 font-bold text-base truncate">{project?.name || 'Project'}</h1>
          {project?.region && <p className="text-slate-400 text-xs mt-0.5">{project.region} · {project.blueprint_type}</p>}
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full border ${
            blueprintStatus === 'complete' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' :
            blueprintStatus === 'failed'   ? 'bg-red-50 text-red-600 border-red-200' :
            'bg-amber-50 text-amber-700 border-amber-200'
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${blueprintStatus === 'complete' ? 'bg-emerald-500' : blueprintStatus === 'failed' ? 'bg-red-500' : 'bg-amber-400 animate-pulse'}`} />
            {blueprintStatus === 'complete' ? 'Analysis Complete' : blueprintStatus === 'failed' ? 'Failed' : 'Processing…'}
          </span>
          <Link href="/permits" className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-semibold px-4 py-2 rounded-xl text-sm transition-all">
            Submit Permit
          </Link>
        </div>
      </div>

      {!hasBlueprint ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="text-5xl mb-4">📐</div>
            <div className="text-slate-700 font-semibold mb-2">No blueprint uploaded</div>
            <Link href="/projects/new" className="text-blue-600 text-sm hover:text-blue-800">Upload a blueprint →</Link>
          </div>
        </div>
      ) : isProcessing ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="max-w-md text-center bg-white rounded-2xl p-10" style={cardStyle}>
            <div className="w-20 h-20 bg-blue-50 border border-blue-100 rounded-full flex items-center justify-center mx-auto mb-6">
              <svg className="animate-spin text-blue-500" width="36" height="36" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>
            </div>
            <h2 className="text-xl font-bold text-slate-800 mb-2">Analyzing Blueprint</h2>
            <p className="text-slate-500 text-sm leading-relaxed">Detecting rooms, walls, electrical, plumbing — then fetching real-time pricing for every material. This takes 60–120 seconds.</p>
            <div className="mt-6 h-1.5 bg-slate-100 rounded-full overflow-hidden">
              <div className="h-full bg-blue-500 rounded-full animate-pulse" style={{ width: '65%' }} />
            </div>
            <p className="text-slate-400 text-xs mt-3">Auto-refreshing…</p>
          </div>
        </div>
      ) : blueprintStatus === 'failed' ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center bg-white rounded-2xl p-10" style={cardStyle}>
            <div className="text-5xl mb-4">⚠️</div>
            <div className="text-slate-800 font-semibold mb-2">Analysis Failed</div>
            <div className="text-slate-500 text-sm">The AI could not process this blueprint. Please try re-uploading.</div>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">

          {/* Tab bar */}
          <div className="flex border-b bg-white px-6 flex-shrink-0" style={{ borderColor: 'rgba(219,234,254,0.9)' }}>
            {TABS.map(t => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex items-center gap-1.5 px-4 py-3.5 text-sm font-semibold border-b-2 transition-all -mb-px ${
                  tab === t.id ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-800'
                }`}
              >
                {t.label}
                {t.badge ? <span className="w-5 h-5 bg-blue-600 text-white text-[10px] font-bold rounded-full flex items-center justify-center">{t.badge > 99 ? '99+' : t.badge}</span> : null}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-y-auto p-6">

            {/* ── OVERVIEW ──────────────────────────────────────────────── */}
            {tab === 'overview' && (
              <div className="grid grid-cols-12 gap-6 max-w-6xl">
                <div className="col-span-7 space-y-4">
                  {/* Blueprint preview */}
                  <div className="bg-white rounded-2xl overflow-hidden" style={cardStyle}>
                    <div className="flex items-center justify-between px-5 py-3.5 border-b" style={{ borderColor: 'rgba(219,234,254,0.7)' }}>
                      <span className="text-slate-800 font-semibold text-sm">Blueprint</span>
                      {analysis?.confidence && (
                        <span className="text-xs text-slate-400">AI Confidence: <span className="text-emerald-600 font-semibold">{Math.round(analysis.confidence * 100)}%</span></span>
                      )}
                    </div>
                    <div className="aspect-[4/3] flex items-center justify-center relative overflow-hidden" style={{ background: 'linear-gradient(135deg, #eff6ff, #dbeafe)' }}>
                      <svg className="absolute inset-0 w-full h-full opacity-10" xmlns="http://www.w3.org/2000/svg">
                        <defs><pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M 20 0 L 0 0 0 20" fill="none" stroke="#2563eb" strokeWidth="0.5"/></pattern></defs>
                        <rect width="100%" height="100%" fill="url(#grid)" />
                      </svg>
                      {analysis?.overlay_url ? (
                        <img src={analysis.overlay_url} alt="Blueprint" className="w-full h-full object-contain" />
                      ) : (
                        <div className="text-center relative z-10">
                          <svg width="48" height="48" className="mx-auto mb-3 opacity-40" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="1" strokeLinecap="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                          <p className="text-blue-600 text-sm font-medium">Blueprint Analyzed</p>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Stats */}
                  {analysis && (
                    <div className="grid grid-cols-4 gap-3">
                      {[
                        { label: 'Total Sqft',  value: `${(analysis.total_sqft || 0).toLocaleString()}` },
                        { label: 'Rooms',       value: analysis.rooms?.length || 0 },
                        { label: 'Materials',   value: materials.length },
                        { label: 'Est. Cost',   value: estimate?.grand_total ? formatMoney(estimate.grand_total) : '—' },
                      ].map(c => (
                        <div key={c.label} className="bg-white rounded-xl p-4" style={cardStyle}>
                          <div className="text-xl font-black text-slate-800">{c.value}</div>
                          <div className="text-slate-400 text-xs mt-0.5">{c.label}</div>
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
                        <p className="text-xs opacity-80 leading-relaxed">{compliance.summary}</p>
                        <div className="flex gap-4 mt-2 text-xs opacity-60">
                          <span>{requiredCount} required actions</span>
                          <span>{recommendedCount} recommendations</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Right col */}
                <div className="col-span-5 space-y-4">
                  <div className="bg-white rounded-2xl p-5" style={cardStyle}>
                    <h3 className="text-slate-800 font-bold text-sm mb-4">Project Summary</h3>
                    <div className="space-y-1">
                      {[
                        { label: 'Type',          value: project?.blueprint_type || 'Residential' },
                        { label: 'Region',        value: project?.region || '—' },
                        { label: 'Total Area',    value: analysis?.total_sqft ? `${analysis.total_sqft.toLocaleString()} sqft` : '—' },
                        { label: 'Rooms',         value: analysis?.rooms?.length || '—' },
                        { label: 'Materials',     value: materials.length || '—' },
                        { label: 'Est. Cost',     value: estimate?.grand_total ? formatMoney(estimate.grand_total) : '—' },
                        { label: 'Labor Hours',   value: estimate?.labor_hours ? `${estimate.labor_hours.toFixed(0)} hrs` : '—' },
                        { label: 'Uploaded',      value: new Date(project?.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) },
                      ].map(row => (
                        <div key={row.label} className="flex justify-between items-center py-2 border-b last:border-0" style={{ borderColor: 'rgba(219,234,254,0.6)' }}>
                          <span className="text-slate-400 text-sm">{row.label}</span>
                          <span className="text-slate-800 text-sm font-semibold">{row.value}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {analysis?.rooms?.length > 0 && (
                    <div className="bg-white rounded-2xl p-5" style={cardStyle}>
                      <h3 className="text-slate-800 font-bold text-sm mb-3">Rooms Detected</h3>
                      <div className="space-y-1">
                        {analysis.rooms.slice(0, 6).map((room: any, i: number) => (
                          <div key={i} className="flex justify-between items-center py-2 border-b last:border-0" style={{ borderColor: 'rgba(219,234,254,0.6)' }}>
                            <span className="text-slate-700 text-sm">{room.name}</span>
                            <span className="text-blue-600 text-sm font-semibold">{room.sqft?.toLocaleString()} sqft</span>
                          </div>
                        ))}
                        {analysis.rooms.length > 6 && (
                          <button onClick={() => setTab('materials')} className="text-blue-500 text-xs mt-1 hover:text-blue-700">
                            +{analysis.rooms.length - 6} more rooms
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
              <div className="max-w-5xl">
                {/* Header + controls */}
                <div className="flex items-center justify-between mb-5">
                  <div>
                    <h2 className="text-slate-800 font-bold text-lg">Materials List</h2>
                    <p className="text-slate-400 text-xs mt-0.5">{materials.length} items across {categoriesInData.length} categories</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {/* Sort toggle */}
                    <div className="flex bg-slate-100 rounded-xl p-1">
                      {(['lowest_price', 'best_value'] as SortMode[]).map(mode => (
                        <button
                          key={mode}
                          onClick={() => setSortMode(mode)}
                          className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${sortMode === mode ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500'}`}
                        >
                          {mode === 'lowest_price' ? '💰 Lowest Price' : '⭐ Best Value'}
                        </button>
                      ))}
                    </div>
                    <button
                      onClick={() => api.reports.download(projectId, 'csv').then(({ download_url }) => window.open(download_url)).catch(() => {})}
                      className="flex items-center gap-2 bg-white border text-slate-600 text-sm font-medium px-4 py-2 rounded-xl transition-all hover:border-blue-300 hover:text-blue-600"
                      style={{ borderColor: 'rgba(219,234,254,0.9)' }}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                      Export CSV
                    </button>
                  </div>
                </div>

                {/* Category filter pills */}
                <div className="flex gap-2 flex-wrap mb-5">
                  <button
                    onClick={() => setCategoryFilter('all')}
                    className={`text-xs px-3 py-1.5 rounded-full font-semibold border transition-all ${categoryFilter === 'all' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-500 border-slate-200 hover:border-blue-300'}`}
                  >
                    All ({materials.length})
                  </button>
                  {categoriesInData.map(cat => {
                    const meta = CATEGORY_META[cat] || { label: cat, icon: '📦', color: '' }
                    const count = materials.filter(m => m.category === cat).length
                    return (
                      <button
                        key={cat}
                        onClick={() => setCategoryFilter(cat)}
                        className={`text-xs px-3 py-1.5 rounded-full font-semibold border transition-all ${categoryFilter === cat ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-500 border-slate-200 hover:border-blue-300'}`}
                      >
                        {meta.icon} {meta.label} ({count})
                      </button>
                    )
                  })}
                </div>

                {!materials.length ? (
                  <div className="bg-white rounded-2xl p-12 text-center text-slate-400" style={cardStyle}>No materials estimated yet.</div>
                ) : (
                  <div className="space-y-6">
                    {Object.entries(byCategory).map(([cat, items]) => {
                      const meta = CATEGORY_META[cat] || { label: cat, icon: '📦', color: 'bg-slate-50 text-slate-700 border-slate-200' }
                      const catTotal = items.reduce((s, m) => s + (m.total_cost || 0), 0)
                      return (
                        <div key={cat} className="bg-white rounded-2xl overflow-hidden" style={cardStyle}>
                          {/* Category header */}
                          <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: 'rgba(219,234,254,0.7)' }}>
                            <div className="flex items-center gap-3">
                              <span className="text-xl">{meta.icon}</span>
                              <span className="text-slate-800 font-bold text-sm">{meta.label}</span>
                              <span className={`text-xs px-2 py-0.5 rounded-full border font-semibold ${meta.color}`}>{items.length} items</span>
                            </div>
                            <span className="text-slate-800 font-black text-sm">{formatMoney(catTotal)}</span>
                          </div>

                          {/* Items */}
                          <div className="divide-y" style={{ borderColor: 'rgba(219,234,254,0.5)' }}>
                            {items.map((m, i) => {
                              const vendors: any[] = (() => {
                                try {
                                  return typeof m.vendor_options === 'string'
                                    ? JSON.parse(m.vendor_options)
                                    : (m.vendor_options || [])
                                } catch { return [] }
                              })()
                              const sortedVendors = sortMode === 'lowest_price'
                                ? [...vendors].sort((a, b) => a.price - b.price)
                                : vendors
                              const isExpanded = expandedMaterial === `${cat}-${i}`

                              return (
                                <div key={i}>
                                  {/* Material row */}
                                  <button
                                    className="w-full flex items-center gap-4 px-5 py-3.5 hover:bg-blue-50/40 transition-colors text-left"
                                    onClick={() => setExpandedMaterial(isExpanded ? null : `${cat}-${i}`)}
                                  >
                                    <div className="flex-1 min-w-0">
                                      <div className="text-slate-800 text-sm font-semibold">{m.item_name}</div>
                                      <div className="text-slate-400 text-xs mt-0.5">{m.quantity?.toLocaleString()} {m.unit}</div>
                                    </div>
                                    <div className="text-right flex-shrink-0">
                                      <div className="text-slate-800 font-bold text-sm">{formatMoneyExact(m.unit_cost)} / {m.unit}</div>
                                      <div className="text-blue-600 font-black text-sm">{formatMoney(m.total_cost)}</div>
                                    </div>
                                    {vendors.length > 0 && (
                                      <div className="text-xs text-blue-500 font-semibold flex-shrink-0 flex items-center gap-1">
                                        {vendors.length} sources
                                        <svg className={`transition-transform ${isExpanded ? 'rotate-180' : ''}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="6 9 12 15 18 9"/></svg>
                                      </div>
                                    )}
                                  </button>

                                  {/* Vendor options expanded */}
                                  {isExpanded && vendors.length > 0 && (
                                    <div className="px-5 pb-4 bg-slate-50/60">
                                      <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3 pt-3">Purchase Options</div>
                                      <div className="grid gap-2">
                                        {sortedVendors.map((v: any, vi: number) => (
                                          <a
                                            key={vi}
                                            href={v.url}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="flex items-center justify-between bg-white rounded-xl px-4 py-3 border hover:border-blue-300 hover:shadow-sm transition-all group"
                                            style={{ borderColor: 'rgba(219,234,254,0.9)' }}
                                            onClick={e => e.stopPropagation()}
                                          >
                                            <div className="flex items-center gap-3">
                                              {vi === 0 && sortMode === 'lowest_price' && (
                                                <span className="text-[10px] font-bold bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full">LOWEST</span>
                                              )}
                                              {vi === 0 && sortMode === 'best_value' && (
                                                <span className="text-[10px] font-bold bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">BEST VALUE</span>
                                              )}
                                              <span className="text-slate-700 text-sm font-semibold">{v.vendor}</span>
                                              {v.note && <span className="text-slate-400 text-xs">({v.note})</span>}
                                            </div>
                                            <div className="flex items-center gap-3">
                                              <span className="text-slate-800 font-black text-sm">{formatMoneyExact(v.price)}</span>
                                              <svg className="text-blue-400 opacity-0 group-hover:opacity-100 transition-opacity" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                                            </div>
                                          </a>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}

            {/* ── COST ──────────────────────────────────────────────────── */}
            {tab === 'cost' && (
              <div className="max-w-3xl">
                {!estimate ? (
                  <div className="bg-white rounded-2xl p-12 text-center text-slate-400" style={cardStyle}>No cost estimate available.</div>
                ) : (() => {
                  const matTotal   = estimate.materials_total || 0
                  const laborTotal = estimate.labor_total || 0
                  const overhead   = (matTotal + laborTotal) * 0.10
                  const markupAmt  = (matTotal + laborTotal + overhead) * ((estimate.markup_pct || 15) / 100)
                  const grand      = matTotal + laborTotal + overhead + markupAmt

                  const laborByTrade = Object.entries(LABOR_TRADE_SPLIT).map(([trade, pct]) => ({
                    trade,
                    cost: Math.round(laborTotal * pct),
                  })).sort((a, b) => b.cost - a.cost)

                  return (
                    <div className="space-y-5">
                      {/* Grand total hero */}
                      <div className="bg-blue-600 rounded-2xl p-8 text-center text-white" style={{ boxShadow: '0 8px 32px rgba(37,99,235,0.3)' }}>
                        <div className="text-blue-100 text-sm mb-1">Total Estimated Project Cost</div>
                        <div className="text-5xl font-black mb-2">{formatMoney(grand)}</div>
                        <div className="flex justify-center gap-6 text-blue-200 text-sm mt-3">
                          <span>Materials: {formatMoney(matTotal)}</span>
                          <span>·</span>
                          <span>Labor: {formatMoney(laborTotal)}</span>
                          <span>·</span>
                          <span>{estimate.region}</span>
                        </div>
                      </div>

                      {/* ── Materials by category ── */}
                      <div className="bg-white rounded-2xl overflow-hidden" style={cardStyle}>
                        <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: 'rgba(219,234,254,0.7)' }}>
                          <span className="text-slate-800 font-bold">Materials Cost by Category</span>
                          <span className="text-blue-600 font-black">{formatMoney(matTotal)}</span>
                        </div>
                        {Object.entries(categoryTotals)
                          .sort((a, b) => b[1] - a[1])
                          .map(([cat, total]) => {
                            const meta = CATEGORY_META[cat] || { label: cat, icon: '📦', color: '' }
                            const pct  = matTotal > 0 ? (total / matTotal) * 100 : 0
                            return (
                              <div key={cat} className="px-5 py-3.5 border-b last:border-0" style={{ borderColor: 'rgba(219,234,254,0.5)' }}>
                                <div className="flex justify-between items-center mb-1.5">
                                  <span className="text-slate-600 text-sm flex items-center gap-2">
                                    <span>{meta.icon}</span>{meta.label}
                                  </span>
                                  <div className="flex items-center gap-3">
                                    <span className="text-slate-400 text-xs">{pct.toFixed(1)}%</span>
                                    <span className="text-slate-800 font-bold text-sm w-20 text-right">{formatMoney(total as number)}</span>
                                  </div>
                                </div>
                                <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                                  <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
                                </div>
                              </div>
                            )
                          })}
                        <div className="px-5 py-3 flex justify-between items-center bg-blue-50/60 border-t" style={{ borderColor: 'rgba(219,234,254,0.7)' }}>
                          <span className="text-slate-600 text-sm font-bold">Materials Subtotal</span>
                          <span className="text-slate-800 font-black">{formatMoney(matTotal)}</span>
                        </div>
                      </div>

                      {/* ── Labor by trade ── */}
                      <div className="bg-white rounded-2xl overflow-hidden" style={cardStyle}>
                        <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: 'rgba(219,234,254,0.7)' }}>
                          <div>
                            <span className="text-slate-800 font-bold">Labor by Trade</span>
                            <span className="text-slate-400 text-xs ml-2">({estimate.labor_hours?.toFixed(0) || '—'} hrs estimated)</span>
                          </div>
                          <span className="text-purple-600 font-black">{formatMoney(laborTotal)}</span>
                        </div>
                        {laborByTrade.map(({ trade, cost }) => {
                          const pct = laborTotal > 0 ? (cost / laborTotal) * 100 : 0
                          return (
                            <div key={trade} className="px-5 py-3.5 border-b last:border-0" style={{ borderColor: 'rgba(219,234,254,0.5)' }}>
                              <div className="flex justify-between items-center mb-1.5">
                                <span className="text-slate-600 text-sm">👷 {trade}</span>
                                <div className="flex items-center gap-3">
                                  <span className="text-slate-400 text-xs">{pct.toFixed(1)}%</span>
                                  <span className="text-slate-800 font-bold text-sm w-20 text-right">{formatMoney(cost)}</span>
                                </div>
                              </div>
                              <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                                <div className="h-full bg-purple-400 rounded-full transition-all" style={{ width: `${pct}%` }} />
                              </div>
                            </div>
                          )
                        })}
                        <div className="px-5 py-3 flex justify-between items-center bg-purple-50/60 border-t" style={{ borderColor: 'rgba(219,234,254,0.7)' }}>
                          <span className="text-slate-600 text-sm font-bold">Labor Subtotal</span>
                          <span className="text-slate-800 font-black">{formatMoney(laborTotal)}</span>
                        </div>
                      </div>

                      {/* ── Final summary ── */}
                      <div className="bg-white rounded-2xl overflow-hidden" style={cardStyle}>
                        <div className="px-5 py-4 border-b" style={{ borderColor: 'rgba(219,234,254,0.7)' }}>
                          <span className="text-slate-800 font-bold">Project Cost Summary</span>
                        </div>
                        {[
                          { label: 'Materials',      value: matTotal,   color: 'bg-blue-500',   icon: '🪵' },
                          { label: 'Labor',          value: laborTotal, color: 'bg-purple-500', icon: '👷' },
                          { label: 'Overhead (10%)', value: overhead,   color: 'bg-slate-400',  icon: '📊' },
                          { label: `Markup (${estimate.markup_pct || 15}%)`, value: markupAmt, color: 'bg-amber-500', icon: '💼' },
                        ].map(row => (
                          <div key={row.label} className="px-5 py-3.5 border-b last:border-0 flex justify-between items-center" style={{ borderColor: 'rgba(219,234,254,0.5)' }}>
                            <span className="text-slate-600 text-sm flex items-center gap-2"><span>{row.icon}</span>{row.label}</span>
                            <span className="text-slate-800 font-bold">{formatMoney(row.value)}</span>
                          </div>
                        ))}

                        {/* Markup control */}
                        <div className="px-5 py-4 bg-slate-50/60 border-t flex items-center justify-between" style={{ borderColor: 'rgba(219,234,254,0.7)' }}>
                          <span className="text-slate-500 text-sm">Adjust Markup %</span>
                          <div className="flex items-center gap-2">
                            <input
                              type="number" min={0} max={100} value={markup}
                              onChange={e => setMarkup(Number(e.target.value))}
                              className="w-16 bg-white border rounded-lg px-2 py-1 text-sm text-slate-700 text-right focus:outline-none focus:border-blue-400"
                              style={{ borderColor: 'rgba(219,234,254,0.9)' }}
                            />
                            <span className="text-slate-400 text-sm">%</span>
                            <button onClick={handleMarkupUpdate} className="text-xs text-white bg-blue-600 hover:bg-blue-700 font-semibold px-3 py-1.5 rounded-lg transition-all">Apply</button>
                          </div>
                        </div>

                        <div className="px-5 py-5 flex justify-between items-center bg-blue-50 border-t" style={{ borderColor: 'rgba(219,234,254,0.9)' }}>
                          <span className="text-slate-800 font-black text-base">Grand Total</span>
                          <span className="text-blue-600 font-black text-2xl">{formatMoney(grand)}</span>
                        </div>
                      </div>
                    </div>
                  )
                })()}
              </div>
            )}

            {/* ── 3D VIEW ───────────────────────────────────────────────── */}
            {tab === 'view3d' && (
              <div className="max-w-5xl space-y-5">
                <div>
                  <h2 className="text-slate-800 font-bold text-lg">3D Floor Plan</h2>
                  <p className="text-slate-400 text-xs mt-0.5">
                    Isometric view built from AI-detected rooms. Drag to rotate, scroll to zoom.
                  </p>
                </div>
                {analysis ? (
                  <>
                    <Blueprint3D analysis={analysis} />
                    {analysis.rooms?.length > 0 && (
                      <div className="bg-white rounded-2xl p-5" style={{ boxShadow: '0 2px 12px rgba(59,130,246,0.08)', border: '1px solid rgba(219,234,254,0.8)' }}>
                        <h3 className="text-slate-800 font-bold text-sm mb-3">Rooms Detected</h3>
                        <div className="grid grid-cols-3 gap-3">
                          {analysis.rooms.map((room: any, i: number) => {
                            const colors = ['bg-blue-50 border-blue-200','bg-green-50 border-green-200','bg-yellow-50 border-yellow-200','bg-rose-50 border-rose-200','bg-purple-50 border-purple-200','bg-cyan-50 border-cyan-200','bg-orange-50 border-orange-200','bg-emerald-50 border-emerald-200']
                            return (
                              <div key={i} className={`rounded-xl border p-3 ${colors[i % colors.length]}`}>
                                <div className="text-slate-800 font-semibold text-sm">{room.name}</div>
                                <div className="text-slate-500 text-xs mt-0.5">{room.sqft ? `${Math.round(room.sqft)} sqft` : '—'}</div>
                                {room.dimensions && (
                                  <div className="text-slate-400 text-xs">{room.dimensions.width?.toFixed(0)}′ × {room.dimensions.height?.toFixed(0)}′</div>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="bg-white rounded-2xl p-12 text-center text-slate-400" style={{ boxShadow: '0 2px 12px rgba(59,130,246,0.08)', border: '1px solid rgba(219,234,254,0.8)' }}>
                    Run a blueprint analysis first to generate the 3D view.
                  </div>
                )}
              </div>
            )}

            {/* ── COMPLIANCE ────────────────────────────────────────────── */}
            {tab === 'compliance' && (
              <div className="max-w-3xl">
                {!compliance || compliance.status === 'not_run' ? (
                  <div className="bg-white rounded-2xl p-12 text-center" style={cardStyle}>
                    <div className="text-5xl mb-4">⚖️</div>
                    <div className="text-slate-800 font-semibold mb-2">No compliance check run</div>
                    <div className="text-slate-400 text-sm">Runs automatically when your blueprint is analyzed.</div>
                  </div>
                ) : compliance.status === 'processing' || compliance.status === 'pending' ? (
                  <div className="bg-white rounded-2xl p-12 text-center" style={cardStyle}>
                    <svg className="animate-spin text-blue-500 mx-auto mb-4" width="28" height="28" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>
                    <div className="text-slate-400 text-sm">Analyzing building codes and requirements…</div>
                  </div>
                ) : compliance.status === 'complete' ? (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className="text-slate-800 font-bold">{compliance.city ? `${compliance.city}, ` : ''}{compliance.region}</span>
                        {compliance.risk_level && (
                          <span className={`text-xs px-2.5 py-1 rounded-full font-semibold capitalize border ${RISK_BANNER[compliance.risk_level]}`}>
                            {compliance.risk_level} risk
                          </span>
                        )}
                      </div>
                      <span className="text-slate-400 text-xs">{compliance.items.length} items</span>
                    </div>
                    <div className="flex gap-2 flex-wrap">
                      {(['all', 'required', 'recommended', 'info'] as const).map(f => (
                        <button key={f} onClick={() => setComplianceFilter(f)}
                          className={`text-xs px-3 py-1.5 rounded-full font-semibold transition-all capitalize border ${complianceFilter === f ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-500 border-slate-200 hover:border-blue-300'}`}>
                          {f === 'all' ? `All (${compliance.items.length})` :
                           f === 'required' ? `Required (${requiredCount})` :
                           f === 'recommended' ? `Recommended (${recommendedCount})` :
                           `Info (${compliance.items.filter(i => i.severity === 'info').length})`}
                        </button>
                      ))}
                    </div>
                    {Object.entries(complianceByCategory).map(([category, items]) => (
                      <div key={category}>
                        <div className="flex items-center gap-2 mb-2 mt-4">
                          <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">{category}</span>
                          <span className="text-xs text-slate-300">({items.length})</span>
                        </div>
                        <div className="space-y-2">
                          {items.map(item => (
                            <div key={item.id} className="bg-white rounded-xl overflow-hidden cursor-pointer transition-all hover:shadow-sm" style={cardStyle}
                              onClick={() => setExpandedItem(expandedItem === item.id ? null : item.id)}>
                              <div className="px-4 py-3.5 flex items-start gap-3">
                                <div className={`w-2 h-2 rounded-full mt-2 flex-shrink-0 ${SEVERITY[item.severity].dot}`} />
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-start justify-between gap-3">
                                    <span className="text-slate-800 text-sm font-medium leading-snug">{item.title}</span>
                                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold flex-shrink-0 capitalize ${SEVERITY[item.severity].badge}`}>{SEVERITY[item.severity].label}</span>
                                  </div>
                                </div>
                                <svg className={`flex-shrink-0 text-slate-400 transition-transform mt-0.5 ${expandedItem === item.id ? 'rotate-180' : ''}`} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="6 9 12 15 18 9"/></svg>
                              </div>
                              {expandedItem === item.id && (
                                <div className="px-4 pb-4 border-t pt-3 space-y-3" style={{ borderColor: 'rgba(219,234,254,0.7)' }}>
                                  <p className="text-slate-500 text-sm leading-relaxed">{item.description}</p>
                                  {item.action && (
                                    <div className="bg-blue-50 border border-blue-100 rounded-xl px-4 py-3">
                                      <div className="text-[10px] font-bold text-blue-600 uppercase tracking-wider mb-1">Action Required</div>
                                      <p className="text-slate-700 text-xs">{item.action}</p>
                                    </div>
                                  )}
                                  <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-400">
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
                      <div className="text-center py-8 text-slate-400 text-sm">No items match this filter.</div>
                    )}
                  </div>
                ) : (
                  <div className="bg-white rounded-2xl p-12 text-center text-red-500" style={cardStyle}>Compliance check failed.</div>
                )}
              </div>
            )}

            {/* ── PERMITS ───────────────────────────────────────────────── */}
            {tab === 'permits' && (
              <div className="max-w-xl">
                <div className="bg-white rounded-2xl p-10 text-center" style={cardStyle}>
                  <div className="w-16 h-16 bg-blue-50 border border-blue-100 rounded-2xl flex items-center justify-center mx-auto mb-5">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="1.5" strokeLinecap="round"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 12l2 2 4-4"/></svg>
                  </div>
                  <div className="text-slate-800 font-bold text-lg mb-2">Ready to File a Permit?</div>
                  <div className="text-slate-400 text-sm mb-6 leading-relaxed">
                    Go to the Permits page to select your jurisdiction, confirm required documents, and submit your application.
                  </div>
                  <Link href="/permits" className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-bold px-6 py-3 rounded-xl text-sm transition-all">
                    Go to Permit Filing →
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
