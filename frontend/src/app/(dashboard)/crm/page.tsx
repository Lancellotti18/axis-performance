'use client'
import { useEffect, useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { getUser } from '@/lib/auth'
import { api } from '@/lib/api'

type Stage = 'new' | 'contacted' | 'site_visit' | 'estimate_sent' | 'won' | 'lost'
type ViewMode = 'kanban' | 'list'

interface Lead {
  id: string
  name: string
  phone: string
  email: string
  address: string
  city: string
  state: string
  job_type: string
  stage: Stage
  notes: string
  estimated_value: number
  created_at: string
}

const STAGES: { key: Stage; label: string; color: string; bg: string; dot: string; colBg: string; headerBg: string }[] = [
  { key: 'new',           label: 'New Lead',      color: 'text-blue-700',   bg: 'bg-blue-50 border-blue-200',     dot: 'bg-blue-500',    colBg: 'bg-blue-50/40',   headerBg: 'bg-blue-100/60' },
  { key: 'contacted',     label: 'Contacted',     color: 'text-violet-700', bg: 'bg-violet-50 border-violet-200', dot: 'bg-violet-500',  colBg: 'bg-violet-50/40', headerBg: 'bg-violet-100/60' },
  { key: 'site_visit',    label: 'Site Visit',    color: 'text-amber-700',  bg: 'bg-amber-50 border-amber-200',   dot: 'bg-amber-500',   colBg: 'bg-amber-50/40',  headerBg: 'bg-amber-100/60' },
  { key: 'estimate_sent', label: 'Estimate Sent', color: 'text-orange-700', bg: 'bg-orange-50 border-orange-200', dot: 'bg-orange-500',  colBg: 'bg-orange-50/40', headerBg: 'bg-orange-100/60' },
  { key: 'won',           label: 'Won',           color: 'text-emerald-700',bg: 'bg-emerald-50 border-emerald-200',dot: 'bg-emerald-500',colBg: 'bg-emerald-50/40',headerBg: 'bg-emerald-100/60' },
  { key: 'lost',          label: 'Lost',          color: 'text-slate-500',  bg: 'bg-slate-50 border-slate-200',   dot: 'bg-slate-400',   colBg: 'bg-slate-50/40',  headerBg: 'bg-slate-100/60' },
]
const STAGE_MAP = Object.fromEntries(STAGES.map(s => [s.key, s]))

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}

const cardStyle = { boxShadow: '0 2px 12px rgba(59,130,246,0.08)', border: '1px solid rgba(219,234,254,0.8)' }
const EMPTY_FORM = { name: '', phone: '', email: '', address: '', city: '', state: '', job_type: 'residential', stage: 'new' as Stage, notes: '', estimated_value: '' }

