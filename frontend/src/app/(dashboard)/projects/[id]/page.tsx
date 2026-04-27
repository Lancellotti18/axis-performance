'use client'
import React from 'react'
import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useRouter, useParams } from 'next/navigation'
import Link from 'next/link'
import { api } from '@/lib/api'
import { createLogger, describeError } from '@/lib/logger'
import toast from 'react-hot-toast'
import type { ComplianceCheck, ComplianceItem, ComplianceSeverity } from '@/types'

const log = createLogger('ProjectPage')
import dynamic from 'next/dynamic'
const RenderViewer      = dynamic(() => import('./RenderViewer'),      { ssr: false })
const ExteriorCarousel  = dynamic(() => import('./ExteriorCarousel'),  { ssr: false })
import RoofingSection from './RoofingSection'
import PermitPortalSection from './PermitPortalSection'
import { computeMaterialConfidence, loadReviewedIds, saveReviewedIds } from './materialConfidence'
const ExteriorCaptureWizard = dynamic(() => import('./ExteriorCaptureWizard'), { ssr: false })
const PhotoLightbox = dynamic(() => import('./PhotoLightbox'), { ssr: false })
const PhotoMapView = dynamic(() => import('./PhotoMapView'), { ssr: false })

// Images are base64 data URIs from backend — no staggering needed
function StaggeredRender({ src, label, totalSqft }: { src: string; label: string; totalSqft?: number }) {
  return <RenderViewer src={src} label={label} totalSqft={totalSqft} />
}

