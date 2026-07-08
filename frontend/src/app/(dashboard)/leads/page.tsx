'use client'

/**
 * Lead Inbox — speed-to-lead command center.
 *
 * Every homeowner who used the instant-quote widget lands here with their
 * address, measured roof size, and the price range they saw. Pipeline chips
 * (new → contacted → quoted → won/lost), one-tap call/text/email, and the
 * widget settings + embed code live at the top.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'

import { api, type QuoteWidget, type WidgetLead } from '@/lib/api'

const STATUSES: { key: WidgetLead['status']; label: string; tone: string }[] = [
  { key: 'new', label: 'New', tone: 'bg-blue-500/20 text-blue-300 border-blue-400/40' },
  { key: 'contacted', label: 'Contacted', tone: 'bg-amber-500/20 text-amber-300 border-amber-400/40' },
  { key: 'quoted', label: 'Quoted', tone: 'bg-purple-500/20 text-purple-300 border-purple-400/40' },
  { key: 'won', label: 'Won', tone: 'bg-emerald-500/20 text-emerald-300 border-emerald-400/40' },
  { key: 'lost', label: 'Lost', tone: 'bg-slate-600/30 text-slate-400 border-slate-500/40' },
]

function ago(iso: string): string {
  const mins = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000))
  if (mins < 60) return `${mins}m ago`
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h ago`
  return `${Math.floor(mins / 1440)}d ago`
}

export default function LeadsPage() {
  const [widget, setWidget] = useState<QuoteWidget | null>(null)
  const [leads, setLeads] = useState<WidgetLead[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [filter, setFilter] = useState<string>('all')
  const [loading, setLoading] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [analytics, setAnalytics] = useState<{ funnel: Record<string, number>; leads_30d: number; avg_score: number | null } | null>(null)
  const [priceLow, setPriceLow] = useState('450')
  const [priceHigh, setPriceHigh] = useState('650')

  const refresh = useCallback(async () => {
    try {
      const res = await api.instantQuote.leads()
      setLeads(res.leads)
      setCounts(res.counts)
    } catch { /* transient */ }
  }, [])

  useEffect(() => {
    ;(async () => {
      try {
        const w = await api.instantQuote.myWidget()
        setWidget(w)
        setPriceLow(String(w.price_low)); setPriceHigh(String(w.price_high))
      } catch { /* widget optional */ }
      await refresh()
      setLoading(false)
      void api.instantQuote.analytics().then(setAnalytics).catch(() => {})
    })()
    const t = setInterval(refresh, 30000)   // speed-to-lead: keep the inbox fresh
    return () => clearInterval(t)
  }, [refresh])

  const setStatus = useCallback(async (lead: WidgetLead, status: WidgetLead['status']) => {
    setLeads(prev => prev.map(l => l.id === lead.id ? { ...l, status } : l))
    try {
      await api.instantQuote.updateLead(lead.id, { status })
      void refresh()
    } catch { toast.error('Could not update status') }
  }, [refresh])

  const saveSettings = useCallback(async () => {
    const lo = parseFloat(priceLow), hi = parseFloat(priceHigh)
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo <= 0 || hi < lo) {
      toast.error('Enter a valid price range (low ≤ high)'); return
    }
    try {
      const w = await api.instantQuote.updateWidget({ price_low: lo, price_high: hi })
      setWidget(w)
      toast.success('Widget settings saved')
    } catch { toast.error('Could not save settings') }
  }, [priceLow, priceHigh])

  const hostedUrl = widget ? `${typeof window !== 'undefined' ? window.location.origin : ''}/q/${widget.widget_key}` : ''
  const embedCode = widget
    ? `<iframe src="${hostedUrl}?embed=1" style="width:100%;max-width:640px;height:620px;border:0;border-radius:16px;" title="Instant roof quote"></iframe>`
    : ''

  const shown = useMemo(
    () => filter === 'all' ? leads : leads.filter(l => l.status === filter),
    [leads, filter],
  )
  const money = (v?: number | null) => v == null ? '—' : v.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
  const copy = (text: string, what: string) => {
    void navigator.clipboard.writeText(text).then(() => toast.success(`${what} copied`))
  }

  return (
    <main className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold text-white">Leads</h1>
          <p className="text-xs text-slate-400">
            Homeowners from your instant-quote tool. <strong>Speed wins jobs</strong> — call new leads within minutes.
          </p>
        </div>
        <span className="rounded-md border border-blue-400/30 bg-blue-500/10 px-2.5 py-1 text-xs text-blue-200">
          {counts.new || 0} new
        </span>
      </header>

      {/* Widget card */}
      <section className="rounded-xl border border-white/10 bg-slate-900/50 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">🎯 Your instant-quote tool</h2>
            <p className="text-xs text-slate-400">
              Put it on your website, Google Business Profile, Facebook, or a yard-sign QR code —
              every quote becomes a lead here.
            </p>
          </div>
          <button onClick={() => setSettingsOpen(o => !o)} className="rounded bg-slate-800 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-700">
            {settingsOpen ? 'Hide settings' : '⚙ Settings'}
          </button>
        </div>
        {widget && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <code className="max-w-full truncate rounded bg-slate-800 px-2 py-1.5 font-mono text-[11px] text-blue-200">{hostedUrl}</code>
            <button onClick={() => copy(hostedUrl, 'Link')} className="rounded bg-blue-600 px-2.5 py-1.5 font-semibold text-white hover:bg-blue-500">Copy link</button>
            <button onClick={() => copy(embedCode, 'Embed code')} className="rounded bg-slate-700 px-2.5 py-1.5 text-slate-200 hover:bg-slate-600">Copy website embed</button>
            <a href={hostedUrl} target="_blank" rel="noreferrer" className="rounded bg-slate-700 px-2.5 py-1.5 text-slate-200 hover:bg-slate-600">Preview ↗</a>
          </div>
        )}
        {settingsOpen && widget && (
          <div className="mt-3 flex flex-wrap items-end gap-3 rounded-lg border border-white/10 bg-slate-800/40 p-3 text-xs">
            <label className="text-slate-400">
              Price / square — low
              <input type="number" value={priceLow} onChange={e => setPriceLow(e.target.value)}
                className="mt-1 block w-28 rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-white" />
            </label>
            <label className="text-slate-400">
              Price / square — high
              <input type="number" value={priceHigh} onChange={e => setPriceHigh(e.target.value)}
                className="mt-1 block w-28 rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-white" />
            </label>
            <button onClick={saveSettings} className="rounded bg-emerald-600 px-3 py-1.5 font-semibold text-white hover:bg-emerald-500">Save</button>
            <span className="text-slate-500">A 25-square roof at $450–650/sq shows the homeowner ≈ $12,400–17,900.</span>
          </div>
        )}
      </section>

      {/* 30-day funnel */}
      {analytics && (analytics.leads_30d > 0 || Object.keys(analytics.funnel).length > 0) && (
        <section className="rounded-xl border border-white/10 bg-slate-900/50 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-100">📈 Last 30 days</h2>
            {analytics.avg_score != null && (
              <span className="text-xs text-slate-400">avg lead quality <strong className="text-white">{analytics.avg_score}</strong>/100</span>
            )}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            {([
              ['view', 'Views'],
              ['address_entered', 'Addresses'],
              ['roof_confirmed', 'Roofs confirmed'],
              ['qualified', 'Qualified'],
              ['lead_captured', 'Leads'],
            ] as [string, string][]).map(([k, label], i, arr) => (
              <span key={k} className="flex items-center gap-2">
                <span className="rounded-lg bg-slate-800/70 px-3 py-1.5 text-center">
                  <span className="block text-base font-bold text-white">{analytics.funnel[k] ?? 0}</span>
                  <span className="text-[10px] uppercase tracking-wide text-slate-500">{label}</span>
                </span>
                {i < arr.length - 1 && <span className="text-slate-600">→</span>}
              </span>
            ))}
            {(analytics.funnel.view ?? 0) > 0 && (
              <span className="ml-1 text-[11px] text-slate-500">
                {Math.round(((analytics.funnel.lead_captured ?? 0) / (analytics.funnel.view || 1)) * 100)}% completion
              </span>
            )}
          </div>
        </section>
      )}

      {/* Pipeline filter chips */}
      <div className="flex flex-wrap gap-2">
        <button onClick={() => setFilter('all')}
          className={`rounded-full border px-3 py-1 text-xs ${filter === 'all' ? 'border-white/40 bg-white/10 text-white' : 'border-white/10 bg-slate-900/50 text-slate-400 hover:text-white'}`}>
          All ({leads.length})
        </button>
        {STATUSES.map(s => (
          <button key={s.key} onClick={() => setFilter(s.key)}
            className={`rounded-full border px-3 py-1 text-xs ${filter === s.key ? s.tone : 'border-white/10 bg-slate-900/50 text-slate-400 hover:text-white'}`}>
            {s.label} ({counts[s.key] || 0})
          </button>
        ))}
      </div>

      {/* Leads */}
      {loading ? (
        <div className="flex justify-center py-16"><span className="h-6 w-6 animate-spin rounded-full border-2 border-blue-400 border-t-transparent" /></div>
      ) : shown.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/15 p-10 text-center text-sm text-slate-500">
          {leads.length === 0
            ? 'No leads yet. Copy your quote link above and put it everywhere a homeowner might see it.'
            : 'No leads in this stage.'}
        </div>
      ) : (
        <ul className="space-y-2">
          {shown.map(l => {
            const st = STATUSES.find(s => s.key === l.status) || STATUSES[0]
            return (
              <li key={l.id} className="rounded-xl border border-white/10 bg-slate-900/50 p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-white">{l.name}</span>
                      <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${st.tone}`}>{st.label}</span>
                      <span className="text-[11px] text-slate-500">{ago(l.created_at)}</span>
                      {l.status === 'new' && Date.now() - new Date(l.created_at).getTime() < 30 * 60000 && (
                        <span className="animate-pulse rounded bg-rose-500/20 px-1.5 py-0.5 text-[10px] font-bold text-rose-300">CALL NOW</span>
                      )}
                      {l.lead_score != null && (
                        <span
                          title={(l.score_reasons || []).join('\n') || 'Lead quality score'}
                          className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                            l.lead_score >= 80 ? 'bg-rose-500/20 text-rose-300'
                              : l.lead_score >= 60 ? 'bg-amber-500/20 text-amber-300'
                              : 'bg-slate-600/30 text-slate-400'
                          }`}
                        >{l.lead_score >= 80 ? '🔥 ' : ''}{l.lead_score}</span>
                      )}
                    </div>
                    <div className="mt-1 text-xs text-slate-300">{l.address}</div>
                    <div className="mt-1 text-[11px] text-slate-500">
                      {l.squares_estimate ? <>≈ {l.squares_estimate} squares · </> : null}
                      {l.price_low != null ? <>saw {money(l.price_low)}–{money(l.price_high)} · </> : null}
                      {l.quote_source === 'solar' ? 'solar-measured' : l.quote_source === 'footprint' ? 'outline-estimated' : 'not auto-measured'}
                    </div>
                    {(l.roof_age || l.stories || (l.issues || []).length > 0 || l.report_token) && (
                      <div className="mt-1 flex flex-wrap items-center gap-1">
                        {l.roof_age && <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">roof {l.roof_age} yrs</span>}
                        {l.stories && <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">{l.stories} stories</span>}
                        {(l.issues || []).map(i => (
                          <span key={i} className={`rounded px-1.5 py-0.5 text-[10px] ${
                            i === 'leak' || i === 'storm_damage' ? 'bg-rose-500/15 font-semibold text-rose-300' : 'bg-slate-800 text-slate-400'
                          }`}>{i.replace(/_/g, ' ')}</span>
                        ))}
                        {l.report_token && (
                          <a href={`/r/${l.report_token}`} target="_blank" rel="noreferrer"
                            className="rounded bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-blue-300 hover:bg-blue-500/30"
                            title="The report the homeowner saw">
                            📄 Report{(l.report_opens ?? 0) > 0 ? ` · ${l.report_opens} open${l.report_opens === 1 ? '' : 's'}` : ''}
                          </a>
                        )}
                      </div>
                    )}
                    {l.notes && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {l.notes.split(' · ').map(n => (
                          <span key={n} className={`rounded px-1.5 py-0.5 text-[10px] ${
                            n.toLowerCase().includes('insurance')
                              ? 'bg-rose-500/15 font-semibold text-rose-300'
                              : n.toLowerCase().includes('as soon as')
                                ? 'bg-emerald-500/15 font-semibold text-emerald-300'
                                : 'bg-slate-800 text-slate-400'
                          }`}>{n}</span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                    {l.phone && (
                      <>
                        <a href={`tel:${l.phone}`} className="rounded bg-emerald-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500">📞 Call</a>
                        <a href={`sms:${l.phone}`} className="rounded bg-blue-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-blue-500">💬 Text</a>
                      </>
                    )}
                    {l.email && (
                      <a href={`mailto:${l.email}`} className="rounded bg-slate-700 px-2.5 py-1.5 text-xs text-slate-100 hover:bg-slate-600">✉ Email</a>
                    )}
                    <select
                      value={l.status}
                      onChange={e => setStatus(l, e.target.value as WidgetLead['status'])}
                      className="rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-xs text-slate-200"
                    >
                      {STATUSES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
                    </select>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </main>
  )
}