// ── Kanban card ───────────────────────────────────────────────────────────────
function KanbanCard({
  lead, isDragging, onDragStart, onDragEnd, onEdit, onDelete, onMove,
}: {
  lead: Lead
  isDragging: boolean
  onDragStart: () => void
  onDragEnd: () => void
  onEdit: () => void
  onDelete: () => void
  onMove: (dir: 'left' | 'right') => void
}) {
  const stageIdx = STAGES.findIndex(s => s.key === lead.stage)
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={`bg-white rounded-xl p-4 cursor-grab active:cursor-grabbing select-none transition-all ${isDragging ? 'opacity-40 scale-95 rotate-1' : 'hover:shadow-md hover:-translate-y-0.5'}`}
      style={{ boxShadow: isDragging ? 'none' : '0 2px 8px rgba(59,130,246,0.1)', border: '1px solid rgba(219,234,254,0.9)' }}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="text-slate-800 font-semibold text-sm leading-tight">{lead.name}</div>
        {lead.estimated_value > 0 && (
          <span className="text-emerald-600 font-black text-xs flex-shrink-0">{fmt(lead.estimated_value)}</span>
        )}
      </div>

      {(lead.city || lead.state) && (
        <div className="text-slate-400 text-xs mb-1.5">📍 {[lead.city, lead.state].filter(Boolean).join(', ')}</div>
      )}

      {lead.job_type && (
        <div className="inline-block text-[10px] font-semibold bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full mb-2 capitalize">{lead.job_type}</div>
      )}

      {lead.notes && (
        <p className="text-slate-400 text-xs line-clamp-2 mb-2 italic">{lead.notes}</p>
      )}

      <div className="flex items-center justify-between mt-2 pt-2 border-t" style={{ borderColor: 'rgba(219,234,254,0.6)' }}>
        <div className="flex items-center gap-1">
          {stageIdx > 0 && (
            <button
              onClick={e => { e.stopPropagation(); onMove('left') }}
              className="p-1 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors"
              title="Move left"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="15 18 9 12 15 6"/></svg>
            </button>
          )}
          {stageIdx < STAGES.length - 1 && (
            <button
              onClick={e => { e.stopPropagation(); onMove('right') }}
              className="p-1 rounded hover:bg-blue-50 text-blue-400 hover:text-blue-600 transition-colors"
              title="Move right"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={e => { e.stopPropagation(); onEdit() }}
            className="p-1 rounded hover:bg-blue-50 text-slate-400 hover:text-blue-600 transition-colors"
            title="Edit"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button
            onClick={e => { e.stopPropagation(); onDelete() }}
            className="p-1 rounded hover:bg-red-50 text-slate-400 hover:text-red-500 transition-colors"
            title="Delete"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>
          </button>
        </div>
      </div>
    </div>
  )
}

// ── List row ──────────────────────────────────────────────────────────────────
function ListRow({ lead, onStageChange, onEdit, onDelete }: { lead: Lead; onStageChange: (id: string, s: Stage) => void; onEdit: (l: Lead) => void; onDelete: (id: string) => void }) {
  const stage = STAGE_MAP[lead.stage] || STAGE_MAP.new
  return (
    <div className="bg-white rounded-2xl px-5 py-4 flex items-center gap-4 hover:shadow-md transition-all" style={cardStyle}>
      <div className="flex-1 min-w-0">
        <div className="text-slate-800 font-semibold text-sm">{lead.name}</div>
        <div className="text-slate-400 text-xs mt-0.5">{[lead.city, lead.state, lead.job_type].filter(Boolean).join(' · ')}</div>
      </div>
      <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full border flex-shrink-0 ${stage.bg} ${stage.color}`}>
        <span className={`w-1.5 h-1.5 rounded-full ${stage.dot}`} />
        {stage.label}
      </span>
      {lead.estimated_value > 0 && <span className="text-emerald-600 font-bold text-sm flex-shrink-0">{fmt(lead.estimated_value)}</span>}
      <select
        value={lead.stage}
        onChange={e => onStageChange(lead.id, e.target.value as Stage)}
        className="text-xs bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 text-slate-600 focus:outline-none"
      >
        {STAGES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
      </select>
      <button onClick={() => onEdit(lead)} className="text-xs text-blue-600 font-medium px-2.5 py-1.5 rounded-lg bg-blue-50 hover:bg-blue-100 transition-all">Edit</button>
      <button onClick={() => onDelete(lead.id)} className="text-xs text-red-400 font-medium px-2.5 py-1.5 rounded-lg bg-red-50 hover:bg-red-100 transition-all">✕</button>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────
export default function CRMPage() {
  const router = useRouter()
  const [user, setUser] = useState<any>(null)
  const [leads, setLeads] = useState<Lead[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editingLead, setEditingLead] = useState<Lead | null>(null)
  const [form, setForm] = useState({ ...EMPTY_FORM })
  const [saving, setSaving] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('kanban')
  const [search, setSearch] = useState('')

  // Drag state
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragOverStage, setDragOverStage] = useState<Stage | null>(null)

  useEffect(() => {
    async function load() {
      const u = await getUser()
      if (!u) { router.push('/login'); return }
      setUser(u)
      try {
        const data = await api.crm.listLeads(u.id)
        setLeads(data || [])
      } catch {}
      setLoading(false)
    }
    load()
  }, [router])

  function openNew(defaultStage?: Stage) {
    setEditingLead(null)
    setForm({ ...EMPTY_FORM, stage: defaultStage || 'new' })
    setShowForm(true)
  }

  function openEdit(lead: Lead) {
    setEditingLead(lead)
    setForm({
      name: lead.name, phone: lead.phone || '', email: lead.email || '',
      address: lead.address || '', city: lead.city || '', state: lead.state || '',
      job_type: lead.job_type || 'residential', stage: lead.stage,
      notes: lead.notes || '', estimated_value: lead.estimated_value ? String(lead.estimated_value) : '',
    })
    setShowForm(true)
  }

  async function handleSave() {
    if (!form.name.trim()) return
    setSaving(true)
    try {
      const payload = { ...form, estimated_value: parseFloat(form.estimated_value as string) || 0 }
      if (editingLead) {
        const updated = await api.crm.updateLead(editingLead.id, payload)
        setLeads(prev => prev.map(l => l.id === editingLead.id ? updated : l))
      } else {
        const created = await api.crm.createLead(payload, user.id)
        setLeads(prev => [created, ...prev])
      }
      setShowForm(false)
    } catch {}
    setSaving(false)
  }

  async function handleStageChange(id: string, stage: Stage) {
    setLeads(prev => prev.map(l => l.id === id ? { ...l, stage } : l))
    try { await api.crm.updateLead(id, { stage }) } catch {}
  }

  async function handleDelete(id: string) {
    setLeads(prev => prev.filter(l => l.id !== id))
    try { await api.crm.deleteLead(id) } catch {}
  }

  function handleMove(lead: Lead, dir: 'left' | 'right') {
    const idx = STAGES.findIndex(s => s.key === lead.stage)
    const newIdx = dir === 'left' ? idx - 1 : idx + 1
    if (newIdx < 0 || newIdx >= STAGES.length) return
    handleStageChange(lead.id, STAGES[newIdx].key)
  }

  // Drag handlers
  function handleDragStart(leadId: string) { setDraggingId(leadId) }
  function handleDragEnd() { setDraggingId(null); setDragOverStage(null) }
  function handleDragOver(e: React.DragEvent, stage: Stage) { e.preventDefault(); setDragOverStage(stage) }
  function handleDrop(e: React.DragEvent, stage: Stage) {
    e.preventDefault()
    if (draggingId) {
      const lead = leads.find(l => l.id === draggingId)
      if (lead && lead.stage !== stage) handleStageChange(draggingId, stage)
    }
    setDraggingId(null)
    setDragOverStage(null)
  }

  const filtered = search
    ? leads.filter(l => l.name.toLowerCase().includes(search.toLowerCase()) || l.city?.toLowerCase().includes(search.toLowerCase()) || l.email?.toLowerCase().includes(search.toLowerCase()))
    : leads

  // Stats
  const pipelineValue = leads.filter(l => !['won', 'lost'].includes(l.stage)).reduce((s, l) => s + (l.estimated_value || 0), 0)
  const wonValue = leads.filter(l => l.stage === 'won').reduce((s, l) => s + (l.estimated_value || 0), 0)
  const wonCount = leads.filter(l => l.stage === 'won').length
  const convRate = leads.length > 0 ? Math.round((wonCount / leads.length) * 100) : 0

  const inputCls = 'w-full bg-slate-50 border border-slate-200 focus:border-blue-400 focus:ring-2 focus:ring-blue-100 rounded-xl px-4 py-2.5 text-slate-700 placeholder-slate-300 focus:outline-none transition-all text-sm'
  const labelCls = 'block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5'

  return (
    <div className="h-full flex flex-col" style={{ background: 'linear-gradient(135deg, #eef6ff 0%, #ffffff 100%)' }}>
      {/* Header */}
      <div className="bg-white border-b px-6 py-4 flex items-center gap-4 flex-shrink-0" style={{ borderColor: 'rgba(219,234,254,0.9)' }}>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-black text-slate-800">Pipeline</h1>
          <p className="text-slate-400 text-xs mt-0.5">Track leads through your sales pipeline</p>
        </div>

        {/* View toggle */}
        <div className="flex items-center gap-1 bg-slate-100 rounded-xl p-1">
          <button
            onClick={() => setViewMode('kanban')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${viewMode === 'kanban' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="3" width="5" height="18" rx="1"/><rect x="11" y="3" width="5" height="11" rx="1"/><rect x="19" y="3" width="2" height="15" rx="1"/></svg>
            Board
          </button>
          <button
            onClick={() => setViewMode('list')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${viewMode === 'list' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
            List
          </button>
        </div>

        {/* Search */}
        <div className="relative">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…" className="w-48 bg-slate-50 border border-slate-200 rounded-xl pl-8 pr-4 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-100" />
        </div>

        <button
          onClick={() => openNew()}
          className="flex items-center gap-2 text-white font-bold px-5 py-2 rounded-xl text-sm transition-all hover:scale-[1.02]"
          style={{ background: 'linear-gradient(135deg, #3b82f6, #1d4ed8)', boxShadow: '0 4px 14px rgba(59,130,246,0.3)' }}
        >
          + Add Lead
        </button>
      </div>

      {/* Stats bar */}
      <div className="flex gap-4 px-6 py-4 flex-shrink-0">
        {[
          { label: 'Total Leads', value: leads.length, icon: '👥', sub: `${filtered.length} shown` },
          { label: 'Active Pipeline', value: fmt(pipelineValue), icon: '📈', sub: `${leads.filter(l => !['won','lost'].includes(l.stage)).length} active` },
          { label: 'Jobs Won', value: wonCount, icon: '🏆', sub: `${convRate}% close rate` },
          { label: 'Won Revenue', value: fmt(wonValue), icon: '💰', sub: 'closed deals' },
        ].map(stat => (
          <div key={stat.label} className="bg-white rounded-2xl px-4 py-3 flex items-center gap-3 flex-1" style={cardStyle}>
            <div className="w-9 h-9 rounded-xl flex items-center justify-center text-base bg-blue-50 flex-shrink-0">{stat.icon}</div>
            <div className="min-w-0">
              <div className="text-lg font-black text-slate-800 leading-tight">{stat.value}</div>
              <div className="text-slate-400 text-xs">{stat.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden px-6 pb-6">
        {loading ? (
          <div className="flex items-center justify-center h-full text-slate-400">Loading…</div>
        ) : viewMode === 'kanban' ? (
          /* ── KANBAN BOARD ── */
          <div className="h-full overflow-x-auto">
            <div className="flex gap-4 h-full" style={{ minWidth: `${STAGES.length * 288}px` }}>
              {STAGES.map(stage => {
                const stageLeads = filtered.filter(l => l.stage === stage.key)
                const stageValue = stageLeads.reduce((s, l) => s + (l.estimated_value || 0), 0)
                const isOver = dragOverStage === stage.key
                return (
                  <div
                    key={stage.key}
                    className={`flex flex-col rounded-2xl flex-shrink-0 transition-all ${isOver ? 'ring-2 ring-blue-400 ring-offset-1' : ''}`}
                    style={{ width: 272, background: isOver ? 'rgba(219,234,254,0.4)' : 'rgba(248,250,252,0.8)', border: '1px solid rgba(219,234,254,0.8)' }}
                    onDragOver={e => handleDragOver(e, stage.key)}
                    onDrop={e => handleDrop(e, stage.key)}
                    onDragLeave={() => setDragOverStage(null)}
                  >
                    {/* Column header */}
                    <div className={`px-4 py-3 rounded-t-2xl flex items-center justify-between flex-shrink-0 ${stage.headerBg}`}>
                      <div className="flex items-center gap-2">
                        <div className={`w-2.5 h-2.5 rounded-full ${stage.dot}`} />
                        <span className={`font-bold text-sm ${stage.color}`}>{stage.label}</span>
                        <span className="text-xs font-semibold bg-white/70 text-slate-500 px-1.5 py-0.5 rounded-full">{stageLeads.length}</span>
                      </div>
                      {stageValue > 0 && (
                        <span className="text-xs font-bold text-slate-600">{fmt(stageValue)}</span>
                      )}
                    </div>

                    {/* Cards */}
                    <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2 min-h-[100px]">
                      {stageLeads.map(lead => (
                        <KanbanCard
                          key={lead.id}
                          lead={lead}
                          isDragging={draggingId === lead.id}
                          onDragStart={() => handleDragStart(lead.id)}
                          onDragEnd={handleDragEnd}
                          onEdit={() => openEdit(lead)}
                          onDelete={() => handleDelete(lead.id)}
                          onMove={dir => handleMove(lead, dir)}
                        />
                      ))}
                      {stageLeads.length === 0 && !isOver && (
                        <div className="flex-1 flex items-center justify-center text-slate-300 text-xs text-center py-6">
                          Drop leads here
                        </div>
                      )}
                    </div>

                    {/* Add button */}
                    <button
                      onClick={() => openNew(stage.key)}
                      className="m-3 py-2 text-xs text-slate-400 hover:text-slate-600 border border-dashed border-slate-300 hover:border-slate-400 rounded-xl transition-all hover:bg-white/50"
                    >
                      + Add lead
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        ) : (
          /* ── LIST VIEW ── */
          <div className="space-y-3 overflow-y-auto h-full">
            {filtered.length === 0 ? (
              <div className="text-center py-24">
                <div className="text-4xl mb-3">👥</div>
                <div className="text-slate-600 font-semibold">No leads yet</div>
                <div className="text-slate-400 text-sm mt-1">Click "+ Add Lead" to add your first prospect.</div>
              </div>
            ) : (
              filtered.map(lead => (
                <ListRow key={lead.id} lead={lead} onStageChange={handleStageChange} onEdit={openEdit} onDelete={handleDelete} />
              ))
            )}
          </div>
        )}
      </div>

      {/* Add/Edit modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(15,23,42,0.4)', backdropFilter: 'blur(4px)' }}>
          <div className="bg-white rounded-2xl w-full max-w-lg shadow-2xl overflow-y-auto max-h-[90vh]" style={{ border: '1px solid rgba(219,234,254,0.8)' }}>
            <div className="flex items-center justify-between p-6 border-b" style={{ borderColor: 'rgba(219,234,254,0.8)' }}>
              <h2 className="text-lg font-bold text-slate-800">{editingLead ? 'Edit Lead' : 'New Lead'}</h2>
              <button onClick={() => setShowForm(false)} className="text-slate-400 hover:text-slate-700 transition-colors text-xl leading-none">✕</button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className={labelCls}>Name *</label>
                <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className={inputCls} placeholder="John Smith" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className={labelCls}>Phone</label><input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} className={inputCls} placeholder="(910) 555-0100" /></div>
                <div><label className={labelCls}>Email</label><input value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} className={inputCls} placeholder="john@email.com" type="email" /></div>
              </div>
              <div><label className={labelCls}>Address</label><input value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} className={inputCls} placeholder="123 Oak St" /></div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className={labelCls}>City</label><input value={form.city} onChange={e => setForm(f => ({ ...f, city: e.target.value }))} className={inputCls} placeholder="Wilmington" /></div>
                <div><label className={labelCls}>State</label><input value={form.state} onChange={e => setForm(f => ({ ...f, state: e.target.value }))} className={inputCls} placeholder="NC" maxLength={2} /></div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Job Type</label>
                  <select value={form.job_type} onChange={e => setForm(f => ({ ...f, job_type: e.target.value }))} className={inputCls}>
                    <option value="residential">Residential</option>
                    <option value="commercial">Commercial</option>
                    <option value="roofing">Roofing</option>
                    <option value="renovation">Renovation</option>
                    <option value="new_construction">New Construction</option>
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Stage</label>
                  <select value={form.stage} onChange={e => setForm(f => ({ ...f, stage: e.target.value as Stage }))} className={inputCls}>
                    {STAGES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
                  </select>
                </div>
              </div>
              <div><label className={labelCls}>Estimated Value ($)</label><input value={form.estimated_value} onChange={e => setForm(f => ({ ...f, estimated_value: e.target.value }))} className={inputCls} placeholder="15000" type="number" min="0" /></div>
              <div><label className={labelCls}>Notes</label><textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} className={`${inputCls} resize-none`} rows={3} placeholder="Any relevant details…" /></div>
            </div>
            <div className="flex gap-3 p-6 border-t" style={{ borderColor: 'rgba(219,234,254,0.8)' }}>
              <button onClick={() => setShowForm(false)} className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-slate-600 bg-slate-100 hover:bg-slate-200 transition-all">Cancel</button>
              <button
                onClick={handleSave}
                disabled={saving || !form.name.trim()}
                className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white transition-all disabled:opacity-40"
                style={{ background: 'linear-gradient(135deg, #3b82f6, #1d4ed8)', boxShadow: '0 4px 14px rgba(59,130,246,0.25)' }}
              >
                {saving ? 'Saving…' : editingLead ? 'Save Changes' : 'Add Lead'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
