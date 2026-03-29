'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getUser } from '@/lib/auth'
import { api } from '@/lib/api'

type Stage = 'new' | 'contacted' | 'site_visit' | 'estimate_sent' | 'won' | 'lost'

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

const STAGES: { key: Stage; label: string; color: string; bg: string; dot: string }[] = [
  { key: 'new',           label: 'New Lead',       color: 'text-blue-600',   bg: 'bg-blue-50 border-blue-200',   dot: 'bg-blue-500' },
  { key: 'contacted',     label: 'Contacted',      color: 'text-purple-600', bg: 'bg-purple-50 border-purple-200', dot: 'bg-purple-500' },
  { key: 'site_visit',    label: 'Site Visit',     color: 'text-amber-600',  bg: 'bg-amber-50 border-amber-200', dot: 'bg-amber-500' },
  { key: 'estimate_sent', label: 'Estimate Sent',  color: 'text-orange-600', bg: 'bg-orange-50 border-orange-200', dot: 'bg-orange-500' },
  { key: 'won',           label: 'Won',            color: 'text-emerald-600',bg: 'bg-emerald-50 border-emerald-200', dot: 'bg-emerald-500' },
  { key: 'lost',          label: 'Lost',           color: 'text-slate-500',  bg: 'bg-slate-50 border-slate-200', dot: 'bg-slate-400' },
]

const STAGE_MAP = Object.fromEntries(STAGES.map(s => [s.key, s]))

const cardStyle = { boxShadow: '0 2px 12px rgba(59,130,246,0.08)', border: '1px solid rgba(219,234,254,0.8)' }

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}

