'use client'

import { useState } from 'react'
import { api } from '@/lib/api'
import { STATES } from '@/lib/jurisdictions'
import { AxisButton, SurfacePanel } from '@/components/axis'

const cardStyle = {} // legacy — Axis SurfacePanel now handles styling

const RISK_COLORS: Record<string, { bg: string; text: string; bar: string; badge: string }> = {
  emerald: { bg: 'bg-emerald-50', text: 'text-emerald-700', bar: 'bg-emerald-500', badge: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
  amber:   { bg: 'bg-amber-50',   text: 'text-amber-700',   bar: 'bg-amber-400',   badge: 'bg-amber-100 text-amber-700 border-amber-200'   },
  red:     { bg: 'bg-red-50',     text: 'text-red-700',     bar: 'bg-red-500',     badge: 'bg-red-100 text-red-700 border-red-200'         },
}

const PRIORITY_STYLE: Record<string, { label: string; chip: string }> = {
  high:   { label: 'High priority',   chip: 'bg-red-100 text-red-700 border-red-200' },
  medium: { label: 'Medium priority', chip: 'bg-amber-100 text-amber-700 border-amber-200' },
  low:    { label: 'Best practice',   chip: 'bg-blue-100 text-blue-700 border-blue-200' },
}

const HAZARD_ICON: Record<string, string> = {
  hail: '🧊',
  wind: '💨',
  tornado: '🌪',
  hurricane: '🌀',
  flood: '🌊',
  wildfire: '🔥',
  earthquake: '🌋',
  winter: '❄️',
}

// Choose per-bar color based on the hazard's own score, not the overall color
function barColorFor(score: number): string {
  if (score >= 8) return 'red'
  if (score >= 4) return 'amber'
  return 'emerald'
}

type Hazard = { key: string; label: string; score: number; rationale?: string }
type Recommendation = { hazard?: string; action: string; why?: string; priority?: string }
type RecentEvent = { year?: number | string; type?: string; severity?: string; impact?: string; source?: string }
type Article = { title?: string; url?: string; snippet?: string; published?: string | null; query?: string }

type RiskResult = {
  overall_risk?: number
  risk_label?: string
  risk_color?: string
  summary?: string
  scoring_rationale?: string
  significance?: string
  hazards?: Hazard[]
  recent_events?: RecentEvent[]
  reinforcement_recommendations?: Recommendation[]
  insurance_note?: string
  data_source?: string
  articles?: Article[]
  // legacy
  hail_risk?: number
  wind_risk?: number
  flood_risk?: number
}

function hostnameOf(url?: string): string {
  if (!url) return ''
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' }
}

function categoryFor(query?: string): { label: string; icon: string } {
  const q = (query || '').toLowerCase()
  if (q.includes('hurricane') || q.includes('tropical') || q.includes('flood')) return { label: 'Hurricane / Flood', icon: '🌀' }
  if (q.includes('tornado') || q.includes('hail')) return { label: 'Tornado / Hail',     icon: '🌪' }
  if (q.includes('wildfire'))                       return { label: 'Wildfire',          icon: '🔥' }
  if (q.includes('earthquake') || q.includes('seismic')) return { label: 'Earthquake',   icon: '🌋' }
  if (q.includes('fema'))                           return { label: 'FEMA Declaration',  icon: '📋' }
  if (q.includes('code'))                           return { label: 'Building Code',     icon: '📐' }
  return { label: 'Severe Weather', icon: '⚠️' }
}

function RiskBar({ label, score, icon }: { label: string; score: number; icon?: string }) {
  const c = RISK_COLORS[barColorFor(score)]
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-slate-600 text-xs font-semibold flex items-center gap-1.5">
          {icon && <span>{icon}</span>}
          {label}
        </span>
        <span className={`text-xs font-bold ${c.text}`}>{score}/10</span>
      </div>
      <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${c.bar}`} style={{ width: `${Math.max(0, Math.min(10, score)) * 10}%` }} />
      </div>
    </div>
  )
}

export default function StormReportPage() {
  const [city, setCity] = useState('')
  const [state, setState] = useState('')
  const [zip, setZip] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<RiskResult | null>(null)

  const canSubmit = city.trim().length > 0 && state.length > 0

  const handleSubmit = async () => {
    if (!canSubmit) return
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const res = await api.roofing.stormRisk(city.trim(), state, zip.trim())
      setResult(res as RiskResult)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Risk report failed. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  // Canonical 8-hazard spectrum — always shown on the graph so the user sees
  // the full disaster picture (flood, hail, earthquake, etc.) even if the LLM
  // omitted entries or returned a truncated `hazards` array.
  const HAZARD_SPECTRUM: Array<{ key: string; label: string }> = [
    { key: 'hail',       label: 'Hail' },
    { key: 'wind',       label: 'Wind / Severe Thunderstorm' },
    { key: 'tornado',    label: 'Tornado' },
    { key: 'hurricane',  label: 'Hurricane / Tropical Storm' },
    { key: 'flood',      label: 'Flood / Storm Surge' },
    { key: 'wildfire',   label: 'Wildfire' },
    { key: 'earthquake', label: 'Earthquake' },
    { key: 'winter',     label: 'Winter Storm / Ice' },
  ]

  // Build a lookup from whatever the backend gave us — supports both the new
  // structured hazards[] payload and the legacy hail_risk/wind_risk/flood_risk
  // top-level fields.
  const hazardMap = new Map<string, Hazard>()
  if (result?.hazards && Array.isArray(result.hazards)) {
    for (const h of result.hazards) {
      if (h?.key && typeof h.score === 'number') hazardMap.set(h.key, h)
    }
  }
  if (typeof result?.hail_risk  === 'number' && !hazardMap.has('hail'))  hazardMap.set('hail',  { key: 'hail',  label: 'Hail',  score: result.hail_risk })
  if (typeof result?.wind_risk  === 'number' && !hazardMap.has('wind'))  hazardMap.set('wind',  { key: 'wind',  label: 'Wind',  score: result.wind_risk })
  if (typeof result?.flood_risk === 'number' && !hazardMap.has('flood')) hazardMap.set('flood', { key: 'flood', label: 'Flood', score: result.flood_risk })

  // Always 8 entries in the canonical order: backend-provided fills in scores;
  // anything missing falls back to 0 with the canonical label.
  const visibleHazards: Hazard[] = HAZARD_SPECTRUM
    .map(spec => hazardMap.get(spec.key) || { key: spec.key, label: spec.label, score: 0 })
    .sort((a, b) => (b.score || 0) - (a.score || 0))

  const recs = (result?.reinforcement_recommendations ?? []).filter(r => r?.action)

  const riskColor = result?.risk_color || 'amber'
  const c = RISK_COLORS[riskColor] || RISK_COLORS.amber

  return (
    <div className="min-h-screen p-6 md:p-8">
      <div className="max-w-3xl mx-auto space-y-6 axis-anim-rise">

        {/* Header */}
        <div className="flex items-start gap-4">
          <div
            className="w-12 h-12 rounded-2xl flex items-center justify-center axis-sweep flex-shrink-0"
            style={{
              background: 'linear-gradient(180deg, #1B2433 0%, #06090E 100%)',
              border: '1px solid rgba(127,201,244,0.55)',
              boxShadow: '0 0 0 1px rgba(127,201,244,0.20), 0 0 14px rgba(127,201,244,0.35)',
            }}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#BFE6FF" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 16.9A5 5 0 0018 7h-1.26A8 8 0 104 15.3"/>
              <polyline points="13 11 9 17 15 17 11 23"/>
            </svg>
          </div>
          <div>
            <div className="text-[10px] font-bold tracking-[0.32em] text-slate-400 uppercase mb-0.5">Axis · Risk Intelligence</div>
            <h1 className="text-2xl font-black text-slate-900 tracking-tight">Natural Disaster Risk Report</h1>
            <p className="text-slate-500 text-sm mt-1 leading-relaxed">
              Hurricane, tornado, hail, wind, flood, wildfire, earthquake and winter-storm exposure for any US city — grounded in recent
              NOAA, USGS, FEMA and news-report data with actionable reinforcement recommendations.
            </p>
          </div>
        </div>

        {/* Input card */}
        <SurfacePanel plate className="p-6 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-bold text-slate-500 uppercase tracking-[0.18em]">State *</label>
              <select
                value={state}
                onChange={e => setState(e.target.value)}
                className="w-full rounded-xl px-3 py-2.5 text-sm text-slate-700 focus:outline-none transition-all"
                style={{
                  background: 'linear-gradient(180deg, #FFFFFF 0%, #F4F8FC 100%)',
                  border: '1px solid rgba(127,201,244,0.40)',
                  boxShadow: 'inset 0 1px 1px rgba(255,255,255,0.9)',
                }}
              >
                <option value="">Select</option>
                {STATES.map(s => (
                  <option key={s.code} value={s.code}>{s.code} — {s.name}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-bold text-slate-500 uppercase tracking-[0.18em]">City *</label>
              <input
                type="text"
                value={city}
                onChange={e => setCity(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSubmit()}
                placeholder="Dallas"
                className="w-full rounded-xl px-3 py-2.5 text-sm text-slate-700 placeholder-slate-300 focus:outline-none transition-all"
                style={{
                  background: 'linear-gradient(180deg, #FFFFFF 0%, #F4F8FC 100%)',
                  border: '1px solid rgba(127,201,244,0.40)',
                  boxShadow: 'inset 0 1px 1px rgba(255,255,255,0.9)',
                }}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-bold text-slate-500 uppercase tracking-[0.18em]">Zip Code</label>
              <input
                type="text"
                value={zip}
                onChange={e => setZip(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSubmit()}
                placeholder="75201"
                className="w-full rounded-xl px-3 py-2.5 text-sm text-slate-700 placeholder-slate-300 focus:outline-none transition-all"
                style={{
                  background: 'linear-gradient(180deg, #FFFFFF 0%, #F4F8FC 100%)',
                  border: '1px solid rgba(127,201,244,0.40)',
                  boxShadow: 'inset 0 1px 1px rgba(255,255,255,0.9)',
                }}
              />
            </div>
          </div>

          <AxisButton
            variant="primary"
            size="lg"
            onClick={handleSubmit}
            disabled={!canSubmit}
            loading={loading}
            className="w-full"
          >
            {loading ? 'Pulling recent disaster data…' : '⚡ Run Risk Report'}
          </AxisButton>
        </SurfacePanel>

        {/* Loading */}
        {loading && (
          <SurfacePanel insight className="p-10 text-center">
            <svg className="animate-spin mx-auto mb-4" width="28" height="28" viewBox="0 0 24 24" fill="none" style={{ color: '#4FB0EA' }}>
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/>
            </svg>
            <div className="text-slate-800 font-bold text-sm mb-1 tracking-tight">Researching recent disaster history…</div>
            <div className="text-slate-400 text-[11px] tracking-wider uppercase">Hurricanes · Tornadoes · Hail · Wildfire · Earthquakes · Floods · Code Updates</div>
          </SurfacePanel>
        )}

        {/* Error */}
        {error && !loading && (
          <SurfacePanel className="p-4 text-red-700 text-sm" style={{ background: 'linear-gradient(180deg, #FFF5F5 0%, #FFE4E6 100%)', borderColor: 'rgba(254,202,202,0.95)' }}>
            {error}
          </SurfacePanel>
        )}

        {/* Results */}
        {result && !loading && (
          <div className="space-y-4 axis-anim-rise">

            {/* Overall score card — AI insight outline trace */}
            <SurfacePanel
              insight
              plate
              className="px-5 py-5"
              style={{
                background:
                  riskColor === 'red'
                    ? 'linear-gradient(180deg, #FFF1F2 0%, #FECACA 100%)'
                    : riskColor === 'emerald'
                      ? 'linear-gradient(180deg, #ECFDF5 0%, #BBF7D0 100%)'
                      : 'linear-gradient(180deg, #FFFBEB 0%, #FDE68A 100%)',
              }}
            >
              <div className="flex items-center gap-4">
                <div className="text-center flex-shrink-0">
                  <div className={`text-6xl font-black leading-none tabular-nums ${c.text}`}>{result.overall_risk ?? '—'}</div>
                  <div className={`text-[10px] font-bold mt-1 ${c.text} opacity-70 tracking-[0.18em] uppercase`}>/ 10</div>
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                    <span className={`font-black text-xl ${c.text} tracking-tight`}>{result.risk_label || '—'}</span>
                    <span
                      className="text-[10px] px-2 py-0.5 rounded-full font-bold tracking-wider uppercase"
                      style={{
                        background: 'linear-gradient(180deg, #FFFFFF 0%, #DCEFFB 100%)',
                        border: '1px solid rgba(127,201,244,0.55)',
                        color: '#0F172A',
                        boxShadow: '0 0 0 1px rgba(127,201,244,0.18)',
                      }}
                    >
                      {city}, {state}
                    </span>
                  </div>
                  {result.summary && <p className={`text-sm leading-relaxed ${c.text} opacity-90`}>{result.summary}</p>}
                </div>
              </div>
            </SurfacePanel>

            {/* Per-hazard risk graph — always shows the full 8-hazard spectrum */}
            {visibleHazards.length > 0 && (
              <SurfacePanel plate className="px-5 py-5">
                <div className="flex items-baseline justify-between mb-1">
                  <div className="text-[10px] font-black text-slate-500 uppercase tracking-[0.22em]">Natural Disaster Risk Graph</div>
                  <div className="text-[10px] text-slate-400">0–10 · higher = more exposure</div>
                </div>
                {/* 0–10 scale axis */}
                <div className="relative ml-[42%] mr-1 mt-2 mb-3 h-3 select-none">
                  <div className="absolute inset-x-0 top-1/2 h-px bg-slate-200" />
                  {[0, 2, 4, 6, 8, 10].map(n => (
                    <div
                      key={n}
                      className="absolute -translate-x-1/2 text-[9px] text-slate-400 font-semibold"
                      style={{ left: `${n * 10}%` }}
                    >
                      {n}
                    </div>
                  ))}
                </div>
                <div className="space-y-3">
                  {visibleHazards.map(h => {
                    const score = h.score || 0
                    const isHigh = score >= 8
                    const isMid  = score >= 4
                    const barGradient = isHigh
                      ? 'linear-gradient(90deg, #F87171 0%, #DC2626 100%)'
                      : isMid
                        ? 'linear-gradient(90deg, #FCD34D 0%, #F59E0B 100%)'
                        : 'linear-gradient(90deg, #BFE6FF 0%, #4FB0EA 100%)'
                    return (
                      <div key={h.key} className="grid grid-cols-[42%_1fr] gap-3 items-center">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="flex-shrink-0">{HAZARD_ICON[h.key] || '⚠️'}</span>
                          <span className="text-slate-800 text-xs font-bold truncate tracking-tight">{h.label}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <div
                            className="flex-1 h-3 rounded-full overflow-hidden relative"
                            style={{
                              background: 'linear-gradient(180deg, #E2E8F0 0%, #F1F5F9 100%)',
                              boxShadow: 'inset 0 1px 2px rgba(15,23,42,0.10)',
                            }}
                          >
                            <div
                              className="h-full rounded-full transition-[width] duration-700"
                              style={{
                                width: `${Math.max(0, Math.min(10, score)) * 10}%`,
                                background: barGradient,
                                boxShadow: score > 0 ? '0 0 10px rgba(127,201,244,0.45)' : undefined,
                              }}
                            />
                          </div>
                          <span className={`text-xs font-black tabular-nums w-12 text-right ${RISK_COLORS[barColorFor(score)].text}`}>
                            {score}<span className="opacity-50">/10</span>
                          </span>
                        </div>
                        {h.rationale && (
                          <p className="col-start-2 text-slate-500 text-[11px] leading-relaxed -mt-1">{h.rationale}</p>
                        )}
                      </div>
                    )
                  })}
                </div>
              </SurfacePanel>
            )}

            {/* Scoring rationale + significance */}
            {(result.scoring_rationale || result.significance) && (
              <SurfacePanel className="px-5 py-4 space-y-3">
                {result.scoring_rationale && (
                  <div>
                    <div className="text-[10px] font-black text-slate-500 uppercase tracking-[0.22em] mb-1">Why This Score</div>
                    <p className="text-slate-700 text-sm leading-relaxed">{result.scoring_rationale}</p>
                  </div>
                )}
                {result.significance && (
                  <div className="border-t pt-3" style={{ borderColor: 'rgba(127,201,244,0.30)' }}>
                    <div className="text-[10px] font-black uppercase tracking-[0.22em] mb-1" style={{ color: '#4FB0EA' }}>What This Means For You</div>
                    <p className="text-slate-800 text-sm leading-relaxed">{result.significance}</p>
                  </div>
                )}
              </SurfacePanel>
            )}

            {/* Reinforcement recommendations */}
            {recs.length > 0 && (
              <SurfacePanel className="px-5 py-4">
                <div className="flex items-baseline justify-between mb-3">
                  <div className="text-[10px] font-black text-slate-500 uppercase tracking-[0.22em]">Reinforcement Recommendations</div>
                  <div className="text-[10px] text-slate-400">Based on recent events + code updates</div>
                </div>
                <div className="space-y-2.5">
                  {recs.map((r, i) => {
                    const priorityKey = (r.priority || 'medium').toLowerCase()
                    const p = PRIORITY_STYLE[priorityKey] || PRIORITY_STYLE.medium
                    const hazardIcon = r.hazard ? HAZARD_ICON[r.hazard] : ''
                    return (
                      <div
                        key={i}
                        className="rounded-xl p-3 transition-all hover:translate-y-[-1px]"
                        style={{
                          background: 'linear-gradient(180deg, #FFFFFF 0%, #F4F8FC 100%)',
                          border: '1px solid rgba(127,201,244,0.35)',
                          boxShadow: '0 1px 2px rgba(15,23,42,0.04)',
                        }}
                      >
                        <div className="flex items-start justify-between gap-3 mb-1.5">
                          <div className="flex items-center gap-2 flex-1 min-w-0">
                            {hazardIcon && <span className="text-base flex-shrink-0">{hazardIcon}</span>}
                            <div className="text-slate-900 text-sm font-bold">{r.action}</div>
                          </div>
                          <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider border flex-shrink-0 ${p.chip}`}>
                            {p.label}
                          </span>
                        </div>
                        {r.why && (
                          <p className="text-slate-500 text-xs leading-relaxed ml-6">{r.why}</p>
                        )}
                      </div>
                    )
                  })}
                </div>
              </SurfacePanel>
            )}

            {/* Recent events */}
            {result.recent_events && result.recent_events.length > 0 && (
              <SurfacePanel className="px-5 py-4">
                <div className="text-[10px] font-black text-slate-500 uppercase tracking-[0.22em] mb-3">Recent Events</div>
                <div className="space-y-3">
                  {result.recent_events.map((ev, i) => (
                    <div key={i} className="flex items-start gap-3">
                      <div
                        className="text-[10px] px-2 py-0.5 rounded-full font-bold tracking-wider flex-shrink-0 mt-0.5"
                        style={{
                          background: 'linear-gradient(180deg, #FFFFFF 0%, #DCEFFB 100%)',
                          border: '1px solid rgba(127,201,244,0.55)',
                          color: '#0F172A',
                        }}
                      >
                        {ev.year || '—'}
                      </div>
                      <div className="flex-1">
                        <div className="text-slate-800 text-sm font-bold tracking-tight">
                          {ev.type ? `${ev.type}${ev.severity ? ` — ${ev.severity}` : ''}` : ev.severity || 'Event'}
                        </div>
                        {ev.impact && <div className="text-slate-500 text-xs mt-0.5">{ev.impact}</div>}
                        {ev.source && <div className="text-slate-400 text-[11px] mt-1 italic">Source: {ev.source}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              </SurfacePanel>
            )}

            {/* Source articles — the actual research the analysis is grounded in */}
            {result.articles && result.articles.length > 0 && (
              <SurfacePanel className="px-5 py-4">
                <div className="flex items-baseline justify-between mb-3">
                  <div className="text-[10px] font-black text-slate-500 uppercase tracking-[0.22em]">Source Articles</div>
                  <div className="text-[10px] text-slate-400">{result.articles.length} result{result.articles.length === 1 ? '' : 's'} · NOAA · FEMA · USGS · News</div>
                </div>
                <div className="space-y-2.5">
                  {result.articles.map((a, i) => {
                    const cat = categoryFor(a.query)
                    const host = hostnameOf(a.url)
                    return (
                      <a
                        key={i}
                        href={a.url || '#'}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block rounded-xl p-3 transition-all hover:translate-y-[-1px] axis-sweep"
                        style={{
                          background: 'linear-gradient(180deg, #FFFFFF 0%, #F4F8FC 100%)',
                          border: '1px solid rgba(127,201,244,0.35)',
                          boxShadow: '0 1px 2px rgba(15,23,42,0.04)',
                        }}
                      >
                        <div className="flex items-start gap-3">
                          <div className="text-base flex-shrink-0 leading-none mt-0.5">{cat.icon}</div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                              <span
                                className="text-[10px] px-2 py-0.5 rounded-full font-bold tracking-wider uppercase"
                                style={{
                                  background: 'linear-gradient(180deg, #FFFFFF 0%, #E5F2FB 100%)',
                                  border: '1px solid rgba(127,201,244,0.45)',
                                  color: '#1E293B',
                                }}
                              >
                                {cat.label}
                              </span>
                              {host && (
                                <span className="text-[10px] text-slate-400 truncate">{host}</span>
                              )}
                              {a.published && (
                                <span className="text-[10px] text-slate-400">· {a.published}</span>
                              )}
                            </div>
                            <div className="text-slate-900 text-sm font-bold leading-snug">
                              {a.title || a.url}
                            </div>
                            {a.snippet && (
                              <p className="text-slate-500 text-xs leading-relaxed mt-1 line-clamp-3">
                                {a.snippet}
                              </p>
                            )}
                          </div>
                          <svg className="text-slate-400 flex-shrink-0 mt-1" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M7 17L17 7"/><path d="M7 7h10v10"/></svg>
                        </div>
                      </a>
                    )
                  })}
                </div>
              </SurfacePanel>
            )}

            {/* Insurance note */}
            {result.insurance_note && (
              <SurfacePanel className="px-5 py-4">
                <div className="text-[10px] font-black text-slate-500 uppercase tracking-[0.22em] mb-1">Insurance Note</div>
                <p className="text-slate-700 text-sm leading-relaxed">{result.insurance_note}</p>
              </SurfacePanel>
            )}

            {/* Data source */}
            {result.data_source && (
              <SurfacePanel
                staticSurface
                className="px-5 py-4 flex gap-3"
                style={{
                  background: 'linear-gradient(180deg, rgba(220,239,251,0.55) 0%, rgba(220,239,251,0.30) 100%)',
                  borderColor: 'rgba(127,201,244,0.45)',
                }}
              >
                <svg className="flex-shrink-0 mt-0.5" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4FB0EA" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                <p className="text-slate-600 text-xs leading-relaxed">
                  <strong className="text-slate-800 tracking-wider uppercase text-[10px]">Source:</strong>{' '}
                  {result.data_source}
                </p>
              </SurfacePanel>
            )}

          </div>
        )}

      </div>
    </div>
  )
}
