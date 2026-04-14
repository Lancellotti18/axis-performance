'use client'

import { useState } from 'react'
import dynamic from 'next/dynamic'
import { api } from '@/lib/api'

const AerialViewer = dynamic(() => import('./AerialViewer'), { ssr: false })

const cardStyle = {
  boxShadow: '0 2px 12px rgba(59,130,246,0.07)',
  border: '1px solid rgba(219,234,254,0.8)',
}

function MetricCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-white rounded-2xl px-5 py-4 text-center" style={cardStyle}>
      <div className="text-2xl font-black text-slate-800 leading-none">{value}</div>
      <div className="text-slate-500 text-xs font-semibold mt-1">{label}</div>
      {sub && <div className="text-slate-400 text-[10px] mt-0.5">{sub}</div>}
    </div>
  )
}

export default function AerialReportPage() {
  const [address, setAddress] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<any>(null)

  const handleSubmit = async () => {
    const trimmed = address.trim()
    if (!trimmed) return
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const res = await api.roofing.aerialReportStandalone(trimmed)
      setResult(res)
    } catch (err: any) {
      setError(err.message || 'Aerial report failed. Check the address and try again.')
    } finally {
      setLoading(false)
    }
  }

  const rawConfidence = result?.confidence_pct ?? result?.confidence ?? null
  // Backend returns 0–1 decimal; multiply by 100 for display
  const confidence = rawConfidence !== null
    ? (rawConfidence <= 1 ? Math.round(rawConfidence * 100) : Math.round(rawConfidence))
    : null
  const source = result?.source || null

  return (
    <div className="min-h-screen p-6 md:p-8" style={{ background: 'linear-gradient(135deg, #f0f7ff 0%, #f8faff 100%)' }}>
      <div className="max-w-2xl mx-auto space-y-6">

        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-slate-800 tracking-tight">Aerial Roof Report</h1>
          <p className="text-slate-400 text-sm mt-1">
            Enter any property address to pull satellite-derived roof measurements — area, squares, pitch, and segments.
            Data sourced from Google Solar aerial imagery and property records.
          </p>
        </div>

        {/* Input card */}
        <div className="bg-white rounded-2xl p-6 space-y-4" style={cardStyle}>
          <div className="space-y-1">
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Property Address</label>
            <input
              type="text"
              value={address}
              onChange={e => setAddress(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSubmit()}
              placeholder="123 Main St, Austin, TX 78701"
              className="w-full border border-slate-200 rounded-xl px-4 py-3 text-sm text-slate-700 placeholder-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-300 focus:border-transparent"
            />
          </div>
          <button
            onClick={handleSubmit}
            disabled={!address.trim() || loading}
            className="w-full py-3 rounded-xl text-white font-semibold text-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            style={{
              background: !address.trim() || loading ? '#94a3b8' : 'linear-gradient(135deg, #7c3aed, #5b21b6)',
              boxShadow: address.trim() && !loading ? '0 4px 14px rgba(124,58,237,0.3)' : undefined,
            }}
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/>
                </svg>
                Pulling satellite data…
              </span>
            ) : '🛰 Pull Aerial Report'}
          </button>
        </div>

        {/* Loading */}
        {loading && (
          <div className="bg-white rounded-2xl p-10 text-center" style={cardStyle}>
            <svg className="animate-spin text-purple-500 mx-auto mb-4" width="28" height="28" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/>
            </svg>
            <div className="text-slate-700 font-semibold text-sm mb-1">Analyzing aerial imagery…</div>
            <div className="text-slate-400 text-xs">Geocoding address · Pulling Google Solar data · Computing roof geometry</div>
          </div>
        )}

        {/* Error */}
        {error && !loading && (
          <div className="bg-red-50 border border-red-200 rounded-2xl p-4 text-red-600 text-sm">{error}</div>
        )}

        {/* Results */}
        {result && !loading && (
          <div className="space-y-4">

            {/* Address + confidence banner */}
            <div className="bg-white rounded-2xl px-5 py-4" style={cardStyle}>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-slate-800 font-bold text-sm">📍 {result.address || address}</div>
                  {source && <div className="text-slate-400 text-xs mt-0.5">{source}</div>}
                </div>
                {confidence !== null && (
                  <div className="text-right flex-shrink-0">
                    <div className={`text-lg font-black leading-none ${confidence >= 80 ? 'text-emerald-600' : confidence >= 60 ? 'text-amber-500' : 'text-red-500'}`}>
                      {confidence}%
                    </div>
                    <div className="text-slate-400 text-[10px]">confidence</div>
                  </div>
                )}
              </div>
              {confidence !== null && (
                <div className="mt-3">
                  <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${confidence >= 80 ? 'bg-emerald-500' : confidence >= 60 ? 'bg-amber-400' : 'bg-red-400'}`}
                      style={{ width: `${confidence}%` }}
                    />
                  </div>
                  <div className="text-slate-400 text-[10px] mt-1">
                    {confidence >= 80
                      ? 'High confidence — measured from aerial imagery'
                      : confidence >= 60
                      ? 'Moderate confidence — estimated from property records'
                      : 'Low confidence — verify before ordering materials'}
                  </div>
                </div>
              )}
            </div>

            {/* Satellite image — interactive viewer */}
            {result.satellite_image_url && result.lat && (
              <AerialViewer
                imageUrl={result.satellite_image_url}
                lat={result.lat}
                address={result.address || address}
              />
            )}
            {result.satellite_image_url && !result.lat && (
              <div className="rounded-2xl overflow-hidden" style={cardStyle}>
                <img
                  src={result.satellite_image_url}
                  alt={`Satellite view of ${result.address || address}`}
                  className="w-full object-cover"
                  style={{ maxHeight: 340 }}
                />
              </div>
            )}

            {/* Key metrics */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <MetricCard label="Roof Sqft" value={(result.total_sqft || 0).toLocaleString()} sub="square feet" />
              <MetricCard label="Squares" value={`${result.squares || 0}`} sub="roofing squares" />
              <MetricCard label="Pitch" value={result.pitch || '—'} sub="rise/run" />
              <MetricCard label="Segments" value={`${result.roof_segments || '—'}`} sub="roof planes" />
            </div>

            {/* Extra details */}
            {(result.stories || result.house_sqft || result.year_built) && (
              <div className="bg-white rounded-2xl px-5 py-4 flex flex-wrap gap-x-6 gap-y-2 text-sm" style={cardStyle}>
                {result.stories && <span className="text-slate-600"><span className="text-slate-400 text-xs mr-1">Stories</span>{result.stories}</span>}
                {result.house_sqft && <span className="text-slate-600"><span className="text-slate-400 text-xs mr-1">House sqft</span>{result.house_sqft.toLocaleString()}</span>}
                {result.year_built && <span className="text-slate-600"><span className="text-slate-400 text-xs mr-1">Built</span>{result.year_built}</span>}
                {result.property_type && <span className="text-slate-600"><span className="text-slate-400 text-xs mr-1">Type</span>{result.property_type}</span>}
              </div>
            )}

            {/* Permit & damage history */}
            {result.permit_history && result.permit_history.length > 0 && (
              <div className="bg-white rounded-2xl px-5 py-4" style={cardStyle}>
                <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Permit History</div>
                <div className="space-y-2">
                  {result.permit_history.map((p: any, i: number) => (
                    <div key={i} className="flex items-start gap-3 text-sm">
                      <span className="text-slate-400 text-xs flex-shrink-0 mt-0.5">{p.year || p.date || '—'}</span>
                      <span className="text-slate-700">{p.description || p.type || p}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Damage events */}
            {result.damage_events && result.damage_events.length > 0 && (
              <div className="bg-white rounded-2xl px-5 py-4" style={cardStyle}>
                <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Known Damage / Storm Events</div>
                <div className="space-y-2">
                  {result.damage_events.map((d: any, i: number) => (
                    <div key={i} className="flex items-start gap-3 text-sm">
                      <span className="text-slate-400 text-xs flex-shrink-0 mt-0.5">{d.year || d.date || '—'}</span>
                      <span className="text-slate-700">{d.description || d.event || d}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Notes */}
            {result.notes && (
              <div className="bg-blue-50/60 border border-blue-100 rounded-2xl px-5 py-4 flex gap-3">
                <svg className="flex-shrink-0 text-blue-400 mt-0.5" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                <p className="text-slate-500 text-xs leading-relaxed">{result.notes}</p>
              </div>
            )}

            {/* Source disclaimer */}
            <div className="bg-blue-50/60 border border-blue-100 rounded-2xl px-5 py-4 flex gap-3">
              <svg className="flex-shrink-0 text-blue-400 mt-0.5" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              <p className="text-slate-500 text-xs leading-relaxed">
                Roof measurements are derived from Google Solar satellite imagery and public property records. Data is provided for estimation purposes and should be field-verified before material procurement.
              </p>
            </div>

          </div>
        )}

      </div>
    </div>
  )
}