function LeadCard({
  lead,
  onStageChange,
  onDelete,
  onEdit,
}: {
  lead: Lead
  onStageChange: (id: string, stage: Stage) => void
  onDelete: (id: string) => void
  onEdit: (lead: Lead) => void
}) {
  const stage = STAGE_MAP[lead.stage] || STAGE_MAP.new
  return (
    <div className="bg-white rounded-2xl p-5 flex flex-col gap-3 hover:shadow-md transition-all duration-200 group" style={cardStyle}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-slate-800 font-semibold text-sm leading-tight truncate">{lead.name}</div>
          {(lead.city || lead.state) && (
            <div className="text-slate-400 text-xs mt-0.5">{[lead.city, lead.state].filter(Boolean).join(', ')}</div>
          )}
        </div>
        <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full border flex-shrink-0 ${stage.bg} ${stage.color}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${stage.dot}`} />
          {stage.label}
        </span>
      </div>

      <div className="flex flex-col gap-1 text-xs text-slate-500">
        {lead.phone && <span>📞 {lead.phone}</span>}
        {lead.email && <span>✉ {lead.email}</span>}
        {lead.address && <span className="truncate">📍 {lead.address}</span>}
      </div>

      {lead.estimated_value > 0 && (
        <div className="text-sm font-bold text-emerald-600">{fmt(lead.estimated_value)}</div>
      )}

      {lead.notes && (
        <div className="text-xs text-slate-400 italic line-clamp-2 border-t pt-2" style={{ borderColor: 'rgba(219,234,254,0.6)' }}>
          {lead.notes}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1 border-t opacity-0 group-hover:opacity-100 transition-all" style={{ borderColor: 'rgba(219,234,254,0.6)' }}>
        <select
          value={lead.stage}
          onChange={e => onStageChange(lead.id, e.target.value as Stage)}
          className="flex-1 text-xs bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 text-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-100"
        >
          {STAGES.map(s => (
            <option key={s.key} value={s.key}>{s.label}</option>
          ))}
        </select>
        <button
          onClick={() => onEdit(lead)}
          className="text-xs text-blue-600 hover:text-blue-800 font-medium px-2.5 py-1.5 rounded-lg bg-blue-50 hover:bg-blue-100 transition-all"
        >
          Edit
        </button>
        <button
          onClick={() => onDelete(lead.id)}
          className="text-xs text-red-400 hover:text-red-600 font-medium px-2.5 py-1.5 rounded-lg bg-red-50 hover:bg-red-100 transition-all"
        >
          ✕
        </button>
      </div>
    </div>
  )
}

const EMPTY_FORM = { name: '', phone: '', email: '', address: '', city: '', state: '', job_type: 'residential', stage: 'new' as Stage, notes: '', estimated_value: '' }

export default function CRMPage() {
  const router = useRouter()
  const [user, setUser] = useState<any>(null)
  const [leads, setLeads] = useState<Lead[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editingLead, setEditingLead] = useState<Lead | null>(null)
  const [form, setForm] = useState({ ...EMPTY_FORM })
  const [saving, setSaving] = useState(false)
  const [filterStage, setFilterStage] = useState<Stage | 'all'>('all')
  const [search, setSearch] = useState('')

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

  function openNew() {
    setEditingLead(null)
    setForm({ ...EMPTY_FORM })
    setShowForm(true)
  }

  function openEdit(lead: Lead) {
    setEditingLead(lead)
    setForm({
      name: lead.name,
      phone: lead.phone || '',
      email: lead.email || '',
      address: lead.address || '',
      city: lead.city || '',
      state: lead.state || '',
      job_type: lead.job_type || 'residential',
      stage: lead.stage,
      notes: lead.notes || '',
      estimated_value: lead.estimated_value ? String(lead.estimated_value) : '',
    })
    setShowForm(true)
  }

  async function handleSave() {
    if (!form.name.trim()) return
    setSaving(true)
    try {
      const payload = {
        ...form,
        estimated_value: parseFloat(form.estimated_value as string) || 0,
      }
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
    try {
      const updated = await api.crm.updateLead(id, { stage })
      setLeads(prev => prev.map(l => l.id === id ? updated : l))
    } catch {}
  }

  async function handleDelete(id: string) {
    try {
      await api.crm.deleteLead(id)
    } catch {}
    setLeads(prev => prev.filter(l => l.id !== id))
  }

  const filtered = leads.filter(l => {
    const matchStage = filterStage === 'all' || l.stage === filterStage
    const matchSearch = !search || l.name.toLowerCase().includes(search.toLowerCase()) ||
      l.city?.toLowerCase().includes(search.toLowerCase()) ||
      l.email?.toLowerCase().includes(search.toLowerCase())
    return matchStage && matchSearch
  })

  // Pipeline summary
  const totalValue = leads.filter(l => l.stage === 'won').reduce((s, l) => s + (l.estimated_value || 0), 0)
  const pipelineValue = leads.filter(l => !['won','lost'].includes(l.stage)).reduce((s, l) => s + (l.estimated_value || 0), 0)
  const wonCount = leads.filter(l => l.stage === 'won').length

  const inputCls = 'w-full bg-slate-50 border border-slate-200 focus:border-blue-400 focus:ring-2 focus:ring-blue-100 rounded-xl px-4 py-2.5 text-slate-700 placeholder-slate-300 focus:outline-none transition-all text-sm'
  const labelCls = 'block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5'

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-black text-slate-800">CRM</h1>
          <p className="text-slate-400 text-sm mt-0.5">Track leads through your sales pipeline</p>
        </div>
        <button
          onClick={openNew}
          className="flex items-center gap-2 text-white font-bold px-5 py-2.5 rounded-xl text-sm transition-all hover:scale-[1.02]"
          style={{ background: 'linear-gradient(135deg, #3b82f6, #1d4ed8)', boxShadow: '0 4px 14px rgba(59,130,246,0.3)' }}
        >
          + Add Lead
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        {[
          { label: 'Total Leads', value: leads.length, icon: '👥', color: 'bg-blue-50' },
          { label: 'Active Pipeline', value: fmt(pipelineValue), icon: '📈', color: 'bg-amber-50' },
          { label: 'Jobs Won', value: wonCount, icon: '🏆', color: 'bg-emerald-50' },
          { label: 'Won Revenue', value: fmt(totalValue), icon: '💰', color: 'bg-purple-50' },
        ].map(stat => (
          <div key={stat.label} className="bg-white rounded-2xl p-4 flex items-center gap-3" style={cardStyle}>
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-lg flex-shrink-0 ${stat.color}`}>
              {stat.icon}
            </div>
            <div>
              <div className="text-xl font-black text-slate-800">{stat.value}</div>
              <div className="text-slate-400 text-xs">{stat.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Pipeline stage tabs */}
      <div className="flex items-center gap-2 mb-5 flex-wrap">
        <button
          onClick={() => setFilterStage('all')}
          className={`px-4 py-2 rounded-xl text-sm font-semibold transition-all ${filterStage === 'all' ? 'bg-blue-600 text-white shadow-sm' : 'bg-white text-slate-500 hover:bg-blue-50 hover:text-blue-600'}`}
          style={filterStage !== 'all' ? cardStyle : {}}
        >
          All ({leads.length})
        </button>
        {STAGES.map(s => {
          const count = leads.filter(l => l.stage === s.key).length
          return (
            <button
              key={s.key}
              onClick={() => setFilterStage(s.key)}
              className={`px-4 py-2 rounded-xl text-sm font-semibold transition-all ${filterStage === s.key ? 'bg-blue-600 text-white shadow-sm' : 'bg-white text-slate-500 hover:bg-blue-50'}`}
              style={filterStage !== s.key ? cardStyle : {}}
            >
              {s.label} {count > 0 && <span className="ml-1 opacity-70">({count})</span>}
            </button>
          )
        })}
      </div>

      {/* Search */}
      <div className="relative mb-5 max-w-sm">
        <svg className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input
          value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search leads…"
          className="w-full bg-white rounded-xl pl-9 pr-4 py-2.5 text-sm text-slate-700 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-200 transition-all"
          style={cardStyle}
        />
      </div>

      {/* Leads grid */}
      {loading ? (
        <div className="flex items-center justify-center py-24 text-slate-400">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-24">
          <div className="text-4xl mb-3">👥</div>
          <div className="text-slate-600 font-semibold">No leads yet</div>
          <div className="text-slate-400 text-sm mt-1">Click "+ Add Lead" to add your first prospect.</div>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filtered.map(lead => (
            <LeadCard
              key={lead.id}
              lead={lead}
              onStageChange={handleStageChange}
              onDelete={handleDelete}
              onEdit={openEdit}
            />
          ))}
        </div>
      )}

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
                <div>
                  <label className={labelCls}>Phone</label>
                  <input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} className={inputCls} placeholder="(910) 555-0100" />
                </div>
                <div>
                  <label className={labelCls}>Email</label>
                  <input value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} className={inputCls} placeholder="john@email.com" type="email" />
                </div>
              </div>
              <div>
                <label className={labelCls}>Address</label>
                <input value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} className={inputCls} placeholder="123 Oak St" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>City</label>
                  <input value={form.city} onChange={e => setForm(f => ({ ...f, city: e.target.value }))} className={inputCls} placeholder="Wilmington" />
                </div>
                <div>
                  <label className={labelCls}>State</label>
                  <input value={form.state} onChange={e => setForm(f => ({ ...f, state: e.target.value }))} className={inputCls} placeholder="NC" maxLength={2} />
                </div>
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
              <div>
                <label className={labelCls}>Estimated Value ($)</label>
                <input value={form.estimated_value} onChange={e => setForm(f => ({ ...f, estimated_value: e.target.value }))} className={inputCls} placeholder="15000" type="number" min="0" />
              </div>
              <div>
                <label className={labelCls}>Notes</label>
                <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} className={`${inputCls} resize-none`} rows={3} placeholder="Any relevant details about this lead…" />
              </div>
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
