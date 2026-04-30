'use client'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getUser } from '@/lib/auth'
import { api } from '@/lib/api'

type Stage = 'new' | 'contacted' | 'site_visit' | 'estimate_sent' | 'won' | 'lost'
type ViewMode = 'kanban' | 'list'

interface Lead {
  id: string
  name: string
  phone?: string
  email?: string
  address?: string
  city?: string
  state?: string
  job_type?: string
  stage: Stage
  notes?: string
  estimated_value?: number
  created_at: string
  updated_at?: string
  user_id?: string
}

interface Note {
  id: string
  lead_id: string
  text: string
  created_at: string
}

const STAGES: { key: Stage; label: string; color: string; bg: string; dot: string; colBg: string; headerBg: string }[] = [
  { key: 'new',           label: 'New Lead',      color: 'text-blue-700',    bg: 'bg-blue-50 border-blue-200',      dot: 'bg-blue-500',    colBg: 'bg-blue-50/40',    headerBg: 'bg-blue-100/60'    },
  { key: 'contacted',     label: 'Contacted',     color: 'text-violet-700',  bg: 'bg-violet-50 border-violet-200',  dot: 'bg-violet-500',  colBg: 'bg-violet-50/40',  headerBg: 'bg-violet-100/60'  },
  { key: 'site_visit',    label: 'Site Visit',    color: 'text-amber-700',   bg: 'bg-amber-50 border-amber-200',    dot: 'bg-amber-500',   colBg: 'bg-amber-50/40',   headerBg: 'bg-amber-100/60'   },
  { key: 'estimate_sent', label: 'Estimate Sent', color: 'text-orange-700',  bg: 'bg-orange-50 border-orange-200',  dot: 'bg-orange-500',  colBg: 'bg-orange-50/40',  headerBg: 'bg-orange-100/60'  },
  { key: 'won',           label: 'Won',           color: 'text-emerald-700', bg: 'bg-emerald-50 border-emerald-200',dot: 'bg-emerald-500', colBg: 'bg-emerald-50/40', headerBg: 'bg-emerald-100/60' },
  { key: 'lost',          label: 'Lost',          color: 'text-slate-500',   bg: 'bg-slate-50 border-slate-200',    dot: 'bg-slate-400',   colBg: 'bg-slate-50/40',   headerBg: 'bg-slate-100/60'   },
]
const STAGE_MAP = Object.fromEntries(STAGES.map(s => [s.key, s]))

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}

function timeAgo(ts: string) {
  const diff = Date.now() - new Date(ts).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  return new Date(ts).toLocaleDateString()
}

const cardStyle = { boxShadow: '0 2px 12px rgba(59,130,246,0.08)', border: '1px solid rgba(219,234,254,0.8)' }
const EMPTY_FORM = { name: '', phone: '', email: '', address: '', city: '', state: '', job_type: 'residential', stage: 'new' as Stage, notes: '', estimated_value: '' }
const inputCls = 'w-full bg-slate-50 border border-slate-200 focus:border-blue-400 focus:ring-2 focus:ring-blue-100 rounded-xl px-4 py-2.5 text-slate-700 placeholder-slate-300 focus:outline-none transition-all text-sm'
const labelCls = 'block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5'