type Tab = 'overview' | 'materials' | 'cost' | 'view3d' | 'photos' | 'compliance' | 'permits' | 'roofing'
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
const STATUS_BADGE: Record<string, { badge: string; label: string }> = {
  pass:   { badge: 'bg-emerald-50 text-emerald-700 border border-emerald-200', label: 'Pass' },
  review: { badge: 'bg-amber-50 text-amber-700 border border-amber-200',       label: 'Review' },
  fail:   { badge: 'bg-red-100 text-red-700 border border-red-300',            label: 'Fail' },
}
const TIER_BADGE: Record<string, { badge: string; label: string }> = {
  municipal: { badge: 'bg-violet-50 text-violet-700 border border-violet-200', label: 'Municipal' },
  county:    { badge: 'bg-indigo-50 text-indigo-700 border border-indigo-200', label: 'County' },
  state:     { badge: 'bg-sky-50 text-sky-700 border border-sky-200',          label: 'State' },
  base_code: { badge: 'bg-slate-50 text-slate-600 border border-slate-200',    label: 'Base Code' },
}
const RISK_BANNER: Record<string, string> = {
  low:    'bg-emerald-50 border-emerald-200 text-emerald-700',
  medium: 'bg-amber-50 border-amber-200 text-amber-700',
  high:   'bg-red-50 border-red-200 text-red-700',
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
  const [blueprintError, setBlueprintError] = useState<string | null>(null)
  const [blueprintId, setBlueprintId] = useState<string | null>(null)
  const [markup, setMarkup]           = useState(15)
  const [expandedItem, setExpandedItem] = useState<string | null>(null)
  const [complianceFilter, setComplianceFilter] = useState<ComplianceSeverity | 'all'>('all')
  const [sortMode, setSortMode]       = useState<SortMode>('lowest_price')
  const [expandedMaterial, setExpandedMaterial] = useState<string | null>(null)
  const [categoryFilter, setCategoryFilter] = useState<string>('all')
  const [editingMaterial, setEditingMaterial] = useState<string | null>(null)  // material id being edited
  const [editDraft, setEditDraft] = useState<any>({})  // draft values for editing
  const [materialChanges, setMaterialChanges] = useState<Record<string, any>>({})  // pending changes keyed by id
  const [savingMaterials, setSavingMaterials] = useState(false)
  const [searchingPrices, setSearchingPrices] = useState<string | null>(null)  // item id searching
  const [addingMaterial, setAddingMaterial] = useState(false)
  const [newMaterial, setNewMaterial] = useState({ item_name: '', category: 'lumber', quantity: 0, unit: 'each', unit_cost: 0 })
  // Materials compliance check
  const [matCheckLoading, setMatCheckLoading] = useState(false)
  const [matCheckResult, setMatCheckResult] = useState<any>(null)
  const [matCheckError, setMatCheckError] = useState<string | null>(null)
  const [refreshingPrices, setRefreshingPrices] = useState(false)
  const [refreshPricesResult, setRefreshPricesResult] = useState<string | null>(null)
  // Blueprint takeoff (Togal-style quantity extraction)
  const [takeoffLoading, setTakeoffLoading] = useState(false)
  const [takeoffApplying, setTakeoffApplying] = useState(false)
  const [takeoffData, setTakeoffData] = useState<Awaited<ReturnType<typeof api.blueprints.takeoff>> | null>(null)
  const [takeoffOpen, setTakeoffOpen] = useState(false)
  // Material-confidence review state. Tracks which low-confidence rows the
  // user has explicitly confirmed, so their amber chips go away.
  const [reviewedMaterials, setReviewedMaterials] = useState<Set<string>>(new Set())
  const [reviewFilterOnly, setReviewFilterOnly] = useState(false)

  // Photos tab
  const [photos, setPhotos] = useState<any[]>([])
  const [photosLoading, setPhotosLoading] = useState(false)
  const [photoPhase, setPhotoPhase] = useState<'all' | 'before' | 'during' | 'after'>('all')
  const [uploadingPhoto, setUploadingPhoto] = useState(false)
  const [selectedPhoto, setSelectedPhoto] = useState<any>(null)
  const [showCaptureWizard, setShowCaptureWizard] = useState(false)
  const [damageReportLoading, setDamageReportLoading] = useState(false)
  const [damageReportError, setDamageReportError] = useState<string | null>(null)
  const [photoViewMode, setPhotoViewMode] = useState<'grid' | 'map'>('grid')
  // Job costing (actual spend per category, stored in localStorage)
  const [actualCosts, setActualCosts] = useState<Record<string, number>>({})
  // Blueprint signed URL for display
  const [blueprintViewUrl, setBlueprintViewUrl] = useState<string | null>(null)
  const [blueprintFileType, setBlueprintFileType] = useState<string>('')
  // Proposal modal
  const [showProposal, setShowProposal] = useState(false)
  // Photo-to-Measurements
  const [photoMeasureLoading, setPhotoMeasureLoading] = useState(false)
  const [photoMeasureResult, setPhotoMeasureResult] = useState<any>(null)
  const [photoMeasureError, setPhotoMeasureError] = useState<string | null>(null)
  // Hail/Wind Risk Score
  // Aerial Roof Report
  // EagleView-style roof outline editor
  // Quote Request modal
  const [quoteModal, setQuoteModal] = useState<{ vendor: string; url: string; items: any[] } | null>(null)
  const [quoteForm, setQuoteForm] = useState({ name: '', company: '', phone: '', email: '', branch: '', notes: '' })
  const [quoteGenerated, setQuoteGenerated] = useState(false)
  const [quoteCopied, setQuoteCopied] = useState(false)
  // 3D Model
  // scene3d state removed — floor plan viewer removed

  // AI Renders
  const [renderStyle, setRenderStyle] = useState('modern')
  const [renderTimeOfDay, setRenderTimeOfDay] = useState('golden_hour')
  const [renderUserContext, setRenderUserContext] = useState('')
  const [renderLoading, setRenderLoading] = useState(false)
  const [renderError, setRenderError] = useState<string | null>(null)
  const [renders, setRenders] = useState<{
    exterior_views: { angle: string; label: string; url: string | null }[]
    room_renders:   { name: string; url: string | null }[]
  } | null>(null)

  // AXIS Performance 5D pipeline
  const [axisJobId, setAxisJobId]       = useState<string | null>(null)
  const [axisStatus, setAxisStatus]     = useState<'idle' | 'queued' | 'running_3d' | 'running_5d' | 'queued_cloud' | 'complete' | 'error'>('idle')
  const [axisResults, setAxisResults]   = useState<any>(null)
  const [axisError, setAxisError]       = useState<string | null>(null)
  const [axisElapsed, setAxisElapsed]   = useState(0)
  const axisPollerRef = useRef<NodeJS.Timeout | null>(null)
  // AXIS settings
  const [axisTradeType, setAxisTradeType] = useState('General Construction')
  const [axisTier, setAxisTier]           = useState<'economy' | 'standard' | 'premium'>('standard')
  const [axisCloudGpu, setAxisCloudGpu]   = useState(false)
  // Proposal generation
  const [proposalLoading, setProposalLoading] = useState(false)
  const [proposalError, setProposalError]     = useState<string | null>(null)
  // Editable line items (from AXIS materials)
  const [axisLineItems, setAxisLineItems]     = useState<any[]>([])
  const [lineItemsEdited, setLineItemsEdited] = useState(false)
  // AXIS results tabs + source popovers
  const [axisTab, setAxisTab] = useState<'overview'|'costs'|'schedule'|'materials'|'insights'>('overview')
  const [openSources, setOpenSources] = useState<Set<string>>(new Set())
  const toggleSource = (key: string) => setOpenSources(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n })

  const loadData = useCallback(async () => {
    try {
      const proj = await api.projects.get(projectId)
      setProject(proj)
      const blueprints = proj.blueprints || []
      if (blueprints.length > 0) {
        const bp = blueprints[0]
        setBlueprintStatus(bp.status)
        if (bp.error_message) setBlueprintError(bp.error_message)
        if (bp.id) setBlueprintId(bp.id)
        if (bp.id) {
          // Backend proxy URL — streams the file server-side with service role auth
          setBlueprintViewUrl(api.blueprints.viewUrl(bp.id))
          setBlueprintFileType(bp.file_type || '')
        }
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
      // Load photos
      try {
        const photoData = await api.photos.list(projectId)
        setPhotos(photoData || [])
      } catch (err) {
        log.warn('photos.list failed', err)
      }
    } catch (err) {
      log.error('loadData', err)
      toast.error(`Could not load project: ${describeError(err)}`)
    }
    setLoading(false)
  }, [projectId])

  useEffect(() => { loadData() }, [loadData])
  // Wake Render free tier as soon as the page loads so it's ready when the user clicks Generate
  useEffect(() => {
    fetch('https://build-backend-jcp9.onrender.com/health').catch(() => {})
  }, [])
  useEffect(() => {
    if (blueprintStatus !== 'processing' && blueprintStatus !== 'pending') return
    if (!blueprintId) return
    const interval = setInterval(async () => {
      try {
        const s = await api.blueprints.getStatus(blueprintId)
        if (s.status !== blueprintStatus) {
          setBlueprintStatus(s.status)
          if (s.error_message) setBlueprintError(s.error_message)
          // If just completed, do a full reload to get analysis data
          if (s.status === 'complete') loadData()
        }
      } catch {}
    }, 3000)
    return () => clearInterval(interval)
  }, [blueprintStatus, blueprintId, loadData])
  useEffect(() => {
    if (!projectId) return
    const saved = localStorage.getItem(`job_costs_${projectId}`)
    if (saved) { try { setActualCosts(JSON.parse(saved)) } catch {} }
    setReviewedMaterials(loadReviewedIds(projectId))
  }, [projectId])

  function toggleReviewed(materialId: string) {
    if (!materialId) return
    setReviewedMaterials(prev => {
      const next = new Set(prev)
      if (next.has(materialId)) next.delete(materialId)
      else next.add(materialId)
      saveReviewedIds(projectId, next)
      return next
    })
  }

  async function handleMarkupUpdate() {
    try {
      await api.estimates.update(projectId, { markup_pct: markup })
      await loadData()
      toast.success('Markup updated')
    } catch (err) {
      log.error('handleMarkupUpdate', err)
      toast.error(`Could not update markup: ${describeError(err)}`)
    }
  }

  async function handleSaveMaterials() {
    if (Object.keys(materialChanges).length === 0) return
    setSavingMaterials(true)
    try {
      await Promise.all(
        Object.entries(materialChanges).map(([id, changes]) =>
          api.materials.update(projectId, id, changes)
        )
      )
      setMaterialChanges({})
      await loadData()
      toast.success('Materials saved')
    } catch (err) {
      log.error('handleSaveMaterials', err)
      toast.error(`Could not save materials: ${describeError(err)}`)
    }
    setSavingMaterials(false)
  }

  async function handleLoadTakeoff() {
    if (!blueprintId) {
      toast.error('Upload a blueprint first')
      return
    }
    setTakeoffLoading(true)
    setTakeoffOpen(true)
    try {
      const data = await api.blueprints.takeoff(blueprintId)
      setTakeoffData(data)
    } catch (err) {
      log.error('handleLoadTakeoff', err)
      toast.error(`Takeoff failed: ${describeError(err)}`)
      setTakeoffOpen(false)
    }
    setTakeoffLoading(false)
  }

  async function handleApplyTakeoff() {
    if (!blueprintId) return
    setTakeoffApplying(true)
    try {
      const res = await api.blueprints.applyTakeoff(blueprintId)
      toast.success(`Added ${res.rows_added} takeoff rows to materials`)
      setTakeoffOpen(false)
      await loadData()
    } catch (err) {
      log.error('handleApplyTakeoff', err)
      toast.error(`Could not apply takeoff: ${describeError(err)}`)
    }
    setTakeoffApplying(false)
  }

  async function handleDeleteMaterial(id: string) {
    try {
      await api.materials.delete(projectId, id)
      await loadData()
    } catch (err) {
      log.error('handleDeleteMaterial', err)
      toast.error(`Could not delete material: ${describeError(err)}`)
    }
  }

  async function handleAddMaterial() {
    if (!newMaterial.item_name.trim()) return
    try {
      await api.materials.add(projectId, {
        ...newMaterial,
        total_cost: newMaterial.quantity * newMaterial.unit_cost,
      })
      setAddingMaterial(false)
      setNewMaterial({ item_name: '', category: 'lumber', quantity: 0, unit: 'each', unit_cost: 0 })
      await loadData()
      toast.success('Material added')
    } catch (err) {
      log.error('handleAddMaterial', err)
      toast.error(`Could not add material: ${describeError(err)}`)
    }
  }

  async function handleSearchPrices(material: any, overrides?: { item_name?: string; category?: string }) {
    setSearchingPrices(material.id)
    try {
      const itemName = overrides?.item_name || material.item_name
      const category = overrides?.category || material.category
      const result = await api.materials.searchPrices({
        item_name: itemName,
        category: category,
        unit_cost: material.unit_cost,
        region: project?.region || 'US-TX',
        city: project?.city || '',
      })
      if (result?.options) {
        // Update vendor_options in local estimate state immediately
        setEstimate((prev: any) => {
          if (!prev) return prev
          return {
            ...prev,
            material_estimates: (prev.material_estimates || []).map((m: any) =>
              m.id === material.id ? { ...m, vendor_options: result.options, item_name: itemName } : m
            ),
          }
        })
      }
    } catch (err) {
      log.error('handleSearchPrices', err)
      toast.error(`Price search failed: ${describeError(err)}`)
    }
    setSearchingPrices(null)
  }

  async function handleRefreshAllPrices() {
    setRefreshingPrices(true)
    setRefreshPricesResult(null)
    try {
      const result = await api.materials.refreshAllPrices(projectId)
      setRefreshPricesResult(`Updated ${result.updated} item${result.updated !== 1 ? 's' : ''}`)
      // Reload estimate from DB to get updated prices
      const estimateData = await api.estimates.get(projectId).catch(() => null)
      if (estimateData) setEstimate(estimateData)
    } catch (err: any) {
      setRefreshPricesResult('Refresh failed — try again')
    }
    setRefreshingPrices(false)
    setTimeout(() => setRefreshPricesResult(null), 4000)
  }

  async function handleMaterialsComplianceCheck() {
    setMatCheckLoading(true)
    setMatCheckError(null)
    setMatCheckResult(null)
    try {
      const result = await api.compliance.checkMaterials(projectId)
      setMatCheckResult(result)
      // Auto-scroll to compliance tab if not already there
      setTab('compliance')
    } catch (err: any) {
      setMatCheckError(err.message || 'Compliance check failed.')
    }
    setMatCheckLoading(false)
  }

  async function handlePhotoMeasure() {
    setPhotoMeasureLoading(true)
    setPhotoMeasureError(null)
    setPhotoMeasureResult(null)
    try {
      const result = await api.photos.measure(projectId)
      setPhotoMeasureResult(result)
    } catch (err: any) {
      setPhotoMeasureError(err.message || 'Measurement analysis failed.')
    }
    setPhotoMeasureLoading(false)
  }

  function openQuoteModal(vendor: string, url: string) {
    const allItems = estimate?.material_estimates || []
    setQuoteModal({ vendor, url, items: allItems })
    setQuoteForm({ name: '', company: '', phone: '', email: '', branch: '', notes: '' })
    setQuoteGenerated(false)
    setQuoteCopied(false)
  }

  function generateQuoteText() {
    if (!quoteModal) return ''
    const itemLines = quoteModal.items.map((m: any) =>
      `  • ${m.item_name}  —  Qty: ${m.quantity} ${m.unit}  |  Est. unit cost: $${Number(m.unit_cost || 0).toFixed(2)}`
    ).join('\n')
    return `MATERIAL QUOTE REQUEST
${'─'.repeat(50)}
Distributor: ${quoteModal.vendor}
Date: ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}

CONTACT INFORMATION
Company: ${quoteForm.company || '___________________'}
Name: ${quoteForm.name || '___________________'}
Phone: ${quoteForm.phone || '___________________'}
Email: ${quoteForm.email || '___________________'}
Preferred Branch: ${quoteForm.branch || '___________________'}

PROJECT DETAILS
Project: ${project?.name || 'Construction Project'}
Location: ${[project?.city, project?.region?.replace('US-', '')].filter(Boolean).join(', ') || '___________________'}
Type: ${project?.blueprint_type || 'Residential'}

ITEMS REQUESTED
${itemLines}

NOTES
${quoteForm.notes || '(none)'}

─────────────────────────────────────────────────────
Please provide pricing and availability for the above items.
Thank you for your time.`
  }

  const photoInputRef = useRef<HTMLInputElement>(null)

  async function handlePhotoUpload(phase: 'before' | 'during' | 'after', files: FileList | null) {
    if (!files || files.length === 0) return
    setUploadingPhoto(true)
    try {
      for (const file of Array.from(files)) {
        const { upload_url, key, public_url } = await api.photos.getUploadUrl(projectId, `${Date.now()}_${file.name}`, file.type)
        // Upload directly to Supabase storage
        await fetch(upload_url, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } })
        // Register in DB
        await api.photos.register(projectId, { storage_key: key, filename: file.name, phase })
      }
      // Reload photos
      const updated = await api.photos.list(projectId)
      setPhotos(updated || [])
      toast.success('Photos uploaded')
    } catch (err) {
      log.error('handleUploadPhoto', err)
      toast.error(`Upload failed: ${describeError(err)}`)
    }
    setUploadingPhoto(false)
  }

  async function handleDeletePhoto(photo: any) {
    try {
      await api.photos.delete(projectId, photo.id)
      setPhotos(prev => prev.filter(p => p.id !== photo.id))
    } catch {}
  }

  async function handleGenerateProposal() {
    setProposalLoading(true)
    setProposalError(null)
    try {
      const body: any = {
        trade_type: axisTradeType,
        tier:       axisTier,
      }
      if (lineItemsEdited && axisLineItems.length > 0) {
        body.material_overrides = axisLineItems
      }
      const resp = await fetch(`/api/v1/proposals/${projectId}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ detail: resp.statusText }))
        throw new Error(err.detail || 'Proposal generation failed')
      }
      const blob = await resp.blob()
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href     = url
      a.download = `proposal_${(project?.name || 'project').toLowerCase().replace(/\s+/g, '_')}.pdf`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e: any) {
      setProposalError(e.message || 'Failed to generate proposal')
    } finally {
      setProposalLoading(false)
    }
  }

  async function handleRunAxis() {
    setAxisStatus('queued')
    setAxisError(null)
    setAxisResults(null)
    setAxisElapsed(0)
    setAxisLineItems([])
    setLineItemsEdited(false)
    try {
      const resp = await api.axis.run(projectId, {
        project_name:  project?.name || 'Project',
        run_5d:        true,
        generate_pdf:  true,
        trade_type:    axisTradeType,
        use_cloud_gpu: axisCloudGpu,
      })
      setAxisJobId(resp.job_id)
      // Start polling
      if (axisPollerRef.current) clearInterval(axisPollerRef.current)
      axisPollerRef.current = setInterval(async () => {
        try {
          const statusResp = await api.axis.status(projectId, resp.job_id)
          setAxisStatus(statusResp.status as any)
          setAxisElapsed(statusResp.elapsed_s || 0)
          if (statusResp.status === 'complete') {
            clearInterval(axisPollerRef.current!)
            // Load results
            const results = await api.axis.results(projectId)
            setAxisResults(results)
            // Populate editable line items from live pricing materials
            const lp = results?.live_pricing as { materials?: unknown[] } | undefined
            const qr = results?.quantities as { _raw_items?: unknown[] } | undefined
            const mats = lp?.materials || qr?._raw_items || []
            if (mats.length > 0) setAxisLineItems(mats as any[])
          } else if (statusResp.status === 'error') {
            clearInterval(axisPollerRef.current!)
            setAxisStatus('error')
            setAxisError(statusResp.error || 'Pipeline failed.')
          }
        } catch (e: any) {
          setAxisError(e.message || 'Unknown error while polling pipeline status.')
          clearInterval(axisPollerRef.current!)
          setAxisStatus('error')
        }
      }, 4000)
    } catch (err: any) {
      setAxisStatus('error')
      setAxisError(err.message || 'Failed to start AXIS pipeline.')
    }
  }

  // Load existing AXIS results when entering 3D tab
  useEffect(() => {
    if (tab !== 'view3d' || axisResults || axisStatus !== 'idle') return
    api.axis.results(projectId)
      .then(r => {
        if (r?.summary) {
          setAxisResults(r)
          const lp = r?.live_pricing as { materials?: unknown[] } | undefined
          const qr = r?.quantities as { _raw_items?: unknown[] } | undefined
          const mats = lp?.materials || qr?._raw_items || []
          if (mats.length > 0 && axisLineItems.length === 0) setAxisLineItems(mats as any[])
        }
      })
      .catch(() => {}) // not run yet — that's fine
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  // Cleanup poller on unmount
  useEffect(() => {
    return () => { if (axisPollerRef.current) clearInterval(axisPollerRef.current) }
  }, [])

  function updateActualCost(category: string, value: number) {
    const updated = { ...actualCosts, [category]: value }
    setActualCosts(updated)
    localStorage.setItem(`job_costs_${projectId}`, JSON.stringify(updated))
  }

  const isProcessing = blueprintStatus === 'processing' || blueprintStatus === 'pending'
  const hasBlueprint = project?.blueprints?.length > 0
  const requiredCount = compliance?.items?.filter(i => i.severity === 'required').length ?? 0
  const recommendedCount = compliance?.items?.filter(i => i.severity === 'recommended').length ?? 0

  // ── Materials grouped by category ─────────────────────────────────────────
  const materials: any[] = estimate?.material_estimates || []
  const categoriesInData = Array.from(new Set(materials.map(m => m.category)))

  // Per-row confidence — memoized by material id so we don't recompute on
  // every keystroke in the markup input.
  const materialConfidence = useMemo(() => {
    const map: Record<string, ReturnType<typeof computeMaterialConfidence>> = {}
    for (const m of materials) {
      if (m.id) map[m.id] = computeMaterialConfidence(m)
    }
    return map
  }, [materials])

  const unreviewedLowConfCount = useMemo(() => {
    let n = 0
    for (const m of materials) {
      if (!m.id) continue
      if (materialConfidence[m.id]?.level === 'low' && !reviewedMaterials.has(m.id)) n += 1
    }
    return n
  }, [materials, materialConfidence, reviewedMaterials])

  const matchesReviewFilter = (m: any) => {
    if (!reviewFilterOnly) return true
    if (!m.id) return false
    return materialConfidence[m.id]?.level === 'low' && !reviewedMaterials.has(m.id)
  }

  const filteredMaterials = (categoryFilter === 'all' ? materials : materials.filter(m => m.category === categoryFilter))
    .filter(matchesReviewFilter)

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
  const isRoofing = project?.blueprint_type === 'roofing'
  const TABS: { id: Tab; label: string; badge?: number }[] = [
    { id: 'overview',   label: 'Overview' },
    ...(isRoofing ? [{ id: 'roofing' as Tab, label: '🏠 Roof' }] : []),
    { id: 'materials',  label: 'Materials', badge: materials.length || undefined },
    { id: 'cost',       label: 'Cost Estimate' },
    { id: 'view3d',     label: '✦ Renders' },
    { id: 'photos' as Tab,     label: '📸 Photos', badge: photos.length || undefined },
    { id: 'compliance', label: 'Compliance', badge: (requiredCount + (matCheckResult?.violations?.length ?? 0)) || undefined },
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
          <div className="text-center bg-white rounded-2xl p-10 max-w-md" style={cardStyle}>
            <div className="text-5xl mb-4">⚠️</div>
            <div className="text-slate-800 font-semibold mb-2">Analysis Failed</div>
            <div className="text-slate-500 text-sm mb-4">The AI could not process this blueprint.</div>
            {blueprintError && (
              <div className="text-left bg-red-50 border border-red-200 rounded-xl p-3 mb-4 text-xs text-red-700 font-mono break-all">
                {blueprintError}
              </div>
            )}
            <button
              onClick={async () => {
                const bp = project?.blueprints?.[0]
                if (!bp?.id) return
                setBlueprintStatus('processing')
                setBlueprintError(null)
                try { await api.blueprints.retryAnalysis(bp.id) } catch {}
              }}
              className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold px-6 py-2.5 rounded-xl transition-all"
            >
              Retry Analysis
            </button>
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

            {/* ── ROOFING ──────────────────────────────────────────────── */}
            {tab === 'roofing' && project?.blueprints?.[0] && (
              <div className="max-w-5xl">
                <RoofingSection
                  blueprintId={project.blueprints[0].id}
                  projectId={projectId}
                />
              </div>
            )}

            {/* ── OVERVIEW ──────────────────────────────────────────────── */}
            {tab === 'overview' && (
              <div className="grid grid-cols-12 gap-6 max-w-6xl">
                <div className="col-span-7 space-y-4">
                  {/* Blueprint preview */}
                  <div className="bg-white rounded-2xl overflow-hidden" style={cardStyle}>
                    <div className="flex items-center justify-between px-5 py-3.5 border-b" style={{ borderColor: 'rgba(219,234,254,0.7)' }}>
                      <span className="text-slate-800 font-semibold text-sm">Blueprint</span>
                      <div className="flex items-center gap-3">
                        {analysis?.confidence && (
                          <span className="text-xs text-slate-400">Quality: <span className="text-emerald-600 font-semibold">{Math.round(analysis.confidence * 100)}%</span></span>
                        )}
                        {blueprintViewUrl && (
                          <a
                            href={blueprintViewUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-blue-500 hover:text-blue-700 font-semibold flex items-center gap-1"
                          >
                            Open full size
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                          </a>
                        )}
                      </div>
                    </div>
                    {blueprintViewUrl ? (
                      <iframe
                        key={blueprintViewUrl}
                        src={blueprintViewUrl}
                        className="w-full border-0 block"
                        style={{ height: '560px' }}
                        title="Blueprint"
                      />
                    ) : (
                      <div className="flex items-center justify-center" style={{ height: '420px', background: 'linear-gradient(135deg, #eff6ff, #dbeafe)' }}>
                        <div className="text-center">
                          <svg className="animate-spin mx-auto mb-3 text-blue-400" width="28" height="28" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>
                          <p className="text-blue-400 text-sm">Loading blueprint…</p>
                        </div>
                      </div>
                    )}
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
                        { label: 'City',          value: project?.city || '—' },
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


                  {Array.isArray(analysis?.rooms) && analysis.rooms.length > 0 && (
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
                    {/* Refresh All Prices button */}
                    <button
                      onClick={handleRefreshAllPrices}
                      disabled={refreshingPrices || materials.length === 0}
                      title="Re-fetch live prices for all materials from Home Depot, Lowe's, and more"
                      className="flex items-center gap-2 text-white font-bold px-4 py-2 rounded-xl text-sm transition-all disabled:opacity-40 hover:scale-[1.02]"
                      style={{ background: refreshingPrices ? '#94a3b8' : 'linear-gradient(135deg, #0ea5e9, #0369a1)', boxShadow: '0 4px 14px rgba(14,165,233,0.25)' }}
                    >
                      {refreshingPrices ? (
                        <><svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg> Refreshing…</>
                      ) : refreshPricesResult ? refreshPricesResult : '🔄 Refresh All Prices'}
                    </button>
                    {Object.keys(materialChanges).length > 0 && (
                      <button
                        onClick={handleSaveMaterials}
                        disabled={savingMaterials}
                        className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold px-4 py-2 rounded-xl transition-all disabled:opacity-50"
                      >
                        {savingMaterials ? 'Saving…' : `Save Changes (${Object.keys(materialChanges).length})`}
                      </button>
                    )}
                    <button
                      onClick={handleLoadTakeoff}
                      disabled={!blueprintId || takeoffLoading}
                      title={!blueprintId ? 'Upload a blueprint first' : 'Extract per-room quantities from the blueprint (Togal-style)'}
                      className="flex items-center gap-2 text-white font-bold px-4 py-2 rounded-xl text-sm transition-all disabled:opacity-40 hover:scale-[1.02]"
                      style={{ background: takeoffLoading ? '#94a3b8' : 'linear-gradient(135deg, #f59e0b, #b45309)', boxShadow: '0 4px 14px rgba(245,158,11,0.25)' }}
                    >
                      {takeoffLoading ? (
                        <><svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg> Reading blueprint…</>
                      ) : '📐 Blueprint Takeoff'}
                    </button>
                    <button
                      onClick={() => setAddingMaterial(v => !v)}
                      className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold px-4 py-2 rounded-xl transition-all"
                    >
                      + Add Item
                    </button>
                    <button
                      onClick={() => api.reports.downloadPdf(projectId).then(blob => { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `report-${projectId}.pdf`; a.click(); URL.revokeObjectURL(url); }).catch(() => {})}
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
                    onClick={() => { setCategoryFilter('all'); setReviewFilterOnly(false) }}
                    className={`text-xs px-3 py-1.5 rounded-full font-semibold border transition-all ${categoryFilter === 'all' && !reviewFilterOnly ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-500 border-slate-200 hover:border-blue-300'}`}
                  >
                    All ({materials.length})
                  </button>
                  {unreviewedLowConfCount > 0 && (
                    <button
                      onClick={() => setReviewFilterOnly(v => !v)}
                      className={`text-xs px-3 py-1.5 rounded-full font-semibold border transition-all inline-flex items-center gap-1.5 ${reviewFilterOnly ? 'bg-amber-500 text-white border-amber-500' : 'bg-amber-50 text-amber-700 border-amber-200 hover:border-amber-400'}`}
                      title="Items with placeholder prices or missing vendor data"
                    >
                      <span>⚠</span> Review needed ({unreviewedLowConfCount})
                    </button>
                  )}
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

                {addingMaterial && (
                  <div className="bg-white rounded-2xl p-5 mb-4 border-2 border-dashed border-blue-200" style={cardStyle}>
                    <div className="text-sm font-bold text-slate-700 mb-3">Add New Material</div>
                    <div className="grid grid-cols-5 gap-3">
                      <input placeholder="Item name" value={newMaterial.item_name} onChange={e => setNewMaterial(p => ({...p, item_name: e.target.value}))}
                        className="col-span-2 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
                      <select value={newMaterial.category} onChange={e => setNewMaterial(p => ({...p, category: e.target.value}))}
                        className="bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-blue-400">
                        {Object.entries(CATEGORY_META).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                      </select>
                      <input type="number" placeholder="Qty" value={newMaterial.quantity || ''} onChange={e => setNewMaterial(p => ({...p, quantity: Number(e.target.value)}))}
                        className="bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
                      <input type="number" placeholder="Unit cost $" value={newMaterial.unit_cost || ''} onChange={e => setNewMaterial(p => ({...p, unit_cost: Number(e.target.value)}))}
                        className="bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
                    </div>
                    <div className="flex gap-2 mt-3">
                      <button onClick={handleAddMaterial} className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold px-4 py-2 rounded-xl transition-all">Add</button>
                      <button onClick={() => setAddingMaterial(false)} className="bg-slate-100 hover:bg-slate-200 text-slate-600 text-sm font-semibold px-4 py-2 rounded-xl transition-all">Cancel</button>
                    </div>
                  </div>
                )}

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
                              const matKey = m.id || `${cat}-${i}`
                              const isExpanded = expandedMaterial === matKey
                              const isEditing = editingMaterial === matKey

                              return (
                                <div key={matKey} className="group">
                                  {/* Material row */}
                                  <div
                                    className="w-full flex items-center gap-4 px-5 py-3.5 hover:bg-blue-50/40 transition-colors cursor-pointer"
                                    onClick={() => setExpandedMaterial(isExpanded ? null : matKey)}
                                  >
                                    <div className="flex-1 min-w-0">
                                      {isEditing ? (
                                        <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                                          <input
                                            value={editDraft.item_name ?? m.item_name}
                                            onChange={e => setEditDraft((p: any) => ({...p, item_name: e.target.value}))}
                                            className="bg-white border border-blue-300 rounded-lg px-2 py-1 text-sm focus:outline-none focus:border-blue-500 w-40"
                                          />
                                          <input type="number"
                                            value={editDraft.quantity ?? m.quantity}
                                            onChange={e => setEditDraft((p: any) => ({...p, quantity: Number(e.target.value)}))}
                                            className="bg-white border border-blue-300 rounded-lg px-2 py-1 text-sm focus:outline-none focus:border-blue-500 w-20"
                                            placeholder="Qty"
                                          />
                                          <input type="number"
                                            value={editDraft.unit_cost ?? m.unit_cost}
                                            onChange={e => setEditDraft((p: any) => ({...p, unit_cost: Number(e.target.value)}))}
                                            className="bg-white border border-blue-300 rounded-lg px-2 py-1 text-sm focus:outline-none focus:border-blue-500 w-24"
                                            placeholder="Unit cost"
                                          />
                                          <button
                                            onClick={e => { e.stopPropagation(); setMaterialChanges((p: any) => ({...p, [m.id]: editDraft})); setEditingMaterial(null) }}
                                            className="text-xs bg-blue-600 text-white px-2 py-1 rounded-lg hover:bg-blue-700"
                                          >Save</button>
                                          <button
                                            onClick={e => { e.stopPropagation(); setEditingMaterial(null) }}
                                            className="text-xs bg-slate-100 text-slate-600 px-2 py-1 rounded-lg hover:bg-slate-200"
                                          >Cancel</button>
                                        </div>
                                      ) : (
                                        <>
                                          <div className="text-slate-800 text-sm font-semibold">{(materialChanges[m.id]?.item_name) ?? m.item_name}</div>
                                          <div className="text-slate-400 text-xs mt-0.5">{(materialChanges[m.id]?.quantity ?? m.quantity)?.toLocaleString()} {m.unit}</div>
                                        </>
                                      )}
                                    </div>
                                    {!isEditing && (() => {
                                      const conf = m.id ? materialConfidence[m.id] : null
                                      const isReviewed = m.id && reviewedMaterials.has(m.id)
                                      const needsReview = conf?.level === 'low' && !isReviewed
                                      return (
                                        <div className="flex items-center gap-2 flex-shrink-0">
                                          {needsReview && (
                                            <div
                                              className="flex items-center gap-1"
                                              onClick={e => e.stopPropagation()}
                                              title={conf?.reasons.join(' · ')}
                                            >
                                              <span className="inline-flex items-center gap-1 text-[10px] font-bold bg-amber-50 border border-amber-200 text-amber-700 px-2 py-0.5 rounded-full">
                                                ⚠ Review
                                              </span>
                                              <button
                                                onClick={() => toggleReviewed(m.id)}
                                                className="text-[10px] font-bold text-white bg-emerald-500 hover:bg-emerald-600 px-2 py-0.5 rounded-full transition-colors"
                                                title="Mark this price as verified"
                                              >
                                                ✓
                                              </button>
                                            </div>
                                          )}
                                          {isReviewed && conf?.level === 'low' && (
                                            <button
                                              onClick={e => { e.stopPropagation(); toggleReviewed(m.id) }}
                                              className="inline-flex items-center gap-1 text-[10px] font-semibold bg-emerald-50 border border-emerald-200 text-emerald-700 px-2 py-0.5 rounded-full hover:bg-emerald-100"
                                              title="Click to un-mark as reviewed"
                                            >
                                              ✓ Reviewed
                                            </button>
                                          )}
                                          <div className="text-right">
                                            <div className="text-slate-800 font-bold text-sm">{formatMoneyExact(materialChanges[m.id]?.unit_cost ?? m.unit_cost)} / {m.unit}</div>
                                            <div className="text-blue-600 font-black text-sm">{formatMoney(m.total_cost)}</div>
                                          </div>
                                        </div>
                                      )
                                    })()}
                                    {vendors.length > 0 && !isEditing && (
                                      <div className="text-xs text-blue-500 font-semibold flex-shrink-0 flex items-center gap-1">
                                        {vendors.length} sources
                                        <svg className={`transition-transform ${isExpanded ? 'rotate-180' : ''}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="6 9 12 15 18 9"/></svg>
                                      </div>
                                    )}
                                    <div className="flex items-center gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                                      <button
                                        onClick={e => { e.stopPropagation(); setEditingMaterial(matKey); setEditDraft({ item_name: m.item_name, quantity: m.quantity, unit_cost: m.unit_cost }) }}
                                        className="p-1.5 rounded-lg hover:bg-blue-50 text-slate-400 hover:text-blue-600 transition-all"
                                        title="Edit"
                                      >
                                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                                      </button>
                                      <button
                                        onClick={e => { e.stopPropagation(); handleDeleteMaterial(m.id) }}
                                        className="p-1.5 rounded-lg hover:bg-red-50 text-slate-400 hover:text-red-500 transition-all"
                                        title="Delete"
                                      >
                                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
                                      </button>
                                    </div>
                                  </div>

                                  {/* Vendor options expanded */}
                                  {isExpanded && vendors.length === 0 && (
                                    <div className="px-5 pb-4 bg-slate-50/60">
                                      <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2 pt-3">Where to Buy</div>
                                      <div className="rounded-xl border border-dashed border-slate-200 bg-white px-4 py-5 text-center">
                                        <div className="text-slate-500 text-sm font-semibold mb-1">No live listings yet</div>
                                        <div className="text-slate-400 text-xs">Click "Search for Live Prices" below to pull real product pages from Home Depot, Lowe's, Ferguson, Grainger, and more.</div>
                                      </div>
                                    </div>
                                  )}
                                  {isExpanded && vendors.length > 0 && (
                                    <div className="px-5 pb-4 bg-slate-50/60">
                                      <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3 pt-3">Where to Buy</div>
                                      <div className="grid gap-2">
                                        {sortedVendors.map((v: any, vi: number) => {
                                          const isQuoteOnly = v.quote_only === true || v.price === null || v.price === undefined
                                          // Backend now guarantees every retail row has a real product URL.
                                          // Skip the row entirely if it somehow still lacks one.
                                          if (!v.url || !v.url.startsWith('http')) return null
                                          const buyUrl = v.url
                                          // Retail entries: show price tag on first; trade distributors: show "Trade" badge
                                          const isFirstRetail = !isQuoteOnly && vi === 0
                                          return (
                                            <div
                                              key={vi}
                                              className={`flex items-center justify-between rounded-xl px-4 py-3 border ${isQuoteOnly ? 'bg-slate-50' : 'bg-white'}`}
                                              style={{ borderColor: isQuoteOnly ? 'rgba(203,213,225,0.8)' : 'rgba(219,234,254,0.9)' }}
                                            >
                                              <div className="flex items-center gap-2 min-w-0">
                                                {isFirstRetail && (
                                                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full flex-shrink-0 bg-emerald-100 text-emerald-700">
                                                    LOWEST
                                                  </span>
                                                )}
                                                {isQuoteOnly && (
                                                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full flex-shrink-0 bg-amber-100 text-amber-700">
                                                    TRADE
                                                  </span>
                                                )}
                                                <div className="min-w-0">
                                                  <div className="text-slate-700 text-sm font-semibold truncate">{v.vendor}</div>
                                                  {v.note && <div className="text-slate-400 text-xs">{v.note}</div>}
                                                </div>
                                              </div>
                                              <div className="flex items-center gap-2 flex-shrink-0 ml-3">
                                                {isQuoteOnly ? (
                                                  <span className="text-slate-400 text-xs font-semibold italic">Call for pricing</span>
                                                ) : (
                                                  <span className="text-slate-800 font-black text-sm">{formatMoneyExact(v.price)}</span>
                                                )}
                                                <a
                                                  href={buyUrl}
                                                  target="_blank"
                                                  rel="noopener noreferrer"
                                                  onClick={e => e.stopPropagation()}
                                                  className={`flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-lg transition-all whitespace-nowrap ${isQuoteOnly ? 'bg-amber-500 hover:bg-amber-600 text-white' : 'bg-blue-600 hover:bg-blue-700 text-white'}`}
                                                >
                                                  {isQuoteOnly ? 'Get Quote' : 'Buy Now'}
                                                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                                                </a>
                                              </div>
                                            </div>
                                          )
                                        })}
                                      </div>
                                    </div>
                                  )}

                                  {/* Search for Live Prices */}
                                  {isExpanded && (
                                    <div className="px-5 pb-3 bg-slate-50/60">
                                      <button
                                        onClick={e => {
                                          e.stopPropagation()
                                          const overrides = editingMaterial === m.id ? {
                                            item_name: editDraft.item_name || m.item_name,
                                            category: editDraft.category || m.category,
                                          } : undefined
                                          handleSearchPrices(m, overrides)
                                        }}
                                        disabled={searchingPrices === m.id}
                                        className="flex items-center gap-2 text-xs font-semibold text-blue-600 hover:text-blue-800 bg-blue-50 hover:bg-blue-100 px-3 py-1.5 rounded-lg transition-all border border-blue-200 disabled:opacity-50"
                                      >
                                        {searchingPrices === m.id ? (
                                          <>
                                            <svg className="animate-spin" width="11" height="11" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>
                                            Searching nearby prices…
                                          </>
                                        ) : (
                                          <>
                                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                                            Search for Live Prices
                                          </>
                                        )}
                                      </button>
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
                      {/* Confidence banner — warns when the estimate leans on un-reviewed placeholder prices */}
                      {unreviewedLowConfCount > 0 && (
                        <div className="bg-amber-50 border border-amber-200 rounded-2xl px-5 py-3 flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <span className="text-xl">⚠</span>
                            <div>
                              <div className="text-amber-800 font-bold text-sm">
                                {unreviewedLowConfCount} item{unreviewedLowConfCount === 1 ? '' : 's'} still need{unreviewedLowConfCount === 1 ? 's' : ''} price review
                              </div>
                              <div className="text-amber-700 text-xs mt-0.5">
                                This total includes placeholder or vendor-less prices — verify before sending an estimate.
                              </div>
                            </div>
                          </div>
                          <button
                            onClick={() => { setTab('materials'); setReviewFilterOnly(true) }}
                            className="text-xs font-bold text-white bg-amber-600 hover:bg-amber-700 px-3 py-1.5 rounded-xl transition-colors whitespace-nowrap"
                          >
                            Review now →
                          </button>
                        </div>
                      )}

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

                      {/* ── Job Costing: Actual vs Estimated ── */}
                      <div className="bg-white rounded-2xl overflow-hidden" style={cardStyle}>
                        <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: 'rgba(219,234,254,0.7)' }}>
                          <div>
                            <span className="text-slate-800 font-bold">Job Costing — Actual vs Estimated</span>
                            <span className="text-slate-400 text-xs ml-2">Track your real spend per category</span>
                          </div>
                          {(() => {
                            const totalActual = Object.values(actualCosts).reduce((s, v) => s + v, 0)
                            const totalEst = matTotal
                            const diff = totalActual - totalEst
                            if (totalActual === 0) return null
                            return (
                              <span className={`text-xs font-bold px-2.5 py-1 rounded-full border ${diff <= 0 ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-red-50 border-red-200 text-red-700'}`}>
                                {diff <= 0 ? `${formatMoney(Math.abs(diff))} under budget` : `${formatMoney(diff)} over budget`}
                              </span>
                            )
                          })()}
                        </div>
                        <div className="divide-y" style={{ borderColor: 'rgba(219,234,254,0.5)' }}>
                          {Object.entries(categoryTotals).sort((a, b) => b[1] - a[1]).map(([cat, est]) => {
                            const meta = CATEGORY_META[cat] || { label: cat, icon: '📦' }
                            const actual = actualCosts[cat] || 0
                            const diff = actual - (est as number)
                            return (
                              <div key={cat} className="px-5 py-3 grid grid-cols-[1fr_auto_auto_auto] gap-4 items-center">
                                <span className="text-slate-600 text-sm flex items-center gap-2"><span>{meta.icon}</span>{meta.label}</span>
                                <span className="text-slate-400 text-xs text-right">{formatMoney(est as number)} est.</span>
                                <div className="flex items-center gap-1">
                                  <span className="text-slate-400 text-xs">$</span>
                                  <input
                                    type="number"
                                    min="0"
                                    placeholder="0"
                                    value={actual || ''}
                                    onChange={e => updateActualCost(cat, parseFloat(e.target.value) || 0)}
                                    className="w-24 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1 text-sm text-slate-700 focus:outline-none focus:border-blue-400 text-right"
                                  />
                                </div>
                                {actual > 0 && (
                                  <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${diff <= 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                                    {diff <= 0 ? '-' : '+'}{formatMoney(Math.abs(diff))}
                                  </span>
                                )}
                                {actual === 0 && <div />}
                              </div>
                            )
                          })}
                        </div>
                        {Object.values(actualCosts).some(v => v > 0) && (() => {
                          const totalActual = Object.values(actualCosts).reduce((s, v) => s + v, 0)
                          return (
                            <div className="px-5 py-3 flex justify-between items-center bg-slate-50/60 border-t" style={{ borderColor: 'rgba(219,234,254,0.7)' }}>
                              <span className="text-slate-600 text-sm font-bold">Total Actual Materials</span>
                              <span className="text-slate-800 font-black">{formatMoney(totalActual)}</span>
                            </div>
                          )
                        })()}
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
                        <div className="px-5 py-4 flex justify-between items-center border-t" style={{ borderColor: 'rgba(219,234,254,0.7)' }}>
                          <span className="text-slate-500 text-sm">Customer Proposal</span>
                          <button
                            onClick={() => setShowProposal(true)}
                            className="flex items-center gap-2 text-white font-bold px-4 py-2 rounded-xl text-sm transition-all hover:scale-[1.02]"
                            style={{ background: 'linear-gradient(135deg, #7c3aed, #5b21b6)', boxShadow: '0 4px 14px rgba(124,58,237,0.2)' }}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                            Generate Proposal
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                })()}
              </div>
            )}

            {/* ── 3D VIEW ───────────────────────────────────────────────── */}
            {tab === 'view3d' && (
              <div className="max-w-5xl space-y-4">
                <div>
                  <h2 className="text-slate-800 font-bold text-lg">AI Renders</h2>
                  <p className="text-slate-400 text-xs mt-0.5">Generate 4 exterior angles and per-room interior renders from your blueprint — zoom, pan, and measure directly on any image.</p>
                </div>

                {/* ── Rooms from blueprint analysis ──────────────────── */}
                {Array.isArray(analysis?.rooms) && analysis.rooms.length > 0 && (
                  <div className="bg-white rounded-2xl p-5" style={{ boxShadow: '0 2px 12px rgba(59,130,246,0.08)', border: '1px solid rgba(219,234,254,0.8)' }}>
                    <h3 className="text-slate-800 font-bold text-sm mb-3">
                      Rooms on Blueprint
                      <span className="ml-2 text-[11px] font-normal text-slate-400">({analysis.rooms.length} room{analysis.rooms.length !== 1 ? 's' : ''} detected)</span>
                    </h3>
                    <div className="grid grid-cols-3 gap-3">
                      {analysis.rooms.map((room: any, i: number) => {
                        const colors = ['bg-blue-50 border-blue-200','bg-green-50 border-green-200','bg-yellow-50 border-yellow-200','bg-rose-50 border-rose-200','bg-purple-50 border-purple-200','bg-cyan-50 border-cyan-200','bg-orange-50 border-orange-200','bg-emerald-50 border-emerald-200']
                        return (
                          <div key={i} className={`rounded-xl border p-3 ${colors[i % colors.length]}`}>
                            <div className="text-slate-800 font-semibold text-sm">{room.name}</div>
                            <div className="text-slate-500 text-xs mt-0.5">{room.sqft ? `${Math.round(room.sqft)} sqft` : '—'}</div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                {/* ── AI PHOTOREALISTIC RENDERS ──────────────────────── */}
                <div className="bg-white rounded-2xl overflow-hidden" style={{ boxShadow: '0 2px 12px rgba(59,130,246,0.08)', border: '1px solid rgba(219,234,254,0.8)' }}>
                  <div className="px-6 py-5 border-b" style={{ borderColor: 'rgba(219,234,254,0.8)' }}>
                    <div className="space-y-4">
                      <div className="flex items-start justify-between flex-wrap gap-4">
                        <div>
                          <h3 className="text-slate-800 font-bold text-base">AI Photorealistic Renders</h3>
                          <p className="text-slate-400 text-xs mt-0.5">AI reads your blueprint for accurate context · 360° exterior + every room interior</p>
                        </div>
                        <div className="flex items-center gap-3 flex-wrap">
                          <div className="flex items-center gap-2">
                            <span className="text-slate-500 text-xs font-semibold">Style</span>
                            <select
                              value={renderStyle}
                              onChange={e => setRenderStyle(e.target.value)}
                              className="text-xs rounded-lg px-2.5 py-1.5 border text-slate-700 focus:outline-none focus:border-blue-400"
                              style={{ borderColor: 'rgba(219,234,254,0.9)', background: '#f8faff' }}
                            >
                              {[['modern','Modern'],['traditional','Traditional'],['farmhouse','Farmhouse'],['contemporary','Contemporary'],['craftsman','Craftsman']].map(([v,l]) => (
                                <option key={v} value={v}>{l}</option>
                              ))}
                            </select>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-slate-500 text-xs font-semibold">Time</span>
                            <select
                              value={renderTimeOfDay}
                              onChange={e => setRenderTimeOfDay(e.target.value)}
                              className="text-xs rounded-lg px-2.5 py-1.5 border text-slate-700 focus:outline-none focus:border-blue-400"
                              style={{ borderColor: 'rgba(219,234,254,0.9)', background: '#f8faff' }}
                            >
                              {[['day','Midday'],['golden_hour','Golden Hour'],['dusk','Dusk']].map(([v,l]) => (
                                <option key={v} value={v}>{l}</option>
                              ))}
                            </select>
                          </div>
                        </div>
                      </div>

                      {/* Context input + Generate button */}
                      <div className="flex gap-3 items-end">
                        <div className="flex-1">
                          <label className="text-slate-500 text-xs font-semibold block mb-1.5">
                            Tell the AI what this should look like <span className="font-normal text-slate-400">(this drives every render — materials, colors, setting, landscaping)</span>
                          </label>
                          <input
                            type="text"
                            value={renderUserContext}
                            onChange={e => setRenderUserContext(e.target.value)}
                            placeholder='e.g. "red brick exterior, black windows, cedar shake roof, mature oaks, coastal New England"'
                            disabled={renderLoading}
                            className="w-full text-xs rounded-xl px-3.5 py-2.5 border text-slate-700 placeholder-slate-300 focus:outline-none focus:border-indigo-400 disabled:opacity-50"
                            style={{ borderColor: 'rgba(219,234,254,0.9)', background: '#f8faff' }}
                            onKeyDown={e => { if (e.key === 'Enter' && !renderLoading && hasBlueprint) (e.target as HTMLInputElement).blur() }}
                          />
                          <p className="text-[10px] text-slate-400 mt-1">
                            The more specific you are, the more accurate every exterior and room render will be.
                          </p>
                        </div>
                        <button
                          onClick={async () => {
                            setRenderLoading(true)
                            setRenderError(null)
                            try {
                              const result = await api.renders.generate(projectId, renderStyle, renderTimeOfDay, renderUserContext)
                              setRenders(result)
                            } catch (err: any) {
                              setRenderError(err.message || 'Render generation failed.')
                            }
                            setRenderLoading(false)
                          }}
                          disabled={renderLoading || !hasBlueprint}
                          title={!hasBlueprint ? 'Upload a blueprint first' : 'Generate AI renders'}
                          className="flex items-center gap-2 text-white font-bold px-4 py-2.5 rounded-xl text-sm transition-all disabled:opacity-40 hover:scale-[1.02] flex-shrink-0"
                          style={{ background: renderLoading ? '#94a3b8' : 'linear-gradient(135deg, #6366f1, #4f46e5)', boxShadow: '0 4px 14px rgba(99,102,241,0.3)' }}
                        >
                          {renderLoading
                            ? <><svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg> Generating…</>
                            : renders ? '↺ Re-generate' : '✦ Generate Renders'}
                        </button>
                      </div>
                    </div>
                  </div>

                  {renderError && (
                    <div className="px-6 py-3 bg-red-50 border-b border-red-100 flex items-start justify-between gap-3">
                      <pre className="text-red-700 text-xs whitespace-pre-wrap break-all flex-1">{renderError}</pre>
                      <button onClick={() => navigator.clipboard.writeText(renderError!)} className="text-red-400 hover:text-red-600 text-xs font-semibold flex-shrink-0 underline">Copy</button>
                    </div>
                  )}

                  {renderLoading && (
                    <div className="px-6 py-16 flex flex-col items-center gap-4">
                      <svg className="animate-spin text-indigo-400" width="32" height="32" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>
                      <div className="text-slate-500 text-sm text-center">
                        <div className="font-semibold">Generating photorealistic renders…</div>
                        <div className="text-slate-400 text-xs mt-1">
                          Reading blueprint · building 4 exterior angles + {analysis?.rooms?.length ? `${Math.min(analysis.rooms.length, 5)} room interior${Math.min(analysis.rooms.length, 5) !== 1 ? 's' : ''}` : 'room interiors'}. Takes ~2 minutes.
                        </div>
                      </div>
                    </div>
                  )}

                  {!renderLoading && renders && (
                    <div className="p-6 space-y-6">
                      {/* 360° Exterior carousel */}
                      {renders.exterior_views.length > 0 && (
                        <ExteriorCarousel views={renders.exterior_views} />
                      )}

                      {/* Per-room interior renders */}
                      {renders.room_renders.length > 0 && (
                        <div>
                          <h4 className="text-slate-700 font-bold text-sm mb-3">Room Interiors</h4>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {renders.room_renders.map((room, i) =>
                              room.url ? (
                                <StaggeredRender
                                  key={i}
                                  src={room.url}
                                  label={room.name}
                                  totalSqft={analysis?.total_sqft ?? undefined}
                                />
                              ) : (
                                <div
                                  key={i}
                                  className="rounded-xl flex items-center justify-center bg-slate-50 text-slate-400 text-sm"
                                  style={{ border: '1px solid rgba(219,234,254,0.8)', aspectRatio: '16/9' }}
                                >
                                  {room.name} — render unavailable
                                </div>
                              )
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {!renderLoading && !renders && !renderError && (
                    <div className="px-6 py-12 text-center text-slate-400 text-sm">
                      <div className="text-2xl mb-3">🏠</div>
                      <div className="font-semibold text-slate-500">No renders yet</div>
                      <div className="text-xs mt-1">Choose a style and click Generate Renders to create 4 exterior angles and per-room interior views.</div>
                    </div>
                  )}
                </div>
                {/* ── END AI RENDERS ─────────────────────────────────────────── */}

              </div>
            )}

            {/* ── PHOTOS ──────────────────────────────────────────────── */}
            {tab === 'photos' && (
              <div className="max-w-5xl">
                {showCaptureWizard && (
                  <ExteriorCaptureWizard
                    projectId={projectId}
                    initialPhotos={photos}
                    onComplete={async () => {
                      try {
                        const photoData = await api.photos.list(projectId)
                        setPhotos(photoData || [])
                      } catch {}
                    }}
                    onClose={() => setShowCaptureWizard(false)}
                  />
                )}
                <div className="flex items-center justify-between mb-5 flex-wrap gap-2">
                  <div>
                    <h2 className="text-slate-800 font-bold text-lg">Job Photos</h2>
                    <p className="text-slate-400 text-xs mt-0.5">{photos.length} photo{photos.length !== 1 ? 's' : ''} — before, during, and after documentation</p>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <button
                      onClick={() => setShowCaptureWizard(true)}
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white transition-all hover:scale-[1.02]"
                      style={{ background: 'linear-gradient(135deg, #6366f1, #4f46e5)', boxShadow: '0 4px 14px rgba(99,102,241,0.3)' }}
                      title="Guided 8-angle exterior capture"
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 3v18M3 12h18"/></svg>
                      Guided Capture
                    </button>
                    <button
                      onClick={async () => {
                        setDamageReportError(null)
                        setDamageReportLoading(true)
                        try {
                          await api.photos.downloadDamageReport(projectId, { includeAll: false })
                        } catch (err) {
                          setDamageReportError(err instanceof Error ? err.message : 'Download failed')
                        }
                        setDamageReportLoading(false)
                      }}
                      disabled={damageReportLoading || photos.length === 0}
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white transition-all hover:scale-[1.02] disabled:opacity-40 disabled:cursor-not-allowed"
                      style={{ background: damageReportLoading ? '#94a3b8' : 'linear-gradient(135deg, #dc2626, #991b1b)', boxShadow: '0 4px 14px rgba(220,38,38,0.25)' }}
                      title="One page per AI-tagged damaged photo"
                    >
                      {damageReportLoading ? (
                        <><svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg> Building PDF…</>
                      ) : (
                        <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> Damage PDF</>
                      )}
                    </button>
                    {(['before', 'during', 'after'] as const).map(phase => (
                      <label key={phase} className="relative cursor-pointer">
                        <input
                          type="file"
                          multiple
                          accept="image/*"
                          className="sr-only"
                          onChange={e => handlePhotoUpload(phase, e.target.files)}
                        />
                        <span className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all border ${
                          phase === 'before' ? 'bg-blue-600 text-white border-blue-600 hover:bg-blue-700' :
                          phase === 'during' ? 'bg-amber-500 text-white border-amber-500 hover:bg-amber-600' :
                          'bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700'
                        }`}>
                          {uploadingPhoto ? <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg> : '+'} {phase.charAt(0).toUpperCase() + phase.slice(1)}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>

                {damageReportError && (
                  <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-2 mb-3">
                    Damage PDF: {damageReportError}
                  </div>
                )}

                {/* Phase filter + view mode toggle */}
                <div className="flex items-center justify-between gap-3 mb-5 flex-wrap">
                  <div className="flex gap-2">
                    {(['all', 'before', 'during', 'after'] as const).map(p => {
                      const count = p === 'all' ? photos.length : photos.filter(ph => ph.phase === p).length
                      const colors: Record<string, string> = { all: 'bg-blue-600 text-white border-blue-600', before: 'bg-blue-600 text-white border-blue-600', during: 'bg-amber-500 text-white border-amber-500', after: 'bg-emerald-600 text-white border-emerald-600' }
                      return (
                        <button key={p} onClick={() => setPhotoPhase(p)}
                          className={`text-xs px-3 py-1.5 rounded-full font-semibold border transition-all capitalize ${photoPhase === p ? colors[p] : 'bg-white text-slate-500 border-slate-200 hover:border-blue-300'}`}>
                          {p === 'all' ? 'All' : p.charAt(0).toUpperCase() + p.slice(1)} ({count})
                        </button>
                      )
                    })}
                  </div>
                  <div className="inline-flex items-center bg-slate-100 rounded-full p-1">
                    <button
                      onClick={() => setPhotoViewMode('grid')}
                      className={`text-xs font-semibold px-3 py-1 rounded-full transition-all ${photoViewMode === 'grid' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                    >
                      ▦ Grid
                    </button>
                    <button
                      onClick={() => setPhotoViewMode('map')}
                      className={`text-xs font-semibold px-3 py-1 rounded-full transition-all ${photoViewMode === 'map' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                    >
                      🗺 Map
                    </button>
                  </div>
                </div>

                {/* Photo grid or map */}
                {photoViewMode === 'map' ? (
                  <PhotoMapView
                    photos={(photoPhase === 'all' ? photos : photos.filter(p => p.phase === photoPhase)) as any}
                    onSelect={p => setSelectedPhoto(p)}
                  />
                ) : (() => {
                  const displayed = photoPhase === 'all' ? photos : photos.filter(p => p.phase === photoPhase)
                  if (displayed.length === 0) return (
                    <div className="bg-white rounded-2xl p-16 text-center" style={cardStyle}>
                      <div className="text-5xl mb-4">📸</div>
                      <div className="text-slate-700 font-semibold mb-1">No photos yet</div>
                      <div className="text-slate-400 text-sm">Upload before, during, and after photos using the buttons above.</div>
                    </div>
                  )
                  return (
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                      {displayed.map((photo: any) => {
                        const phaseColors: Record<string, string> = { before: 'bg-blue-500', during: 'bg-amber-500', after: 'bg-emerald-500' }
                        const hasGeo = typeof photo.latitude === 'number' && typeof photo.longitude === 'number'
                        const hasNotes = !!(photo.notes && photo.notes.trim())
                        const hasAutoTags = photo.auto_tags && (photo.auto_tags.area || (photo.auto_tags.materials || []).length > 0)
                        return (
                          <div key={photo.id} className="relative group bg-white rounded-2xl overflow-hidden cursor-pointer flex flex-col" style={cardStyle} onClick={() => setSelectedPhoto(photo)}>
                            <div className="relative aspect-[4/3] bg-slate-100 overflow-hidden">
                              <img src={photo.url} alt={photo.filename} loading="lazy" className="absolute inset-0 w-full h-full object-cover" />
                              <div className="absolute top-2 left-2 flex items-center gap-1">
                                <span className={`text-[10px] font-bold text-white px-2 py-0.5 rounded-full capitalize ${phaseColors[photo.phase] || 'bg-slate-500'}`}>{photo.phase}</span>
                                {hasGeo && (
                                  <span className="text-[10px] font-bold text-white bg-slate-900/70 px-1.5 py-0.5 rounded-full" title={`${photo.latitude.toFixed(4)}, ${photo.longitude.toFixed(4)}`}>📍</span>
                                )}
                                {hasNotes && (
                                  <span className="text-[10px] font-bold text-white bg-slate-900/70 px-1.5 py-0.5 rounded-full" title="Has notes">📝</span>
                                )}
                                {hasAutoTags && (
                                  <span className="text-[10px] font-bold text-white bg-indigo-500/90 px-1.5 py-0.5 rounded-full" title="AI-tagged">✨</span>
                                )}
                              </div>
                              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-all flex items-end justify-end p-2">
                                <button
                                  onClick={e => { e.stopPropagation(); handleDeletePhoto(photo) }}
                                  className="p-1.5 bg-red-500 hover:bg-red-600 text-white rounded-lg transition-all opacity-0 group-hover:opacity-100"
                                >
                                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>
                                </button>
                              </div>
                            </div>
                            <div className="px-3 py-2">
                              <div className="text-slate-500 text-[10px] truncate">{photo.filename}</div>
                              {(photo.auto_tags?.area || (photo.tags || []).length > 0) && (
                                <div className="flex flex-wrap gap-1 mt-1">
                                  {photo.auto_tags?.area && (
                                    <span className="text-[9px] bg-slate-100 text-slate-600 font-semibold px-1.5 py-0.5 rounded-full capitalize">{photo.auto_tags.area}</span>
                                  )}
                                  {(photo.tags || []).slice(0, 2).map((t: string) => (
                                    <span key={t} className="text-[9px] bg-indigo-50 text-indigo-700 font-semibold px-1.5 py-0.5 rounded-full">{t}</span>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )
                })()}

                {/* Photo-to-Measurements */}
                <div className="mt-6 bg-white rounded-2xl p-5" style={cardStyle}>
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <h3 className="text-slate-800 font-bold text-sm">AI Measurement Estimate</h3>
                      <p className="text-slate-400 text-xs mt-0.5">Claude Vision analyzes your photos to estimate wall area, roof area, and dimensions.</p>
                    </div>
                    <button
                      onClick={handlePhotoMeasure}
                      disabled={photoMeasureLoading || photos.length === 0}
                      title={photos.length === 0 ? 'Upload at least one photo first' : ''}
                      className="flex items-center gap-2 text-white font-bold px-4 py-2 rounded-xl text-sm transition-all disabled:opacity-40 hover:scale-[1.02]"
                      style={{ background: photoMeasureLoading ? '#94a3b8' : 'linear-gradient(135deg, #2563eb, #1e40af)', boxShadow: '0 4px 14px rgba(37,99,235,0.25)' }}
                    >
                      {photoMeasureLoading ? (
                        <><svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg> Analyzing…</>
                      ) : '📐 Measure from Photos'}
                    </button>
                  </div>
                  {photoMeasureError && (
                    <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-xl">{photoMeasureError}</div>
                  )}
                  {photoMeasureResult && (
                    <div>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                        {[
                          { label: 'Total Sqft',     value: `${(photoMeasureResult.total_sqft || 0).toLocaleString()} sqft` },
                          { label: 'Wall Area',      value: `${(photoMeasureResult.wall_area_sqft || 0).toLocaleString()} sqft` },
                          { label: 'Roof Area',      value: `${(photoMeasureResult.roof_area_sqft || 0).toLocaleString()} sqft` },
                          { label: 'Perimeter',      value: `${photoMeasureResult.perimeter_ft || 0} ft` },
                          { label: 'Stories',        value: photoMeasureResult.stories || '—' },
                          { label: 'Wall Height',    value: `${photoMeasureResult.wall_height_ft || '—'} ft` },
                          { label: 'Photos Used',    value: photoMeasureResult.photo_count || photos.length },
                          { label: 'Confidence',     value: `${Math.round((photoMeasureResult.confidence || 0) * 100)}%` },
                        ].map(s => (
                          <div key={s.label} className="bg-blue-50 rounded-xl p-3">
                            <div className="text-blue-800 font-black text-lg">{s.value}</div>
                            <div className="text-blue-500 text-xs mt-0.5">{s.label}</div>
                          </div>
                        ))}
                      </div>
                      {photoMeasureResult.structure_type && (
                        <div className="text-slate-500 text-xs mb-2"><span className="font-semibold text-slate-700">Structure:</span> {photoMeasureResult.structure_type}</div>
                      )}
                      {photoMeasureResult.dimensions && (
                        <div className="text-slate-500 text-xs mb-2"><span className="font-semibold text-slate-700">Est. Dimensions:</span> ~{photoMeasureResult.dimensions.estimated_width_ft}ft wide × {photoMeasureResult.dimensions.estimated_depth_ft}ft deep</div>
                      )}
                      {photoMeasureResult.notes && (
                        <div className="text-slate-500 text-xs mb-2 italic">{photoMeasureResult.notes}</div>
                      )}
                      {photoMeasureResult.warnings?.length > 0 && (
                        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 mt-2">
                          {photoMeasureResult.warnings.map((w: string, i: number) => (
                            <div key={i} className="text-amber-700 text-xs flex items-start gap-1.5"><span className="mt-0.5">⚠</span>{w}</div>
                          ))}
                        </div>
                      )}
                      <p className="text-slate-400 text-[10px] mt-3">AI estimates only — verify all measurements on-site before ordering materials.</p>
                    </div>
                  )}
                  {!photoMeasureResult && !photoMeasureError && !photoMeasureLoading && (
                    <div className="text-center py-6 text-slate-400 text-sm">
                      {photos.length === 0
                        ? 'Upload photos above, then click "Measure from Photos" to get AI estimates.'
                        : `${photos.length} photo${photos.length > 1 ? 's' : ''} ready — click "Measure from Photos" to extract dimensions.`}
                    </div>
                  )}
                </div>

                {/* Lightbox with CompanyCam-style metadata side panel */}
                {selectedPhoto && (
                  <PhotoLightbox
                    photo={selectedPhoto}
                    projectId={projectId}
                    onClose={() => setSelectedPhoto(null)}
                    onUpdate={updated => {
                      setSelectedPhoto(updated)
                      setPhotos(prev => prev.map(p => (p.id === updated.id ? { ...p, ...updated } : p)))
                    }}
                  />
                )}
              </div>
            )}

            {/* ── COMPLIANCE ────────────────────────────────────────────── */}
            {tab === 'compliance' && (
              <div className="max-w-3xl">
                <div className="flex justify-end mb-4">
                  <button
                    onClick={handleMaterialsComplianceCheck}
                    disabled={matCheckLoading || !project?.city}
                    className="flex items-center gap-2 px-4 py-2 rounded-xl text-white text-sm font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{ background: matCheckLoading ? '#94a3b8' : 'linear-gradient(135deg, #7c3aed, #5b21b6)', boxShadow: '0 4px 14px rgba(124,58,237,0.25)' }}
                    title={!project?.city ? 'Add a city to the project first' : ''}
                  >
                    {matCheckLoading ? (
                      <><svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>Checking…</>
                    ) : '⚖ Check Code Compliance'}
                  </button>
                </div>
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
                          {items.map(item => {
                            const isFail = item.status === 'fail'
                            const isReview = item.status === 'review'
                            const itemCardStyle = isFail
                              ? { ...cardStyle, border: '1px solid rgba(254,202,202,0.9)', boxShadow: '0 2px 12px rgba(239,68,68,0.08)', background: 'linear-gradient(180deg, #fff 0%, #fef2f2 100%)' }
                              : isReview
                              ? { ...cardStyle, border: '1px solid rgba(253,230,138,0.9)' }
                              : cardStyle
                            return (
                            <div key={item.id} className="bg-white rounded-xl overflow-hidden cursor-pointer transition-all hover:shadow-sm" style={itemCardStyle}
                              onClick={() => setExpandedItem(expandedItem === item.id ? null : item.id)}>
                              <div className="px-4 py-3.5 flex items-start gap-3">
                                <div className={`w-2 h-2 rounded-full mt-2 flex-shrink-0 ${isFail ? 'bg-red-500' : SEVERITY[item.severity].dot}`} />
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-start justify-between gap-3 flex-wrap">
                                    <span className={`text-sm font-medium leading-snug ${isFail ? 'text-red-700' : 'text-slate-800'}`}>{item.title}</span>
                                    <div className="flex items-center gap-1.5 flex-shrink-0">
                                      {item.status && STATUS_BADGE[item.status] && (
                                        <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold capitalize ${STATUS_BADGE[item.status].badge}`}>{STATUS_BADGE[item.status].label}</span>
                                      )}
                                      {item.tier && TIER_BADGE[item.tier] && (
                                        <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${TIER_BADGE[item.tier].badge}`}>{TIER_BADGE[item.tier].label}</span>
                                      )}
                                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold capitalize ${SEVERITY[item.severity].badge}`}>{SEVERITY[item.severity].label}</span>
                                    </div>
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
                            )
                          })}
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

                {/* ── MATERIALS CODE CHECK RESULTS ──────────────────────── */}
                {(matCheckResult || matCheckLoading || matCheckError) && (
                  <div className="mt-6">
                    {matCheckLoading && (
                      <div className="bg-white rounded-2xl p-8 text-center" style={cardStyle}>
                        <svg className="animate-spin text-purple-500 mx-auto mb-3" width="24" height="24" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>
                        <div className="text-slate-600 text-sm font-medium mb-1">Checking materials against local codes…</div>
                        <div className="text-slate-400 text-xs">Pulling {project?.city} building codes and cross-referencing your materials list</div>
                      </div>
                    )}

                    {matCheckError && (
                      <div className="bg-red-50 border border-red-200 rounded-2xl p-4 text-red-600 text-sm">{matCheckError}</div>
                    )}

                    {matCheckResult && (() => {
                      const checklist: any[] = matCheckResult.checklist || []
                      const missing: any[] = matCheckResult.missing_required_items || []
                      const passCount = checklist.filter((c: any) => c.status === 'pass').length
                      const failCount = checklist.filter((c: any) => c.status === 'fail').length
                      const warnCount = checklist.filter((c: any) => c.status === 'warning').length
                      const loc = matCheckResult.location
                      const locationStr = [loc?.city, loc?.county, loc?.state].filter(Boolean).join(', ')

                      return (
                        <div className="space-y-4">
                          {/* Header */}
                          <div className="bg-white rounded-2xl px-5 py-4" style={cardStyle}>
                            <div className="flex items-start justify-between gap-4 mb-3">
                              <div>
                                <div className="flex items-center gap-2 mb-1">
                                  <span className="text-slate-800 font-bold text-sm">Materials Code Compliance</span>
                                  <span className={`text-xs px-2.5 py-0.5 rounded-full font-semibold border capitalize ${
                                    matCheckResult.overall_status === 'pass' ? 'bg-emerald-50 border-emerald-200 text-emerald-700' :
                                    matCheckResult.overall_status === 'warning' ? 'bg-amber-50 border-amber-200 text-amber-700' :
                                    'bg-red-50 border-red-200 text-red-700'
                                  }`}>{matCheckResult.overall_status}</span>
                                </div>
                                {locationStr && <div className="text-slate-400 text-xs">{locationStr} · {matCheckResult.project_type}</div>}
                              </div>
                              <div className="flex gap-3 text-center flex-shrink-0">
                                <div><div className="text-emerald-600 font-bold text-lg leading-none">{passCount}</div><div className="text-slate-400 text-[10px] mt-0.5">Pass</div></div>
                                {warnCount > 0 && <div><div className="text-amber-500 font-bold text-lg leading-none">{warnCount}</div><div className="text-slate-400 text-[10px] mt-0.5">Warn</div></div>}
                                <div><div className="text-red-500 font-bold text-lg leading-none">{failCount + missing.length}</div><div className="text-slate-400 text-[10px] mt-0.5">Fail</div></div>
                              </div>
                            </div>
                            {matCheckResult.summary && <p className="text-slate-500 text-sm leading-relaxed border-t pt-3" style={{ borderColor: 'rgba(219,234,254,0.6)' }}>{matCheckResult.summary}</p>}
                          </div>

                          {/* Per-material checklist */}
                          {checklist.length > 0 && (
                            <div className="space-y-2">
                              <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Materials Checklist ({checklist.length} items)</div>
                              {checklist.map((item: any, i: number) => {
                                const isFail = item.status === 'fail'
                                const isWarn = item.status === 'warning'
                                const isPass = item.status === 'pass'
                                return (
                                  <div key={i} className={`bg-white rounded-xl overflow-hidden`} style={{
                                    boxShadow: isFail ? '0 2px 12px rgba(239,68,68,0.08)' : isWarn ? '0 2px 12px rgba(245,158,11,0.08)' : '0 2px 8px rgba(59,130,246,0.06)',
                                    border: isFail ? '1px solid rgba(254,202,202,0.9)' : isWarn ? '1px solid rgba(253,230,138,0.9)' : '1px solid rgba(167,243,208,0.7)',
                                  }}>
                                    <div className="px-4 py-3 flex items-start gap-3">
                                      {/* Status icon */}
                                      <div className="flex-shrink-0 mt-0.5">
                                        {isPass && (
                                          <div className="w-5 h-5 rounded-full bg-emerald-100 flex items-center justify-center">
                                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="3" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                                          </div>
                                        )}
                                        {isFail && (
                                          <div className="w-5 h-5 rounded-full bg-red-100 flex items-center justify-center">
                                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="3" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                                          </div>
                                        )}
                                        {isWarn && (
                                          <div className="w-5 h-5 rounded-full bg-amber-100 flex items-center justify-center">
                                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="3" strokeLinecap="round"><path d="M12 9v4M12 17h.01"/></svg>
                                          </div>
                                        )}
                                      </div>
                                      <div className="flex-1 min-w-0">
                                        <div className="flex items-start justify-between gap-2">
                                          <span className="text-slate-800 text-sm font-semibold">{item.item_name}</span>
                                          {item.category && <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 font-medium flex-shrink-0 capitalize">{item.category}</span>}
                                        </div>
                                        {isPass && item.note && <p className="text-slate-500 text-xs mt-0.5">{item.note}</p>}
                                        {isPass && item.code_reference && <p className="text-emerald-600 text-[10px] mt-0.5 font-medium">{item.code_reference}</p>}
                                        {(isFail || isWarn) && item.rule_text && (
                                          <blockquote className={`mt-2 pl-3 border-l-2 text-slate-500 text-xs italic leading-relaxed ${isFail ? 'border-red-300' : 'border-amber-300'}`}>{item.rule_text}</blockquote>
                                        )}
                                        {(isFail || isWarn) && item.violation_reason && (
                                          <p className="mt-1.5 text-slate-600 text-xs">{item.violation_reason}</p>
                                        )}
                                        {(isFail || isWarn) && item.fix_suggestion && (
                                          <div className="mt-2 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2">
                                            <span className="text-[10px] font-bold text-blue-600 uppercase tracking-wider">Fix: </span>
                                            <span className="text-slate-700 text-xs">{item.fix_suggestion}</span>
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                )
                              })}
                            </div>
                          )}

                          {/* Missing required items */}
                          {missing.length > 0 && (
                            <div>
                              <div className="text-xs font-bold text-amber-600 uppercase tracking-wider mb-2">Missing Required Items ({missing.length})</div>
                              <div className="space-y-2">
                                {missing.map((m: any, i: number) => (
                                  <div key={i} className="bg-white rounded-xl px-4 py-3 flex items-start gap-3" style={{ boxShadow: '0 2px 12px rgba(245,158,11,0.08)', border: '1px solid rgba(253,230,138,0.9)' }}>
                                    <div className="w-5 h-5 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0 mt-0.5">
                                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="3" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                                    </div>
                                    <div className="flex-1">
                                      <span className="text-slate-800 text-sm font-semibold">{m.item_name}</span>
                                      {m.rule_text && <blockquote className="mt-1.5 pl-3 border-l-2 border-amber-300 text-slate-500 text-xs italic leading-relaxed">{m.rule_text}</blockquote>}
                                      {m.reason_required && <p className="mt-1 text-slate-500 text-xs">{m.reason_required}</p>}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    })()}
                  </div>
                )}
              </div>
            )}

            {/* ── PERMITS ───────────────────────────────────────────────── */}
            {tab === 'permits' && (
              <div className="max-w-2xl space-y-5">
                <div>
                  <h2 className="text-slate-800 font-bold text-lg">Permit Applications</h2>
                  <p className="text-slate-400 text-xs mt-0.5">Find and submit your building permit for {project?.city ? `${project.city}, ` : ''}{project?.region}</p>
                </div>
                {project && (!project.city || !project.region) && (
                  <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4">
                    <div className="flex items-start gap-3">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2" strokeLinecap="round" className="flex-shrink-0 mt-0.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                      <div className="flex-1">
                        <div className="text-amber-800 font-bold text-sm">Project is missing its city or state</div>
                        <p className="text-amber-700 text-xs mt-1">We need the project&apos;s city and state to fetch the right permit form. Edit the project to add them.</p>
                      </div>
                    </div>
                  </div>
                )}
                <PermitPortalSection project={project} projectId={projectId} />
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── PROPOSAL MODAL ── */}
      {showProposal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(15,23,42,0.5)', backdropFilter: 'blur(6px)' }}>
          <div className="bg-white rounded-2xl w-full max-w-2xl shadow-2xl max-h-[90vh] overflow-y-auto" style={{ border: '1px solid rgba(219,234,254,0.8)' }}>
            <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: 'rgba(219,234,254,0.8)' }}>
              <div>
                <h2 className="text-lg font-bold text-slate-800">Customer Proposal</h2>
                <p className="text-slate-400 text-xs mt-0.5">Print or save as PDF to share with your client</p>
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => window.print()}
                  className="flex items-center gap-2 text-white font-bold px-4 py-2 rounded-xl text-sm transition-all"
                  style={{ background: 'linear-gradient(135deg, #3b82f6, #1d4ed8)', boxShadow: '0 4px 14px rgba(59,130,246,0.3)' }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
                  Print / Save PDF
                </button>
                <button onClick={() => setShowProposal(false)} className="text-slate-400 hover:text-slate-700 text-xl leading-none">✕</button>
              </div>
            </div>

            {/* Proposal content */}
            <div id="proposal-content" className="p-8 space-y-6">
              {/* Header */}
              <div className="text-center border-b pb-6" style={{ borderColor: 'rgba(219,234,254,0.8)' }}>
                <div className="text-3xl font-black text-blue-600 mb-1">Project Proposal</div>
                <div className="text-xl font-bold text-slate-800">{project?.name}</div>
                <div className="text-slate-400 text-sm mt-1">
                  {project?.city && `${project.city}, `}{project?.region?.replace('US-', '')} · {new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                </div>
              </div>

              {/* Project Overview */}
              <div>
                <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Project Overview</div>
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { label: 'Project Type', value: project?.blueprint_type || 'Residential' },
                    { label: 'Location', value: [project?.city, project?.region?.replace('US-','')].filter(Boolean).join(', ') || '—' },
                    { label: 'Total Area', value: analysis?.total_sqft ? `${analysis.total_sqft.toLocaleString()} sq ft` : '—' },
                    { label: 'Rooms', value: analysis?.rooms?.length || '—' },
                  ].map(row => (
                    <div key={row.label} className="bg-slate-50 rounded-xl p-3">
                      <div className="text-slate-400 text-xs">{row.label}</div>
                      <div className="text-slate-800 font-bold text-sm mt-0.5">{row.value}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Scope of Work */}
              {Array.isArray(analysis?.rooms) && analysis.rooms.length > 0 && (
                <div>
                  <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Scope of Work</div>
                  <div className="bg-slate-50 rounded-xl p-4">
                    <div className="grid grid-cols-3 gap-2">
                      {analysis.rooms.slice(0, 9).map((room: any, i: number) => (
                        <div key={i} className="text-slate-600 text-sm">{room.name}{room.sqft ? ` (${Math.round(room.sqft)} sqft)` : ''}</div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Materials Summary */}
              {materials.length > 0 && (
                <div>
                  <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Materials Summary</div>
                  <div className="space-y-1">
                    {Object.entries(categoryTotals).sort((a, b) => b[1] - a[1]).map(([cat, total]) => {
                      const meta = CATEGORY_META[cat] || { label: cat, icon: '📦' }
                      return (
                        <div key={cat} className="flex justify-between items-center py-2 border-b" style={{ borderColor: 'rgba(219,234,254,0.6)' }}>
                          <span className="text-slate-600 text-sm flex items-center gap-2"><span>{meta.icon}</span>{meta.label}</span>
                          <span className="text-slate-800 font-semibold text-sm">{formatMoney(total as number)}</span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* Investment Summary */}
              {estimate && (() => {
                const matTotal = estimate.materials_total || 0
                const laborTotal = estimate.labor_total || 0
                const overhead = (matTotal + laborTotal) * 0.10
                const markupAmt = (matTotal + laborTotal + overhead) * ((estimate.markup_pct || 15) / 100)
                const grand = matTotal + laborTotal + overhead + markupAmt
                return (
                  <div>
                    <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Investment Summary</div>
                    <div className="bg-blue-600 rounded-2xl p-6 text-white text-center">
                      <div className="text-blue-100 text-sm mb-1">Total Project Investment</div>
                      <div className="text-4xl font-black">{formatMoney(grand)}</div>
                      <div className="flex justify-center gap-4 text-blue-200 text-xs mt-2">
                        <span>Materials: {formatMoney(matTotal)}</span>
                        <span>·</span>
                        <span>Labor: {formatMoney(laborTotal)}</span>
                      </div>
                    </div>
                  </div>
                )
              })()}

              {/* Footer */}
              <div className="text-center text-slate-400 text-xs pt-4 border-t" style={{ borderColor: 'rgba(219,234,254,0.8)' }}>
                This proposal is an estimate based on AI-powered blueprint analysis. Final pricing may vary based on site conditions, material availability, and local market rates.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Quote Request Modal */}
      {quoteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(15,23,42,0.6)', backdropFilter: 'blur(6px)' }} onClick={() => setQuoteModal(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: 'rgba(219,234,254,0.8)' }}>
              <div>
                <h2 className="text-slate-800 font-bold text-base">Quote Request — {quoteModal.vendor}</h2>
                <p className="text-slate-400 text-xs mt-0.5">Fill in your info, then copy the generated text to send to the distributor.</p>
              </div>
              <button onClick={() => setQuoteModal(null)} className="text-slate-400 hover:text-slate-700 text-lg font-light leading-none">✕</button>
            </div>
            <div className="px-6 py-5 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                {[
                  { key: 'name', label: 'Your Name', placeholder: 'John Smith' },
                  { key: 'company', label: 'Company', placeholder: 'Smith Roofing LLC' },
                  { key: 'phone', label: 'Phone', placeholder: '(555) 000-0000' },
                  { key: 'email', label: 'Email', placeholder: 'john@smithroofing.com' },
                  { key: 'branch', label: 'Preferred Branch / Location', placeholder: 'Chicago, IL branch' },
                ].map(f => (
                  <div key={f.key} className={f.key === 'branch' ? 'col-span-2' : ''}>
                    <label className="text-xs font-semibold text-slate-600 mb-1 block">{f.label}</label>
                    <input
                      value={(quoteForm as any)[f.key]}
                      onChange={e => setQuoteForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                      placeholder={f.placeholder}
                      className="w-full border rounded-xl px-3 py-2 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-blue-300"
                      style={{ borderColor: 'rgba(219,234,254,0.9)' }}
                    />
                  </div>
                ))}
                <div className="col-span-2">
                  <label className="text-xs font-semibold text-slate-600 mb-1 block">Additional Notes</label>
                  <textarea
                    value={quoteForm.notes}
                    onChange={e => setQuoteForm(prev => ({ ...prev, notes: e.target.value }))}
                    placeholder="Delivery requirements, timeline, special requests…"
                    rows={2}
                    className="w-full border rounded-xl px-3 py-2 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-blue-300 resize-none"
                    style={{ borderColor: 'rgba(219,234,254,0.9)' }}
                  />
                </div>
              </div>
              <div>
                <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Items ({quoteModal.items.length})</div>
                <div className="bg-slate-50 rounded-xl px-4 py-3 max-h-36 overflow-y-auto space-y-1">
                  {quoteModal.items.map((m: any, i: number) => (
                    <div key={i} className="flex justify-between text-xs text-slate-600">
                      <span className="truncate max-w-[60%]">{m.item_name}</span>
                      <span className="text-slate-400 ml-2">{m.quantity} {m.unit}</span>
                    </div>
                  ))}
                </div>
              </div>
              {!quoteGenerated ? (
                <button
                  onClick={() => setQuoteGenerated(true)}
                  className="w-full flex items-center justify-center gap-2 text-white font-bold py-3 rounded-xl text-sm transition-all"
                  style={{ background: 'linear-gradient(135deg, #f59e0b, #d97706)', boxShadow: '0 4px 14px rgba(245,158,11,0.3)' }}
                >
                  📋 Generate Quote Request
                </button>
              ) : (
                <div>
                  <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Quote Request Text</div>
                  <pre className="bg-slate-900 text-green-400 text-xs rounded-xl p-4 overflow-x-auto whitespace-pre-wrap font-mono leading-relaxed">{generateQuoteText()}</pre>
                  <div className="flex gap-2 mt-3">
                    <button
                      onClick={() => { navigator.clipboard.writeText(generateQuoteText()); setQuoteCopied(true); setTimeout(() => setQuoteCopied(false), 2000) }}
                      className={`flex-1 flex items-center justify-center gap-2 font-bold py-2.5 rounded-xl text-sm transition-all ${quoteCopied ? 'bg-emerald-600 text-white' : 'bg-slate-800 hover:bg-slate-900 text-white'}`}
                    >
                      {quoteCopied ? '✓ Copied!' : '📋 Copy to Clipboard'}
                    </button>
                    <a
                      href={quoteModal.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-bold bg-amber-500 hover:bg-amber-600 text-white transition-all"
                    >
                      Open {quoteModal.vendor}
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                    </a>
                  </div>
                  <p className="text-slate-400 text-[10px] mt-2 text-center">Copy this text and paste it into an email or the distributor's quote request form.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Blueprint Takeoff modal (Togal-style quantity extraction) ── */}
      {takeoffOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(15,23,42,0.72)', backdropFilter: 'blur(6px)' }}
          onClick={() => !takeoffApplying && setTakeoffOpen(false)}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl max-w-5xl w-full max-h-[88vh] overflow-hidden flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: 'rgba(226,232,240,0.8)' }}>
              <div>
                <h2 className="text-lg font-bold text-slate-800">📐 Blueprint Takeoff</h2>
                <p className="text-xs text-slate-500 mt-0.5">Per-room quantities extracted from the blueprint — review before applying to materials.</p>
              </div>
              <button
                onClick={() => !takeoffApplying && setTakeoffOpen(false)}
                className="text-slate-400 hover:text-slate-700 text-2xl leading-none"
                aria-label="Close"
              >×</button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-5">
              {takeoffLoading && (
                <div className="flex items-center justify-center py-16 text-slate-500 text-sm">
                  <svg className="animate-spin w-5 h-5 mr-3 text-amber-500" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>
                  Reading blueprint and computing quantities…
                </div>
              )}

              {!takeoffLoading && takeoffData && (
                <div className="space-y-5">
                  {/* Scale warning */}
                  {takeoffData.takeoff.scale?.unverified && (
                    <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
                      ⚠ {takeoffData.takeoff.scale.warning || 'Blueprint scale was not verified — confirm one dimension before ordering.'}
                    </div>
                  )}

                  {/* Top stats */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {[
                      { label: 'Total sqft', value: takeoffData.takeoff.totals.total_sqft.toLocaleString() },
                      { label: 'Rooms', value: takeoffData.takeoff.totals.room_count },
                      { label: 'Wall LF (total)', value: takeoffData.takeoff.walls.total_lf.toLocaleString() },
                      { label: 'Openings', value: `${takeoffData.takeoff.openings.doors}D / ${takeoffData.takeoff.openings.windows}W` },
                    ].map(s => (
                      <div key={s.label} className="rounded-xl border bg-slate-50 px-4 py-3" style={{ borderColor: 'rgba(226,232,240,0.9)' }}>
                        <div className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">{s.label}</div>
                        <div className="text-lg font-bold text-slate-800 mt-1">{s.value}</div>
                      </div>
                    ))}
                  </div>

                  {/* Rooms */}
                  {takeoffData.takeoff.rooms.length > 0 && (
                    <div>
                      <h3 className="text-sm font-bold text-slate-800 mb-2">Rooms ({takeoffData.takeoff.rooms.length})</h3>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead className="text-left text-slate-500">
                            <tr className="border-b" style={{ borderColor: 'rgba(226,232,240,0.8)' }}>
                              <th className="py-2 pr-3 font-semibold">Room</th>
                              <th className="py-2 pr-3 font-semibold text-right">Sqft</th>
                              <th className="py-2 pr-3 font-semibold text-right">Dimensions</th>
                              <th className="py-2 pr-3 font-semibold text-right">Perimeter</th>
                              <th className="py-2 pr-3 font-semibold text-right">Drywall</th>
                              <th className="py-2 pr-3 font-semibold">Flooring</th>
                            </tr>
                          </thead>
                          <tbody>
                            {takeoffData.takeoff.rooms.map((r, i) => (
                              <tr key={i} className="border-b" style={{ borderColor: 'rgba(241,245,249,0.9)' }}>
                                <td className="py-1.5 pr-3 text-slate-700 font-medium">{r.name}</td>
                                <td className="py-1.5 pr-3 text-right tabular-nums">{r.sqft.toLocaleString()}</td>
                                <td className="py-1.5 pr-3 text-right tabular-nums text-slate-500">{r.width_ft && r.depth_ft ? `${r.width_ft}×${r.depth_ft} ft` : '—'}</td>
                                <td className="py-1.5 pr-3 text-right tabular-nums text-slate-500">{r.perimeter_ft ?? '—'}</td>
                                <td className="py-1.5 pr-3 text-right tabular-nums text-slate-500">{r.drywall_sqft ?? '—'}</td>
                                <td className="py-1.5 pr-3 text-slate-500 capitalize">{r.flooring_type.replace(/_/g, ' ')}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* Material rows preview */}
                  <div>
                    <h3 className="text-sm font-bold text-slate-800 mb-2">Materials to be added ({takeoffData.material_rows.length})</h3>
                    <div className="rounded-xl border divide-y" style={{ borderColor: 'rgba(226,232,240,0.9)' }}>
                      {takeoffData.material_rows.map((row, i) => (
                        <div key={i} className="flex items-center justify-between px-4 py-2.5 text-xs">
                          <div>
                            <div className="font-semibold text-slate-700">{row.item_name}</div>
                            <div className="text-slate-400 capitalize">{row.category}</div>
                          </div>
                          <div className="tabular-nums text-slate-600 font-medium">
                            {row.quantity.toLocaleString()} {row.unit}
                          </div>
                        </div>
                      ))}
                      {takeoffData.material_rows.length === 0 && (
                        <div className="px-4 py-6 text-center text-xs text-slate-400">No quantities extracted. Try re-running blueprint analysis.</div>
                      )}
                    </div>
                    <p className="text-[11px] text-slate-400 mt-2">Unit costs start at $0 — use “Refresh All Prices” after applying to pull live vendor pricing.</p>
                  </div>
                </div>
              )}
            </div>

            <div className="px-6 py-4 border-t flex items-center justify-end gap-2" style={{ borderColor: 'rgba(226,232,240,0.8)' }}>
              <button
                onClick={() => setTakeoffOpen(false)}
                disabled={takeoffApplying}
                className="px-4 py-2 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-40"
              >Cancel</button>
              <button
                onClick={handleApplyTakeoff}
                disabled={takeoffApplying || takeoffLoading || !takeoffData || takeoffData.material_rows.length === 0}
                className="px-4 py-2 rounded-xl text-sm font-bold text-white disabled:opacity-40"
                style={{ background: 'linear-gradient(135deg, #f59e0b, #b45309)', boxShadow: '0 4px 14px rgba(245,158,11,0.25)' }}
              >
                {takeoffApplying ? 'Applying…' : 'Apply to materials list'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
