'use client'

import { useState } from 'react'
import { api } from '@/lib/api'
import { STATES } from '@/lib/jurisdictions'

const cardStyle = {
  boxShadow: '0 2px 12px rgba(59,130,246,0.07)',
  border: '1px solid rgba(219,234,254,0.8)',
}

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
  // legacy
  hail_risk?: number
  wind_risk?: number
  flood_risk?: number
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

  // Build hazards list — prefer new structured `hazards`, fall back to legacy top-level fields.
  const hazards: Hazard[] = (() => {
    if (result?.hazards && Array.isArray(result.hazards)) {
      return result.hazards.filter(h => typeof h?.score === 'number')
    }
    const legacy: Hazard[] = []
    if (typeof result?.hail_risk  === 'number') legacy.push({ key: 'hail',  label: 'Hail',  score: result.hail_risk })
    if (typeof result?.wind_risk  === 'number') legacy.push({ key: 'wind',  label: 'Wind',  score: result.wind_risk })
    if (typeof result?.flood_risk === 'number') legacy.push({ key: 'flood', label: 'Flood', score: result.flood_risk })
    return legacy
  })()

  // Sort hazards by score descending, drop zero-score items
  const visibleHazards = hazards
    .filter(h => (h.score || 0) > 0)
    .sort((a, b) => (b.score || 0) - (a.score || 0))

  const recs = (result?.reinforcement_recommendations ?? []).filter(r => r?.action)

  const riskColor = result?.risk_color || 'amber'
  const c = RISK_COLORS[riskColor] || RISK_COLORS.amber

  return (
    <div className="min-h-screen p-6 md:p-8" style={{ background: 'linear-gradient(135deg, #f0f7ff 0%, #f8faff 100%)' }}>
      <div className="max-w-2xl mx-auto space-y-6">

        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-slate-800 tracking-tight">Natural Disaster Risk Report</h1>
          <p className="text-slate-400 text-sm mt-1">
            Hurricane, tornado, hail, wind, flood, wildfire, earthquake and winter-storm exposure for any US city — grounded in recent
            NOAA, USGS, FEMA and news-report data with actionable reinforcement recommendations.
          </p>
        </div>

        {/* Input card */}
        <div className="bg-white rounded-2xl p-6 space-y-4" style={cardStyle}>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider">State *</label>
              <select
                value={state}
                onChange={e => setState(e.target.value)}
                className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-300 bg-white"
              >
                <option value="">Select</option>
                {STATES.map(s => (
                  <option key={s.code} value={s.code}>{s.code} — {s.name}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider">City *</label>
              <input
                type="text"
                value={city}
                onChange={e => setCity(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSubmit()}
                placeholder="Dallas"
                className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm text-slate-700 placeholder-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-300"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Zip Code</label>
              <input
                type="text"
                value={zip}
                onChange={e => setZip(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSubmit()}
                placeholder="75201"
                className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm text-slate-700 placeholder-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-300"
              />
            </div>
          </div>

          <button
            onClick={handleSubmit}
            disabled={!canSubmit || loading}
            className="w-full py-3 rounded-xl text-white font-semibold text-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            style={{
              background: !canSubmit || loading ? '#94a3b8' : 'linear-gradient(135deg, #0ea5e9, #0369a1)',
              boxShadow: canSubmit && !loading ? '0 4px 14px rgba(14,165,233,0.3)' : undefined,
            }}
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/>
                </svg>
                Pulling recent disaster data…
              </span>
            ) : '⚠ Run Risk Report'}
          </button>
        </div>

        {/* Loading */}
        {loading && (
          <div className="bg-white rounded-2xl p-10 text-center" style={cardStyle}>
            <svg className="animate-spin text-blue-500 mx-auto mb-4" width="28" height="28" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/>
            </svg>
            <div className="text-slate-700 font-semibold text-sm mb-1">Researching recent disaster history…</div>
            <div className="text-slate-400 text-xs">Hurricanes · Tornadoes · Hail · Wildfire · Earthquakes · Floods · Code updates</div>
          </div>
        )}

        {/* Error */}
        {error && !loading && (
          <div className="bg-red-50 border border-red-200 rounded-2xl p-4 text-red-600 text-sm">{error}</div>
        )}

        {/* Results */}
        {result && !loading && (
          <div className="space-y-4">

            {/* Overall score card */}
            <div
              className={`rounded-2xl px-5 py-5 ${c.bg}`}
              style={{
                border: `1px solid`,
                borderColor: riskColor === 'emerald' ? 'rgba(167,243,208,0.8)' : riskColor === 'red' ? 'rgba(254,202,202,0.8)' : 'rgba(253,230,138,0.8)',
              }}
            >
              <div className="flex items-center gap-4">
                <div className="text-center flex-shrink-0">
                  <div className={`text-5xl font-black leading-none ${c.text}`}>{result.overall_risk ?? '—'}</div>
                  <div className={`text-xs font-semibold mt-0.5 ${c.text} opacity-70`}>/10</div>
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`font-bold text-lg ${c.text}`}>{result.risk_label || '—'}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-semibold border ${c.badge}`}>
                      {city}, {state}
                    </span>
                  </div>
                  {result.summary && <p className={`text-sm leading-relaxed ${c.text} opacity-80`}>{result.summary}</p>}
                </div>
              </div>
            </div>

            {/* Per-hazard risk bars */}
            {visibleHazards.length > 0 && (
              <div className="bg-white rounded-2xl px-5 py-4 space-y-3" style={cardStyle}>
                <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">Hazard Breakdown</div>
                {visibleHazards.map(h => (
                  <div key={h.key}>
                    <RiskBar label={h.label} score={h.score || 0} icon={HAZARD_ICON[h.key]} />
                    {h.rationale && (
                      <p className="text-slate-500 text-xs mt-1 leading-relaxed">{h.rationale}</p>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Scoring rationale + significance */}
            {(result.scoring_rationale || result.significance) && (
              <div className="bg-white rounded-2xl px-5 py-4 space-y-3" style={cardStyle}>
                {result.scoring_rationale && (
                  <div>
                    <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">Why This Score</div>
                    <p className="text-slate-600 text-sm leading-relaxed">{result.scoring_rationale}</p>
                  </div>
                )}
                {result.significance && (
                  <div className="border-t pt-3" style={{ borderColor: 'rgba(219,234,254,0.6)' }}>
                    <div className="text-xs font-bold text-blue-500 uppercase tracking-wider mb-1">What This Means For You</div>
                    <p className="text-blue-700 text-sm leading-relaxed">{result.significance}</p>
                  </div>
                )}
              </div>
            )}

            {/* Reinforcement recommendations */}
            {recs.length > 0 && (
              <div className="bg-white rounded-2xl px-5 py-4" style={cardStyle}>
                <div className="flex items-baseline justify-between mb-3">
                  <div className="text-xs font-bold text-slate-400 uppercase tracking-wider">Reinforcement Recommendations</div>
                  <div className="text-[10px] text-slate-400">Based on recent events + code updates</div>
                </div>
                <div className="space-y-3">
                  {recs.map((r, i) => {
                    const priorityKey = (r.priority || 'medium').toLowerCase()
                    const p = PRIORITY_STYLE[priorityKey] || PRIORITY_STYLE.medium
                    const hazardIcon = r.hazard ? HAZARD_ICON[r.hazard] : ''
                    return (
                      <div key={i} className="border rounded-xl p-3" style={{ borderColor: 'rgba(219,234,254,0.8)' }}>
                        <div className="flex items-start justify-between gap-3 mb-1.5">
                          <div className="flex items-center gap-2 flex-1 min-w-0">
                            {hazardIcon && <span className="text-base flex-shrink-0">{hazardIcon}</span>}
                            <div className="text-slate-800 text-sm font-semibold">{r.action}</div>
                          </div>
                          <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold border flex-shrink-0 ${p.chip}`}>
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
              </div>
            )}

            {/* Recent events */}
            {result.recent_events && result.recent_events.length > 0 && (
              <div className="bg-white rounded-2xl px-5 py-4" style={cardStyle}>
                <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Recent Events</div>
                <div className="space-y-3">
                  {result.recent_events.map((ev, i) => (
                    <div key={i} className="flex items-start gap-3">
                      <div className={`text-xs px-2 py-0.5 rounded-full font-semibold flex-shrink-0 mt-0.5 border ${c.badge}`}>
                        {ev.year || '—'}
                      </div>
                      <div className="flex-1">
                        <div className="text-slate-700 text-sm font-semibold">
                          {ev.type ? `${ev.type}${ev.severity ? ` — ${ev.severity}` : ''}` : ev.severity || 'Event'}
                        </div>
                        {ev.impact && <div className="text-slate-500 text-xs mt-0.5">{ev.impact}</div>}
                        {ev.source && <div className="text-slate-400 text-[11px] mt-1 italic">Source: {ev.source}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Insurance note */}
            {result.insurance_note && (
              <div className="bg-white rounded-2xl px-5 py-4" style={cardStyle}>
                <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">Insurance Note</div>
                <p className="text-slate-600 text-sm leading-relaxed">{result.insurance_note}</p>
              </div>
            )}

            {/* Data source */}
            {result.data_source && (
              <div className="bg-blue-50/60 border border-blue-100 rounded-2xl px-5 py-4 flex gap-3">
                <svg className="flex-shrink-0 text-blue-400 mt-0.5" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                <p className="text-slate-500 text-xs leading-relaxed">
                  <strong className="text-slate-700">Source:</strong> {result.data_source}
                </p>
              </div>
            )}

          </div>
        )}

      </div>
    </div>
  )
}