// ── Kanban card ───────────────────────────────────────────────────────────────
function KanbanCard({ lead, isDragging, onDragStart, onDragEnd, onOpen, onDelete, onMove }: {
  lead: Lead; isDragging: boolean
  onDragStart: () => void; onDragEnd: () => void
  onOpen: () => void; onDelete: () => void; onMove: (dir: 'left' | 'right') => void
}) {
  const stageIdx = STAGES.findIndex(s => s.key === lead.stage)
  return (
    <div
      draggable onDragStart={onDragStart} onDragEnd={onDragEnd}
      onClick={onOpen}
      className={`bg-white rounded-xl p-4 cursor-pointer select-none transition-all ${isDragging ? 'opacity-40 scale-95 rotate-1' : 'hover:shadow-md hover:-translate-y-0.5'}`}
      style={{ boxShadow: isDragging ? 'none' : '0 2px 8px rgba(59,130,246,0.1)', border: '1px solid rgba(219,234,254,0.9)' }}
    >
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <div className="text-slate-800 font-semibold text-sm leading-tight">{lead.name}</div>
        {(lead.estimated_value ?? 0) > 0 && <span className="text-emerald-600 font-black text-xs flex-shrink-0">{fmt(lead.estimated_value!)}</span>}
      </div>
      {(lead.city || lead.state) && <div className="text-slate-400 text-xs mb-1">{[lead.city, lead.state].filter(Boolean).join(', ')}</div>}
      {lead.job_type && <div className="inline-block text-[10px] font-semibold bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full mb-2 capitalize">{lead.job_type}</div>}
      {lead.notes && <p className="text-slate-400 text-xs line-clamp-2 mb-2 italic">{lead.notes}</p>}
      <div className="flex items-center justify-between mt-2 pt-2 border-t" style={{ borderColor: 'rgba(219,234,254,0.6)' }}>
        <div className="flex items-center gap-1">
          {stageIdx > 0 && (
            <button onClick={e => { e.stopPropagation(); onMove('left') }} className="p-1 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="15 18 9 12 15 6"/></svg>
            </button>
          )}
          {stageIdx < STAGES.length - 1 && (
            <button onClick={e => { e.stopPropagation(); onMove('right') }} className="p-1 rounded hover:bg-blue-50 text-blue-400 hover:text-blue-600 transition-colors">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
          )}
        </div>
        <button onClick={e => { e.stopPropagation(); onDelete() }} className="p-1 rounded hover:bg-red-50 text-slate-300 hover:text-red-400 transition-colors">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>
        </button>
      </div>
    </div>
  )
}

