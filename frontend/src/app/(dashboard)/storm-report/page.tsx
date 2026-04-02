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

function RiskBar({ label, score, color }: { label: string; score: number; color: string }) {
  const c = RISK_COLORS[color] || RISK_COLORS.amber
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-slate-600 text-xs font-semibold">{label}</span>
        <span className={`text-xs font-bold ${c.text}`}>{score}/10</span>
      </div>
      <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${c.bar}`} style={{ width: `${score * 10}%` }} />
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
  const [result, setResult] = useState<any>(null)

  const canSubmit = city.trim().length > 0 && state.length > 0

  const handleSubmit = async () => {
    if (!canSubmit) return
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const res = await api.roofing.stormRisk(city.trim(), state, zip.trim())
      setResult(res)
    } catch (err: any) {
      setError(err.message || 'Storm risk report failed. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const riskColor = result?.risk_color || 'amber'
  const c = RISK_COLORS[riskColor] || RISK_COLORS.amber

  return (
    <div className="min-h-screen p-6 md:p-8" style={{ background: 'linear-gradient(135deg, #f0f7ff 0%, #f8faff 100%)' }}>
      <div className="max-w-2xl mx-auto space-y-6">

        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-slate-800 tracking-tight">Storm Risk Report</h1>
          <p className="text-slate-400 text-sm mt-1">
            Get a hail, wind, and flood risk score for any city. Sourced from Tavily weather research,
            NOAA historical data, and insurance industry patterns — nothing fabricated.
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
                Analyzing weather data…
              </span>
            ) : '🌩 Get Storm Risk Score'}
          </button>
        </div>

        {/* Loading */}
        {loading && (
          <div className="bg-white rounded-2xl p-10 text-center" style={cardStyle}>
            <svg className="animate-spin text-blue-500 mx-auto mb-4" width="28" height="28" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/>
            </svg>
            <div className="text-slate-700 font-semibold text-sm mb-1">Researching storm history…</div>
            <div className="text-slate-400 text-xs">Pulling hail data · Wind events · Insurance claim patterns · NOAA history</div>
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
            <div className={`rounded-2xl px-5 py-5 ${c.bg}`} style={{ border: `1px solid`, borderColor: riskColor === 'emerald' ? 'rgba(167,243,208,0.8)' : riskColor === 'red' ? 'rgba(254,202,202,0.8)' : 'rgba(253,230,138,0.8)' }}>
              <div className="flex items-center gap-4">
                <div className="text-center flex-shrink-0">
                  <div className={`text-5xl font-black leading-none ${c.text}`}>{result.overall_risk}</div>
                  <div className={`text-xs font-semibold mt-0.5 ${c.text} opacity-70`}>/10</div>
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`font-bold text-lg ${c.text}`}>{result.risk_label}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-semibold border ${c.badge}`}>
                      {city}, {state}
                    </span>
                  </div>
                  {result.summary && <p className={`text-sm leading-relaxed ${c.text} opacity-80`}>{result.summary}</p>}
                </div>
              </div>
            </div>

            {/* Sub-scores */}
            <div className="bg-white rounded-2xl px-5 py-4 space-y-3" style={cardStyle}>
              <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">Risk Breakdown</div>
              <RiskBar label="Hail Risk"  score={result.hail_risk  || 0} color={riskColor} />
              <RiskBar label="Wind Risk"  score={result.wind_risk  || 0} color={riskColor} />
              <RiskBar label="Flood Risk" score={result.flood_risk || 0} color={riskColor} />
            </div>

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
                    <div className="text-xs font-bold text-blue-500 uppercase tracking-wider mb-1">What This Means for Contractors</div>
                    <p className="text-blue-700 text-sm leading-relaxed">{result.significance}</p>
                  </div>
                )}
              </div>
            )}

            {/* Recent events */}
            {result.recent_events && result.recent_events.length > 0 && (
              <div className="bg-white rounded-2xl px-5 py-4" style={cardStyle}>
                <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Recent Storm Events</div>
                <div className="space-y-3">
                  {result.recent_events.map((ev: any, i: number) => (
                    <div key={i} className="flex items-start gap-3">
                      <div className={`text-xs px-2 py-0.5 rounded-full font-semibold flex-shrink-0 mt-0.5 border ${c.badge}`}>
                        {ev.year || '—'}
                      </div>
                      <div>
                        <div className="text-slate-700 text-sm font-semibold">{ev.type} — {ev.severity}</div>
                        {ev.impact && <div className="text-slate-500 text-xs mt-0.5">{ev.impact}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Recommendation + insurance note */}
            {(result.recommendation || result.insurance_note) && (
              <div className="bg-white rounded-2xl px-5 py-4 space-y-3" style={cardStyle}>
                {result.recommendation && (
                  <div>
                    <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">Contractor Recommendation</div>
                    <p className="text-slate-700 text-sm font-semibold leading-relaxed">{result.recommendation}</p>
                  </div>
                )}
                {result.insurance_note && (
                  <div className="border-t pt-3" style={{ borderColor: 'rgba(219,234,254,0.6)' }}>
                    <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">Insurance Note</div>
                    <p className="text-slate-600 text-sm leading-relaxed">{result.insurance_note}</p>
                  </div>
                )}
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