// ── List row ──────────────────────────────────────────────────────────────────
function ListRow({ lead, onStageChange, onOpen, onDelete }: { lead: Lead; onStageChange: (id: string, s: Stage) => void; onOpen: () => void; onDelete: (id: string) => void }) {
  const stage = STAGE_MAP[lead.stage] || STAGE_MAP.new
  return (
    <div onClick={onOpen} className="bg-white rounded-2xl px-5 py-4 flex items-center gap-4 hover:shadow-md transition-all cursor-pointer" style={cardStyle}>
      <div className="flex-1 min-w-0">
        <div className="text-slate-800 font-semibold text-sm">{lead.name}</div>
        <div className="text-slate-400 text-xs mt-0.5">{[lead.city, lead.state, lead.job_type].filter(Boolean).join(' · ')}</div>
      </div>
      <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full border flex-shrink-0 ${stage.bg} ${stage.color}`}>
        <span className={`w-1.5 h-1.5 rounded-full ${stage.dot}`} />
        {stage.label}
      </span>
      {(lead.estimated_value ?? 0) > 0 && <span className="text-emerald-600 font-bold text-sm flex-shrink-0">{fmt(lead.estimated_value!)}</span>}
      <select
        value={lead.stage}
        onChange={e => { e.stopPropagation(); onStageChange(lead.id, e.target.value as Stage) }}
        onClick={e => e.stopPropagation()}
        className="text-xs bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 text-slate-600 focus:outline-none"
      >
        {STAGES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
      </select>
      <button onClick={e => { e.stopPropagation(); onDelete(lead.id) }} className="text-xs text-red-400 font-medium px-2.5 py-1.5 rounded-lg bg-red-50 hover:bg-red-100 transition-all"></button>
    </div>
  )
}

// ── Lead Detail Drawer ────────────────────────────────────────────────────────
function LeadDrawer({ lead, userId, onClose, onStageChange, onEdit, onDelete }: {
  lead: Lead; userId: string
  onClose: () => void
  onStageChange: (id: string, s: Stage) => void
  onEdit: (l: Lead) => void
  onDelete: (id: string) => void
}) {
  const [notes, setNotes]       = useState<Note[]>([])
  const [noteText, setNoteText] = useState('')
  const [addingNote, setAddingNote] = useState(false)
  const [loadingNotes, setLoadingNotes] = useState(true)
  const bottomRef = useRef<HTMLDivElement>(null)
  const stage = STAGE_MAP[lead.stage] || STAGE_MAP.new

  useEffect(() => {
    api.crm.getNotes(lead.id)
      .then(data => setNotes(data || []))
      .catch(() => {})
      .finally(() => setLoadingNotes(false))
  }, [lead.id])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [notes])

  async function handleAddNote() {
    if (!noteText.trim()) return
    setAddingNote(true)
    try {
      const note = await api.crm.addNote(lead.id, noteText.trim(), userId)
      setNotes(prev => [...prev, note])
      setNoteText('')
    } catch {}
    setAddingNote(false)
  }

  async function handleDeleteNote(noteId: string) {
    setNotes(prev => prev.filter(n => n.id !== noteId))
    try { await api.crm.deleteNote(lead.id, noteId) } catch {}
  }

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40 bg-black/20 backdrop-blur-sm" onClick={onClose} />

      {/* Drawer */}
      <div className="fixed right-0 top-0 bottom-0 z-50 w-full max-w-md bg-white flex flex-col"
        style={{ boxShadow: '-4px 0 40px rgba(0,0,0,0.12)' }}>

        {/* Header */}
        <div className="flex items-start justify-between px-5 py-4 border-b flex-shrink-0" style={{ borderColor: 'rgba(219,234,254,0.8)' }}>
          <div className="flex-1 min-w-0">
            <div className="text-slate-800 font-bold text-base leading-tight">{lead.name}</div>
            <div className="text-slate-400 text-xs mt-0.5">{[lead.job_type, lead.city, lead.state].filter(Boolean).join(' · ')}</div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0 ml-3">
            <button onClick={() => onEdit(lead)}
              className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-blue-50 text-blue-600 hover:bg-blue-100 transition-all">
              Edit
            </button>
            <button onClick={() => { onDelete(lead.id); onClose() }}
              className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-red-50 text-red-500 hover:bg-red-100 transition-all">
              Delete
            </button>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors ml-1">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto">

          {/* Contact info */}
          <div className="px-5 py-4 space-y-3 border-b" style={{ borderColor: 'rgba(219,234,254,0.6)' }}>
            {lead.phone && (
              <a href={`tel:${lead.phone}`} className="flex items-center gap-3 text-sm text-slate-700 hover:text-blue-600 transition-colors group">
                <div className="w-8 h-8 rounded-xl bg-blue-50 flex items-center justify-center flex-shrink-0 group-hover:bg-blue-100 transition-colors">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.81a19.79 19.79 0 01-3.07-8.63A2 2 0 012 .18h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 8.09a16 16 0 006 9.91"/></svg>
                </div>
                {lead.phone}
              </a>
            )}
            {lead.email && (
              <a href={`mailto:${lead.email}`} className="flex items-center gap-3 text-sm text-slate-700 hover:text-blue-600 transition-colors group">
                <div className="w-8 h-8 rounded-xl bg-blue-50 flex items-center justify-center flex-shrink-0 group-hover:bg-blue-100 transition-colors">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
                </div>
                {lead.email}
              </a>
            )}
            {lead.address && (
              <div className="flex items-center gap-3 text-sm text-slate-600">
                <div className="w-8 h-8 rounded-xl bg-slate-50 flex items-center justify-center flex-shrink-0">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2" strokeLinecap="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
                </div>
                {[lead.address, lead.city, lead.state].filter(Boolean).join(', ')}
              </div>
            )}
          </div>

          {/* Stage + value */}
          <div className="px-5 py-4 flex items-center gap-4 border-b" style={{ borderColor: 'rgba(219,234,254,0.6)' }}>
            <div className="flex-1">
              <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Stage</div>
              <select
                value={lead.stage}
                onChange={e => onStageChange(lead.id, e.target.value as Stage)}
                className={`text-sm border rounded-xl px-3 py-2 font-semibold focus:outline-none focus:ring-2 focus:ring-blue-100 ${stage.bg} ${stage.color}`}
                style={{ borderColor: 'currentColor' }}
              >
                {STAGES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </div>
            {(lead.estimated_value ?? 0) > 0 && (
              <div className="text-right">
                <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">Est. Value</div>
                <div className="text-emerald-600 font-black text-xl">{fmt(lead.estimated_value!)}</div>
              </div>
            )}
          </div>

          {/* Description / notes field */}
          {lead.notes && (
            <div className="px-5 py-4 border-b" style={{ borderColor: 'rgba(219,234,254,0.6)' }}>
              <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Description</div>
              <p className="text-slate-600 text-sm leading-relaxed">{lead.notes}</p>
            </div>
          )}

          {/* Activity notes */}
          <div className="px-5 py-4">
            <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Activity Log</div>

            {loadingNotes ? (
              <div className="text-center py-6 text-slate-300 text-sm">Loading…</div>
            ) : notes.length === 0 ? (
              <div className="text-center py-6 text-slate-300 text-sm">No notes yet — add the first one below.</div>
            ) : (
              <div className="space-y-3 mb-4">
                {notes.map(note => (
                  <div key={note.id} className="flex items-start gap-3 group">
                    <div className="w-6 h-6 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0 mt-0.5">
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2.5" strokeLinecap="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-slate-700 text-sm leading-relaxed">{note.text}</p>
                      <div className="text-slate-400 text-[10px] mt-0.5">{timeAgo(note.created_at)}</div>
                    </div>
                    <button
                      onClick={() => handleDeleteNote(note.id)}
                      className="opacity-0 group-hover:opacity-100 transition-opacity text-slate-300 hover:text-red-400 flex-shrink-0 mt-0.5"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                  </div>
                ))}
                <div ref={bottomRef} />
              </div>
            )}
          </div>
        </div>

        {/* Add note input — pinned to bottom */}
        <div className="px-5 py-4 border-t flex-shrink-0" style={{ borderColor: 'rgba(219,234,254,0.8)' }}>
          <div className="flex gap-2">
            <input
              value={noteText}
              onChange={e => setNoteText(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleAddNote()}
              placeholder="Add a note… (Enter to save)"
              className="flex-1 bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm text-slate-700 placeholder-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-200 focus:border-blue-300 transition-all"
            />
            <button
              onClick={handleAddNote}
              disabled={!noteText.trim() || addingNote}
              className="px-4 py-2.5 rounded-xl text-white font-semibold text-sm transition-all disabled:opacity-40"
              style={{ background: 'linear-gradient(135deg, #3b82f6, #1d4ed8)' }}
            >
              {addingNote ? '…' : 'Add'}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function CRMPage() {
  const router = useRouter()
  const [user, setUser]           = useState<any>(null)
  const [leads, setLeads]         = useState<Lead[]>([])
  const [loading, setLoading]     = useState(true)
  const [showForm, setShowForm]   = useState(false)
  const [editingLead, setEditingLead] = useState<Lead | null>(null)
  const [openLead, setOpenLead]   = useState<Lead | null>(null)
  const [form, setForm]           = useState({ ...EMPTY_FORM })
  const [saving, setSaving]       = useState(false)
  const [viewMode, setViewMode]   = useState<ViewMode>('kanban')
  const [search, setSearch]       = useState('')
  const [draggingId, setDraggingId]     = useState<string | null>(null)
  const [dragOverStage, setDragOverStage] = useState<Stage | null>(null)

  useEffect(() => {
    async function load() {
      const u = await getUser()
      if (!u) { router.push('/login'); return }
      setUser(u)
      try { setLeads(await api.crm.listLeads(u.id) || []) } catch {}
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
    if (!form.name.trim() || !user) return
    setSaving(true)
    try {
      const payload = { ...form, estimated_value: parseFloat(form.estimated_value as string) || 0 }
      if (editingLead) {
        const updated = await api.crm.updateLead(editingLead.id, payload)
        setLeads(prev => prev.map(l => l.id === editingLead.id ? updated : l))
        if (openLead?.id === editingLead.id) setOpenLead(updated)
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
    if (openLead?.id === id) setOpenLead(prev => prev ? { ...prev, stage } : prev)
    try { await api.crm.updateLead(id, { stage }) } catch {}
  }

  async function handleDelete(id: string) {
    setLeads(prev => prev.filter(l => l.id !== id))
    if (openLead?.id === id) setOpenLead(null)
    try { await api.crm.deleteLead(id) } catch {}
  }

  function handleMove(lead: Lead, dir: 'left' | 'right') {
    const idx = STAGES.findIndex(s => s.key === lead.stage)
    const newIdx = dir === 'left' ? idx - 1 : idx + 1
    if (newIdx < 0 || newIdx >= STAGES.length) return
    handleStageChange(lead.id, STAGES[newIdx].key)
  }

  function handleDragStart(leadId: string) { setDraggingId(leadId) }
  function handleDragEnd() { setDraggingId(null); setDragOverStage(null) }
  function handleDragOver(e: React.DragEvent, stage: Stage) { e.preventDefault(); setDragOverStage(stage) }
  function handleDrop(e: React.DragEvent, stage: Stage) {
    e.preventDefault()
    if (draggingId) {
      const lead = leads.find(l => l.id === draggingId)
      if (lead && lead.stage !== stage) handleStageChange(draggingId, stage)
    }
    setDraggingId(null); setDragOverStage(null)
  }

  const filtered = search
    ? leads.filter(l =>
        l.name.toLowerCase().includes(search.toLowerCase()) ||
        l.city?.toLowerCase().includes(search.toLowerCase()) ||
        l.email?.toLowerCase().includes(search.toLowerCase()) ||
        l.phone?.includes(search)
      )
    : leads

  const pipelineValue = leads.filter(l => !['won', 'lost'].includes(l.stage)).reduce((s, l) => s + (l.estimated_value || 0), 0)
  const wonValue      = leads.filter(l => l.stage === 'won').reduce((s, l) => s + (l.estimated_value || 0), 0)
  const wonCount      = leads.filter(l => l.stage === 'won').length
  const convRate      = leads.length > 0 ? Math.round((wonCount / leads.length) * 100) : 0

  return (
    <div className="h-full flex flex-col" style={{ background: 'linear-gradient(135deg, #eef6ff 0%, #ffffff 100%)' }}>

      {/* Header */}
      <div className="bg-white border-b px-6 py-4 flex items-center gap-4 flex-shrink-0" style={{ borderColor: 'rgba(219,234,254,0.9)' }}>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-black text-slate-800">Pipeline</h1>
          <p className="text-slate-400 text-xs mt-0.5">Track leads through your sales pipeline</p>
        </div>
        <div className="flex items-center gap-1 bg-slate-100 rounded-xl p-1">
          {(['kanban', 'list'] as const).map(m => (
            <button key={m} onClick={() => setViewMode(m)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all capitalize ${viewMode === m ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
              {m === 'kanban' ? (
                <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="3" width="5" height="18" rx="1"/><rect x="11" y="3" width="5" height="11" rx="1"/><rect x="19" y="3" width="2" height="15" rx="1"/></svg>Board</>
              ) : (
                <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>List</>
              )}
            </button>
          ))}
        </div>
        <div className="relative">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…" className="w-48 bg-slate-50 border border-slate-200 rounded-xl pl-8 pr-4 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-100" />
        </div>
        <button onClick={() => openNew()}
          className="flex items-center gap-2 text-white font-bold px-5 py-2 rounded-xl text-sm transition-all hover:scale-[1.02]"
          style={{ background: 'linear-gradient(135deg, #3b82f6, #1d4ed8)', boxShadow: '0 4px 14px rgba(59,130,246,0.3)' }}>
          + Add Lead
        </button>
      </div>

      {/* Stats */}
      <div className="flex gap-4 px-6 py-4 flex-shrink-0">
        {[
          { label: 'Total Leads',     value: leads.length,       icon: '', sub: `${filtered.length} shown` },
          { label: 'Active Pipeline', value: fmt(pipelineValue), icon: '', sub: `${leads.filter(l => !['won','lost'].includes(l.stage)).length} active` },
          { label: 'Jobs Won',        value: wonCount,            icon: '', sub: `${convRate}% close rate` },
          { label: 'Won Revenue',     value: fmt(wonValue),       icon: '', sub: 'closed deals' },
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

      {/* Board / List */}
      <div className="flex-1 overflow-hidden px-6 pb-6">
        {loading ? (
          <div className="flex items-center justify-center h-full text-slate-400">Loading…</div>
        ) : viewMode === 'kanban' ? (
          <div className="h-full overflow-x-auto">
            <div className="flex gap-4 h-full" style={{ minWidth: `${STAGES.length * 288}px` }}>
              {STAGES.map(stage => {
                const stageLeads = filtered.filter(l => l.stage === stage.key)
                const stageValue = stageLeads.reduce((s, l) => s + (l.estimated_value || 0), 0)
                const isOver = dragOverStage === stage.key
                return (
                  <div key={stage.key}
                    className={`flex flex-col rounded-2xl flex-shrink-0 transition-all ${isOver ? 'ring-2 ring-blue-400 ring-offset-1' : ''}`}
                    style={{ width: 272, background: isOver ? 'rgba(219,234,254,0.4)' : 'rgba(248,250,252,0.8)', border: '1px solid rgba(219,234,254,0.8)' }}
                    onDragOver={e => handleDragOver(e, stage.key)}
                    onDrop={e => handleDrop(e, stage.key)}
                    onDragLeave={() => setDragOverStage(null)}
                  >
                    <div className={`px-4 py-3 rounded-t-2xl flex items-center justify-between flex-shrink-0 ${stage.headerBg}`}>
                      <div className="flex items-center gap-2">
                        <div className={`w-2.5 h-2.5 rounded-full ${stage.dot}`} />
                        <span className={`font-bold text-sm ${stage.color}`}>{stage.label}</span>
                        <span className="text-xs font-semibold bg-white/70 text-slate-500 px-1.5 py-0.5 rounded-full">{stageLeads.length}</span>
                      </div>
                      {stageValue > 0 && <span className="text-xs font-bold text-slate-600">{fmt(stageValue)}</span>}
                    </div>
                    <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2 min-h-[100px]">
                      {stageLeads.map(lead => (
                        <KanbanCard key={lead.id} lead={lead}
                          isDragging={draggingId === lead.id}
                          onDragStart={() => handleDragStart(lead.id)}
                          onDragEnd={handleDragEnd}
                          onOpen={() => setOpenLead(lead)}
                          onDelete={() => handleDelete(lead.id)}
                          onMove={dir => handleMove(lead, dir)}
                        />
                      ))}
                      {stageLeads.length === 0 && !isOver && (
                        <div className="flex-1 flex items-center justify-center text-slate-300 text-xs text-center py-6">Drop leads here</div>
                      )}
                    </div>
                    <button onClick={() => openNew(stage.key)}
                      className="m-3 py-2 text-xs text-slate-400 hover:text-slate-600 border border-dashed border-slate-300 hover:border-slate-400 rounded-xl transition-all hover:bg-white/50">
                      + Add lead
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        ) : (
          <div className="space-y-3 overflow-y-auto h-full">
            {filtered.length === 0 ? (
              <div className="text-center py-24">
                <div className="text-4xl mb-3"></div>
                <div className="text-slate-600 font-semibold">No leads yet</div>
                <div className="text-slate-400 text-sm mt-1">Click "+ Add Lead" to add your first prospect.</div>
              </div>
            ) : filtered.map(lead => (
              <ListRow key={lead.id} lead={lead}
                onStageChange={handleStageChange}
                onOpen={() => setOpenLead(lead)}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </div>

      {/* Lead detail drawer */}
      {openLead && user && (
        <LeadDrawer
          lead={leads.find(l => l.id === openLead.id) || openLead}
          userId={user.id}
          onClose={() => setOpenLead(null)}
          onStageChange={handleStageChange}
          onEdit={lead => { setOpenLead(null); openEdit(lead) }}
          onDelete={handleDelete}
        />
      )}

      {/* Add / Edit modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(15,23,42,0.4)', backdropFilter: 'blur(4px)' }}>
          <div className="bg-white rounded-2xl w-full max-w-lg shadow-2xl overflow-y-auto max-h-[90vh]" style={{ border: '1px solid rgba(219,234,254,0.8)' }}>
            <div className="flex items-center justify-between p-6 border-b" style={{ borderColor: 'rgba(219,234,254,0.8)' }}>
              <h2 className="text-lg font-bold text-slate-800">{editingLead ? 'Edit Lead' : 'New Lead'}</h2>
              <button onClick={() => setShowForm(false)} className="text-slate-400 hover:text-slate-700 transition-colors text-xl leading-none"></button>
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
              <div><label className={labelCls}>Description / Notes</label><textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} className={`${inputCls} resize-none`} rows={3} placeholder="Job details, source, any relevant context…" /></div>
            </div>
            <div className="flex gap-3 p-6 border-t" style={{ borderColor: 'rgba(219,234,254,0.8)' }}>
              <button onClick={() => setShowForm(false)} className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-slate-600 bg-slate-100 hover:bg-slate-200 transition-all">Cancel</button>
              <button onClick={handleSave} disabled={saving || !form.name.trim()}
                className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white transition-all disabled:opacity-40"
                style={{ background: 'linear-gradient(135deg, #3b82f6, #1d4ed8)', boxShadow: '0 4px 14px rgba(59,130,246,0.25)' }}>
                {saving ? 'Saving…' : editingLead ? 'Save Changes' : 'Add Lead'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
