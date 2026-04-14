'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import dynamic from 'next/dynamic'
import { api } from '@/lib/api'
import type { DamageZone } from './AerialViewer'

const AerialViewer = dynamic(() => import('./AerialViewer'), { ssr: false })

// ── US States + Census FIPS codes ─────────────────────────────────────────────

const US_STATES = [
  { abbr: 'AL', name: 'Alabama',            fips: '01' },
  { abbr: 'AK', name: 'Alaska',             fips: '02' },
  { abbr: 'AZ', name: 'Arizona',            fips: '04' },
  { abbr: 'AR', name: 'Arkansas',           fips: '05' },
  { abbr: 'CA', name: 'California',         fips: '06' },
  { abbr: 'CO', name: 'Colorado',           fips: '08' },
  { abbr: 'CT', name: 'Connecticut',        fips: '09' },
  { abbr: 'DE', name: 'Delaware',           fips: '10' },
  { abbr: 'DC', name: 'District of Columbia', fips: '11' },
  { abbr: 'FL', name: 'Florida',            fips: '12' },
  { abbr: 'GA', name: 'Georgia',            fips: '13' },
  { abbr: 'HI', name: 'Hawaii',             fips: '15' },
  { abbr: 'ID', name: 'Idaho',              fips: '16' },
  { abbr: 'IL', name: 'Illinois',           fips: '17' },
  { abbr: 'IN', name: 'Indiana',            fips: '18' },
  { abbr: 'IA', name: 'Iowa',               fips: '19' },
  { abbr: 'KS', name: 'Kansas',             fips: '20' },
  { abbr: 'KY', name: 'Kentucky',           fips: '21' },
  { abbr: 'LA', name: 'Louisiana',          fips: '22' },
  { abbr: 'ME', name: 'Maine',              fips: '23' },
  { abbr: 'MD', name: 'Maryland',           fips: '24' },
  { abbr: 'MA', name: 'Massachusetts',      fips: '25' },
  { abbr: 'MI', name: 'Michigan',           fips: '26' },
  { abbr: 'MN', name: 'Minnesota',          fips: '27' },
  { abbr: 'MS', name: 'Mississippi',        fips: '28' },
  { abbr: 'MO', name: 'Missouri',           fips: '29' },
  { abbr: 'MT', name: 'Montana',            fips: '30' },
  { abbr: 'NE', name: 'Nebraska',           fips: '31' },
  { abbr: 'NV', name: 'Nevada',             fips: '32' },
  { abbr: 'NH', name: 'New Hampshire',      fips: '33' },
  { abbr: 'NJ', name: 'New Jersey',         fips: '34' },
  { abbr: 'NM', name: 'New Mexico',         fips: '35' },
  { abbr: 'NY', name: 'New York',           fips: '36' },
  { abbr: 'NC', name: 'North Carolina',     fips: '37' },
  { abbr: 'ND', name: 'North Dakota',       fips: '38' },
  { abbr: 'OH', name: 'Ohio',               fips: '39' },
  { abbr: 'OK', name: 'Oklahoma',           fips: '40' },
  { abbr: 'OR', name: 'Oregon',             fips: '41' },
  { abbr: 'PA', name: 'Pennsylvania',       fips: '42' },
  { abbr: 'RI', name: 'Rhode Island',       fips: '44' },
  { abbr: 'SC', name: 'South Carolina',     fips: '45' },
  { abbr: 'SD', name: 'South Dakota',       fips: '46' },
  { abbr: 'TN', name: 'Tennessee',          fips: '47' },
  { abbr: 'TX', name: 'Texas',              fips: '48' },
  { abbr: 'UT', name: 'Utah',               fips: '49' },
  { abbr: 'VT', name: 'Vermont',            fips: '50' },
  { abbr: 'VA', name: 'Virginia',           fips: '51' },
  { abbr: 'WA', name: 'Washington',         fips: '53' },
  { abbr: 'WV', name: 'West Virginia',      fips: '54' },
  { abbr: 'WI', name: 'Wisconsin',          fips: '55' },
  { abbr: 'WY', name: 'Wyoming',            fips: '56' },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

const cardStyle = { boxShadow: '0 2px 10px rgba(59,130,246,0.07)', border: '1px solid rgba(219,234,254,0.8)' }

const CONDITION_COLOR = (score: number | null) =>
  score === null ? '#94a3b8' : score >= 75 ? '#22c55e' : score >= 50 ? '#f59e0b' : '#ef4444'

const RISK_COLOR: Record<string, string> = { low: '#22c55e', medium: '#f59e0b', high: '#ef4444', unknown: '#94a3b8' }

const ZONE_ICON: Record<string, string> = {
  missing_shingles: '🔴', staining: '🟠', debris: '🟡',
  structural_damage: '⛔', discoloration: '🟠', moss_algae: '🟢',
}

const selectStyle: React.CSSProperties = {
  width: '100%',
  border: '1px solid #e2e8f0',
  borderRadius: 12,
  padding: '10px 12px',
  fontSize: 13,
  color: '#334155',
  background: 'white',
  outline: 'none',
  appearance: 'none',
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2394a3b8' stroke-width='2.5'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E")`,
  backgroundRepeat: 'no-repeat',
  backgroundPosition: 'right 12px center',
  paddingRight: 32,
}

function SectionHeader({ title, badge }: { title: string; badge?: string }) {
  return (
    <div className="flex items-center justify-between mb-2">
      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{title}</span>
      {badge && <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 font-semibold">{badge}</span>}
    </div>
  )
}

function Spinner({ size = 16 }: { size?: number }) {
  return (
    <svg className="animate-spin text-indigo-500" width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/>
    </svg>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function MeasurementsPanel({ result, photoResult }: { result: any; photoResult: any }) {
  const confidence = result.confidence_pct ?? result.confidence ?? null
  const confPct    = confidence !== null ? (confidence <= 1 ? Math.round(confidence * 100) : Math.round(confidence)) : null
  const hasPhotos  = photoResult?.success

  return (
    <div className="space-y-3">
      <SectionHeader title="Roof Measurements" badge={result.source || 'AI Estimate'} />

      <div className="grid grid-cols-2 gap-2">
        {[
          { label: 'Roof Sqft',  value: (result.total_sqft || 0).toLocaleString() },
          { label: 'Squares',    value: `${result.squares || '—'}` },
          { label: 'Pitch',      value: result.pitch || '—' },
          { label: 'Segments',   value: `${result.roof_segments || '—'}` },
        ].map(m => (
          <div key={m.label} className="rounded-xl bg-slate-50 px-3 py-2.5 text-center" style={cardStyle}>
            <div className="text-slate-800 font-black text-lg leading-none">{m.value}</div>
            <div className="text-slate-400 text-[10px] font-semibold mt-0.5 uppercase">{m.label}</div>
          </div>
        ))}
      </div>

      {(result.stories || result.house_sqft) && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500 px-1">
          {result.stories    && <span><span className="text-slate-400">Stories</span> {result.stories}</span>}
          {result.house_sqft && <span><span className="text-slate-400">House sqft</span> {result.house_sqft.toLocaleString()}</span>}
        </div>
      )}

      {confPct !== null && (
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] text-slate-400 font-semibold">Measurement Confidence</span>
            <span className="text-xs font-bold" style={{ color: confPct >= 80 ? '#22c55e' : confPct >= 60 ? '#f59e0b' : '#ef4444' }}>
              {Math.min(confPct + (hasPhotos ? Math.round((photoResult.confidence_boost || 0) * 100) : 0), 100)}%
            </span>
          </div>
          <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
            <div className="h-full rounded-full transition-all"
              style={{ width: `${Math.min(confPct + (hasPhotos ? Math.round((photoResult.confidence_boost || 0) * 100) : 0), 100)}%`,
                       background: confPct >= 80 ? '#22c55e' : confPct >= 60 ? '#f59e0b' : '#ef4444' }} />
          </div>
          {hasPhotos && (
            <p className="text-[10px] text-emerald-600 mt-1">
              +{Math.round((photoResult.confidence_boost || 0) * 100)}% from {photoResult.photos_analyzed} uploaded photo{photoResult.photos_analyzed !== 1 ? 's' : ''}
            </p>
          )}
        </div>
      )}

      {hasPhotos && photoResult.pitch_estimate && (
        <div className="bg-emerald-50 border border-emerald-100 rounded-xl px-3 py-2.5">
          <div className="text-emerald-700 text-xs font-bold mb-0.5">📸 Photo Analysis</div>
          <div className="text-emerald-600 text-[11px]">
            Pitch confirmed: <strong>{photoResult.pitch_estimate}</strong> ({Math.round(photoResult.pitch_confidence * 100)}% confidence)
          </div>
          {photoResult.features_detected?.length > 0 && (
            <div className="text-emerald-500 text-[10px] mt-1">
              Features: {photoResult.features_detected.join(' · ')}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function DamagePanel({ damageResult, loading }: { damageResult: any; loading: boolean }) {
  if (loading) return (
    <div className="space-y-2">
      <SectionHeader title="AI Condition Analysis" />
      <div className="flex items-center gap-2 text-xs text-slate-400">
        <Spinner size={14} /> Analyzing satellite imagery…
      </div>
    </div>
  )
  if (!damageResult) return null

  const va = damageResult.vision_analysis || {}
  const zones: DamageZone[] = va.zones || []
  const score: number | null = va.condition_score ?? null
  const condition = va.overall_condition || 'cannot_determine'

  return (
    <div className="space-y-2">
      <SectionHeader title="AI Condition Analysis" badge={va.can_analyze ? 'Satellite Vision' : 'Unavailable'} />

      {!va.can_analyze ? (
        <p className="text-slate-400 text-xs">{va.analyst_notes || 'Vision analysis unavailable for this image.'}</p>
      ) : (
        <>
          <div className="flex items-center gap-3 bg-slate-50 rounded-xl px-3 py-2.5" style={cardStyle}>
            <div className="text-2xl font-black leading-none" style={{ color: CONDITION_COLOR(score) }}>
              {score !== null ? score : '—'}
            </div>
            <div>
              <div className="text-slate-700 text-xs font-bold capitalize">{condition.replace(/_/g, ' ')}</div>
              <div className="text-slate-400 text-[10px]">Condition score / 100</div>
            </div>
          </div>

          {zones.length === 0 ? (
            <p className="text-emerald-600 text-xs bg-emerald-50 px-3 py-2 rounded-xl border border-emerald-100">
              ✓ No visible damage detected in satellite imagery
            </p>
          ) : (
            <div className="space-y-2">
              {zones.map((z, i) => (
                <div key={i} className="bg-red-50 border border-red-100 rounded-xl px-3 py-2">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span>{ZONE_ICON[z.type] || '⚠️'}</span>
                    <span className="text-red-700 text-[11px] font-bold capitalize">{z.type.replace(/_/g, ' ')}</span>
                    <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold uppercase ${z.severity === 'high' ? 'bg-red-200 text-red-800' : z.severity === 'medium' ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-600'}`}>
                      {z.severity}
                    </span>
                    <span className="text-slate-400 text-[9px] ml-auto">{Math.round(z.confidence * 100)}% conf.</span>
                  </div>
                  <p className="text-red-600 text-[10px] leading-snug">{z.description}</p>
                  {z.location_description && <p className="text-slate-400 text-[10px] mt-0.5">📍 {z.location_description}</p>}
                </div>
              ))}
            </div>
          )}

          {va.analyst_notes && <p className="text-slate-400 text-[10px] italic">{va.analyst_notes}</p>}
          <p className="text-slate-400 text-[10px]">
            ⚠ Satellite at ≈0.3 m/px. Major damage visible; individual shingles not resolvable. Physical inspection recommended.
          </p>
        </>
      )}
    </div>
  )
}

function WeatherRiskPanel({ damageResult, loading }: { damageResult: any; loading: boolean }) {
  if (loading) return (
    <div className="space-y-2">
      <SectionHeader title="Weather Risk" />
      <div className="flex items-center gap-2 text-xs text-slate-400"><Spinner size={14} />Searching storm history…</div>
    </div>
  )
  if (!damageResult?.weather_risk) return null

  const wr = damageResult.weather_risk
  const events = wr.events || []

  return (
    <div className="space-y-2">
      <SectionHeader title="Weather Risk History" badge={wr.events_found ? `${events.length} event${events.length !== 1 ? 's' : ''} found` : 'No events found'} />

      <div className="grid grid-cols-2 gap-2">
        {(['hail_risk', 'wind_risk'] as const).map(key => (
          <div key={key} className="rounded-xl bg-slate-50 px-3 py-2 text-center" style={cardStyle}>
            <div className="text-sm font-black" style={{ color: RISK_COLOR[wr[key] || 'unknown'] }}>
              {(wr[key] || 'unknown').toUpperCase()}
            </div>
            <div className="text-slate-400 text-[10px] font-semibold">{key === 'hail_risk' ? 'Hail Risk' : 'Wind Risk'}</div>
          </div>
        ))}
      </div>

      {events.length > 0 && (
        <div className="space-y-1.5">
          {events.map((ev: any, i: number) => (
            <div key={i} className="bg-amber-50 border border-amber-100 rounded-xl px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="text-amber-700 text-[11px] font-bold capitalize">{ev.type?.replace(/_/g, ' ')}</span>
                <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold ${ev.severity === 'high' ? 'bg-red-100 text-red-700' : ev.severity === 'medium' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600'}`}>
                  {ev.severity}
                </span>
                <span className="text-slate-400 text-[10px] ml-auto">{ev.date}</span>
              </div>
              {ev.description && <p className="text-amber-600 text-[10px] mt-0.5">{ev.description}</p>}
              {ev.source && <p className="text-slate-400 text-[9px] mt-0.5">Source: {ev.source}</p>}
            </div>
          ))}
        </div>
      )}

      {wr.note && <p className="text-slate-400 text-[10px]">{wr.note}</p>}
      <p className="text-slate-400 text-[10px]">
        Data from NOAA Storm Events & local news. Full records: ncdc.noaa.gov/stormevents
      </p>
    </div>
  )
}

function PhotoDamagePanel({ photoResult }: { photoResult: any }) {
  if (!photoResult?.success) return null
  const flags = photoResult.damage_flags || []
  if (flags.length === 0) return null

  return (
    <div className="space-y-2">
      <SectionHeader title="Photo Damage Flags" badge={`${flags.length} flag${flags.length !== 1 ? 's' : ''}`} />
      {flags.map((f: any, i: number) => (
        <div key={i} className="bg-orange-50 border border-orange-100 rounded-xl px-3 py-2">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-orange-700 text-[11px] font-bold capitalize">{f.type?.replace(/_/g, ' ')}</span>
            <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold ${f.severity === 'high' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>{f.severity}</span>
            <span className="text-slate-400 text-[9px] ml-auto">{Math.round((f.confidence || 0) * 100)}% conf.</span>
          </div>
          {f.description && <p className="text-orange-600 text-[10px] leading-snug">{f.description}</p>}
          {f.location && <p className="text-slate-400 text-[10px] mt-0.5">📍 {f.location}</p>}
        </div>
      ))}
    </div>
  )
}

// ── Report modal ──────────────────────────────────────────────────────────────

function ReportModal({ result, damageResult, photoResult, type, onClose }: {
  result: any; damageResult: any; photoResult: any; type: 'contractor' | 'customer'; onClose: () => void
}) {
  const va = damageResult?.vision_analysis || {}
  const wr = damageResult?.weather_risk || {}
  const zones: DamageZone[] = va.zones || []
  const confPct = result.confidence !== null
    ? (result.confidence <= 1 ? Math.round(result.confidence * 100) : Math.round(result.confidence))
    : null

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: 'rgba(219,234,254,0.8)' }}>
          <div>
            <div className="text-slate-800 font-bold text-base">
              {type === 'contractor' ? '📐 Contractor Report' : '🏠 Customer Summary'}
            </div>
            <div className="text-slate-400 text-xs">{result.address} — {new Date().toLocaleDateString()}</div>
          </div>
          <div className="flex gap-2">
            <button onClick={() => window.print()} className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-semibold hover:bg-indigo-700 transition-colors">
              🖨 Print / Save PDF
            </button>
            <button onClick={onClose} className="text-xs px-3 py-1.5 rounded-lg bg-slate-100 text-slate-600 font-semibold hover:bg-slate-200 transition-colors">Close</button>
          </div>
        </div>

        <div className="px-6 py-5 space-y-6">
          <div>
            <h3 className="text-slate-700 font-bold text-sm mb-2">Property Information</h3>
            <table className="w-full text-xs text-slate-600 border-collapse">
              <tbody>
                {[
                  ['Address', result.address],
                  ['Data Source', result.source || 'AI Property Estimate'],
                  ['Report Date', new Date().toLocaleDateString()],
                  ['Confidence', confPct !== null ? `${confPct}%` : 'N/A'],
                ].map(([k, v]) => (
                  <tr key={k} className="border-b" style={{ borderColor: 'rgba(219,234,254,0.6)' }}>
                    <td className="py-1.5 pr-4 text-slate-400 font-semibold w-32">{k}</td>
                    <td className="py-1.5 font-medium">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div>
            <h3 className="text-slate-700 font-bold text-sm mb-2">Roof Measurements</h3>
            <table className="w-full text-xs text-slate-600 border-collapse">
              <tbody>
                {[
                  ['Total Roof Area', `${(result.total_sqft || 0).toLocaleString()} sq ft`],
                  ['Roofing Squares', `${result.squares || '—'} squares`],
                  ['Pitch', result.pitch || '—'],
                  ['Roof Segments', `${result.roof_segments || '—'}`],
                  ...(result.stories    ? [['Stories', `${result.stories}`]] : []),
                  ...(result.house_sqft ? [['House Sqft', `${result.house_sqft.toLocaleString()} sq ft`]] : []),
                ].map(([k, v]) => (
                  <tr key={k} className="border-b" style={{ borderColor: 'rgba(219,234,254,0.6)' }}>
                    <td className="py-1.5 pr-4 text-slate-400 font-semibold w-40">{k}</td>
                    <td className="py-1.5 font-bold text-slate-800">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {type === 'contractor' && va.can_analyze && (
            <div>
              <h3 className="text-slate-700 font-bold text-sm mb-2">Condition Assessment — Satellite Vision AI</h3>
              <div className="flex items-center gap-3 mb-3">
                <div className="text-2xl font-black" style={{ color: CONDITION_COLOR(va.condition_score) }}>
                  {va.condition_score ?? '—'}/100
                </div>
                <div className="text-slate-600 text-xs capitalize">{(va.overall_condition || '').replace(/_/g, ' ')}</div>
              </div>
              {zones.length === 0 ? (
                <p className="text-emerald-700 text-xs bg-emerald-50 px-3 py-2 rounded-lg">No visible damage detected in satellite imagery.</p>
              ) : (
                <table className="w-full text-xs text-slate-600 border-collapse">
                  <thead>
                    <tr className="bg-slate-50">
                      <th className="text-left py-1.5 px-2 text-slate-400 font-semibold">Issue</th>
                      <th className="text-left py-1.5 px-2 text-slate-400 font-semibold">Severity</th>
                      <th className="text-left py-1.5 px-2 text-slate-400 font-semibold">Confidence</th>
                      <th className="text-left py-1.5 px-2 text-slate-400 font-semibold">Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {zones.map((z, i) => (
                      <tr key={i} className="border-b" style={{ borderColor: 'rgba(219,234,254,0.6)' }}>
                        <td className="py-1.5 px-2 capitalize font-medium">{z.type.replace(/_/g, ' ')}</td>
                        <td className="py-1.5 px-2 capitalize">{z.severity}</td>
                        <td className="py-1.5 px-2">{Math.round(z.confidence * 100)}%</td>
                        <td className="py-1.5 px-2">{z.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="text-slate-400 text-[10px] mt-2 italic">
                Satellite at ≈0.3 m/px. Physical inspection required before material procurement.
              </p>
            </div>
          )}

          {type === 'contractor' && wr.events_found && (
            <div>
              <h3 className="text-slate-700 font-bold text-sm mb-2">Weather Risk History</h3>
              <div className="flex gap-4 mb-2 text-xs">
                <span>Hail: <strong style={{ color: RISK_COLOR[wr.hail_risk || 'unknown'] }}>{(wr.hail_risk || 'unknown').toUpperCase()}</strong></span>
                <span>Wind: <strong style={{ color: RISK_COLOR[wr.wind_risk || 'unknown'] }}>{(wr.wind_risk || 'unknown').toUpperCase()}</strong></span>
              </div>
              {(wr.events || []).map((ev: any, i: number) => (
                <div key={i} className="text-xs text-slate-600 mb-1">
                  <strong>{ev.date}</strong> — {ev.type?.replace(/_/g, ' ')} ({ev.severity}) — {ev.description} {ev.source && `[${ev.source}]`}
                </div>
              ))}
            </div>
          )}

          <div className="bg-blue-50 border border-blue-100 rounded-xl px-4 py-3 text-xs text-blue-700 leading-relaxed">
            <strong>Disclaimer:</strong> Measurements derived from {result.source || 'AI analysis of satellite imagery and property records'}.
            All figures are estimates for planning purposes. Verify with physical inspection before material procurement.
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

type MobileTab = 'input' | 'view' | 'analysis'

export default function AerialReportPage() {
  // Location selector state
  const [locState,   setLocState]   = useState('')
  const [locCounty,  setLocCounty]  = useState('')
  const [locZip,     setLocZip]     = useState('')
  const [locAddress, setLocAddress] = useState('')
  const [counties,   setCounties]   = useState<string[]>([])
  const [countiesLoading, setCountiesLoading] = useState(false)

  // Report state
  const [address,  setAddress]  = useState('')
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState<string | null>(null)
  const [result,   setResult]   = useState<any>(null)

  // Damage analysis
  const [damageLoading, setDamageLoading] = useState(false)
  const [damageResult,  setDamageResult]  = useState<any>(null)

  // Photo upload
  const [photos,       setPhotos]       = useState<File[]>([])
  const [photoLoading, setPhotoLoading] = useState(false)
  const [photoResult,  setPhotoResult]  = useState<any>(null)
  const [photoError,   setPhotoError]   = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Report modal
  const [reportType,    setReportType]    = useState<'contractor' | 'customer'>('contractor')
  const [reportVisible, setReportVisible] = useState(false)

  // Mobile tab
  const [mobileTab, setMobileTab] = useState<MobileTab>('view')

  // ── County loader (Census Bureau — free, no key) ────────────────────────────

  useEffect(() => {
    if (!locState) { setCounties([]); setLocCounty(''); return }
    const st = US_STATES.find(s => s.abbr === locState)
    if (!st) return
    setCountiesLoading(true)
    setLocCounty('')
    setCounties([])
    fetch(`https://api.census.gov/data/2020/dec/pl?get=NAME&for=county:*&in=state:${st.fips}`)
      .then(r => r.json())
      .then((rows: string[][]) => {
        const names = rows.slice(1)
          .map(row => row[0].replace(/,\s*.+$/, ''))   // strip ", StateName" suffix
          .sort()
        setCounties(names)
      })
      .catch(() => setCounties([]))
      .finally(() => setCountiesLoading(false))
  }, [locState])

  // ── Address builder ─────────────────────────────────────────────────────────

  const buildAddress = useCallback(() => {
    const parts: string[] = []
    if (locAddress.trim()) parts.push(locAddress.trim())
    if (locCounty.trim())  parts.push(locCounty.trim())
    if (locState)          parts.push(locState)
    if (locZip.trim())     parts.push(locZip.trim())
    return parts.join(', ')
  }, [locAddress, locCounty, locState, locZip])

  const canSubmit = !!locState && !loading

  // ── Actions ─────────────────────────────────────────────────────────────────

  const runDamageAnalysis = useCallback(async (res: any) => {
    if (!res?.satellite_image_url) return
    setDamageLoading(true)
    try {
      const dr = await api.roofing.analyzeAerialDamage(
        res.satellite_image_url, res.address || address, res.lat, res.lng
      )
      setDamageResult(dr)
    } catch {
      setDamageResult({ vision_analysis: { can_analyze: false, zones: [], analyst_notes: 'Analysis unavailable.' }, weather_risk: { events_found: false } })
    } finally {
      setDamageLoading(false)
    }
  }, [address])

  const handleSubmit = async () => {
    if (!canSubmit) return
    const addr = buildAddress()
    if (!addr.trim()) return
    setAddress(addr)
    setLoading(true)
    setError(null)
    setResult(null)
    setDamageResult(null)
    setPhotoResult(null)
    try {
      const res = await api.roofing.aerialReportStandalone(addr.trim())
      setResult(res)
      setMobileTab('view')
      runDamageAnalysis(res)
    } catch (err: any) {
      setError(err.message || 'Aerial report failed. Check the location and try again.')
    } finally {
      setLoading(false)
    }
  }

  const handlePhotos = (files: FileList | null) => {
    if (!files) return
    const accepted = Array.from(files).filter(f => f.type.startsWith('image/')).slice(0, 20)
    setPhotos(prev => [...prev, ...accepted].slice(0, 20))
  }

  const runPhotoAnalysis = async () => {
    if (!photos.length) return
    setPhotoLoading(true)
    setPhotoError(null)
    try {
      const pr = await api.roofing.analyzePhotos(photos, result?.address || address)
      setPhotoResult(pr)
    } catch (err: any) {
      setPhotoError(err.message || 'Photo analysis failed.')
    } finally {
      setPhotoLoading(false)
    }
  }

  const damageZones: DamageZone[] = damageResult?.vision_analysis?.zones || []

  // ── Left panel ──────────────────────────────────────────────────────────────

  const leftPanel = (
    <div className="h-full overflow-y-auto p-4 space-y-5" style={{ background: 'rgba(255,255,255,0.97)' }}>

      {/* Location selector */}
      <div className="space-y-3">
        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Property Location</label>

        {/* State */}
        <div>
          <div className="text-[10px] text-slate-400 mb-1 font-semibold">State</div>
          <select
            value={locState}
            onChange={e => setLocState(e.target.value)}
            style={selectStyle}
          >
            <option value="">Select state…</option>
            {US_STATES.map(s => (
              <option key={s.abbr} value={s.abbr}>{s.name}</option>
            ))}
          </select>
        </div>

        {/* County */}
        <div>
          <div className="text-[10px] text-slate-400 mb-1 font-semibold flex items-center gap-1.5">
            County {countiesLoading && <Spinner size={10} />}
          </div>
          <select
            value={locCounty}
            onChange={e => setLocCounty(e.target.value)}
            disabled={!locState || countiesLoading}
            style={{ ...selectStyle, opacity: !locState ? 0.5 : 1, cursor: !locState ? 'not-allowed' : 'pointer' }}
          >
            <option value="">{!locState ? 'Select state first' : countiesLoading ? 'Loading counties…' : 'Select county…'}</option>
            {counties.map(c => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>

        {/* Zip code */}
        <div>
          <div className="text-[10px] text-slate-400 mb-1 font-semibold">Zip Code</div>
          <input
            type="text"
            inputMode="numeric"
            maxLength={5}
            value={locZip}
            onChange={e => setLocZip(e.target.value.replace(/\D/g, '').slice(0, 5))}
            placeholder="e.g. 78701"
            className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm text-slate-700 placeholder-slate-300 focus:outline-none focus:ring-2 focus:ring-indigo-300"
          />
        </div>

        {/* Street address (optional) */}
        <div>
          <div className="text-[10px] text-slate-400 mb-1 font-semibold">
            Street Address <span className="text-slate-300 font-normal">(optional — narrows to specific property)</span>
          </div>
          <input
            type="text"
            value={locAddress}
            onChange={e => setLocAddress(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSubmit()}
            placeholder="123 Main St"
            className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm text-slate-700 placeholder-slate-300 focus:outline-none focus:ring-2 focus:ring-indigo-300"
          />
        </div>

        {/* Address preview */}
        {locState && (
          <div className="bg-slate-50 rounded-xl px-3 py-2 text-[11px] text-slate-500" style={cardStyle}>
            <span className="text-slate-300 font-semibold mr-1">Searching:</span>
            {buildAddress() || locState}
          </div>
        )}

        <button
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="w-full py-2.5 rounded-xl text-white font-semibold text-sm transition-all disabled:opacity-50"
          style={{ background: !canSubmit ? '#94a3b8' : 'linear-gradient(135deg,#7c3aed,#5b21b6)' }}
        >
          {loading ? (
            <span className="flex items-center justify-center gap-2"><Spinner size={14} />Analyzing…</span>
          ) : '🛰 Pull Aerial Report'}
        </button>
        {error && <p className="text-red-500 text-xs">{error}</p>}
      </div>

      {/* Photo upload */}
      <div className="space-y-2">
        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
          Upload Photos <span className="text-slate-300 normal-case font-normal">(boosts accuracy + damage detection)</span>
        </label>
        <div
          className="border-2 border-dashed border-slate-200 rounded-xl p-3 cursor-pointer hover:border-indigo-300 transition-colors text-center"
          onClick={() => fileInputRef.current?.click()}
          onDragOver={e => e.preventDefault()}
          onDrop={e => { e.preventDefault(); handlePhotos(e.dataTransfer.files) }}
        >
          <input ref={fileInputRef} type="file" multiple accept="image/*" className="hidden"
            onChange={e => handlePhotos(e.target.files)} />
          <p className="text-slate-400 text-xs">Drop photos or click to upload</p>
          <p className="text-slate-300 text-[10px]">Front · sides · rear · close-ups · up to 20</p>
        </div>

        {photos.length > 0 && (
          <div>
            <div className="flex flex-wrap gap-1 mb-2">
              {photos.slice(0, 8).map((f, i) => (
                <div key={i} className="relative">
                  <img src={URL.createObjectURL(f)} alt="" className="w-10 h-10 rounded-lg object-cover" />
                  <button onClick={() => setPhotos(p => p.filter((_, j) => j !== i))}
                    className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500 text-white text-[8px] flex items-center justify-center font-bold">×</button>
                </div>
              ))}
              {photos.length > 8 && <div className="w-10 h-10 rounded-lg bg-slate-100 flex items-center justify-center text-[10px] text-slate-400 font-bold">+{photos.length - 8}</div>}
            </div>
            <button onClick={runPhotoAnalysis} disabled={photoLoading}
              className="w-full py-2 rounded-xl text-xs font-bold transition-all disabled:opacity-50"
              style={{ background: photoLoading ? '#94a3b8' : 'linear-gradient(135deg,#059669,#047857)', color: 'white' }}>
              {photoLoading
                ? <span className="flex items-center justify-center gap-1.5"><Spinner size={12} />Analyzing photos…</span>
                : `📸 Analyze ${photos.length} Photo${photos.length > 1 ? 's' : ''}`}
            </button>
            {photoError && <p className="text-red-500 text-[10px] mt-1">{photoError}</p>}
          </div>
        )}
      </div>

      {/* Source info */}
      {result && (
        <div className="bg-slate-50 rounded-xl px-3 py-2.5" style={cardStyle}>
          <div className="text-slate-700 font-bold text-xs mb-0.5">📍 {result.address}</div>
          <div className="text-slate-400 text-[10px]">{result.source || 'AI property estimate'}</div>
        </div>
      )}

      {/* Report buttons */}
      {result && (
        <div className="space-y-1.5">
          <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Generate Report</label>
          {(['contractor', 'customer'] as const).map(t => (
            <button key={t} onClick={() => { setReportType(t); setReportVisible(true) }}
              className="w-full py-2 rounded-xl text-xs font-bold border transition-all hover:bg-slate-50"
              style={{ borderColor: 'rgba(219,234,254,0.9)', color: '#4f46e5' }}>
              {t === 'contractor' ? '📐 Contractor Report' : '🏠 Customer Summary'}
            </button>
          ))}
        </div>
      )}
    </div>
  )

  // ── Center panel ─────────────────────────────────────────────────────────────

  const centerPanel = (
    <div className="h-full flex flex-col overflow-hidden" style={{ background: '#0f172a' }}>
      {!result && !loading && (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center px-6">
          <div className="text-6xl">🛰</div>
          <div className="text-white font-bold text-xl">Aerial Roofing Intelligence</div>
          <p className="text-slate-400 text-sm max-w-sm">
            Select a state, county, and zip code — then optionally enter a street address — to pull satellite roof measurements, AI damage analysis, and weather risk history.
          </p>
          <p className="text-slate-600 text-xs">Imagery: Esri World Imagery · Measurements: Google Solar API / AI estimate · Weather: NOAA records</p>
        </div>
      )}

      {loading && (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center">
          <Spinner size={32} />
          <div className="text-white font-semibold text-sm">Geocoding · Pulling satellite data · Computing roof geometry</div>
          <div className="text-slate-500 text-xs">Usually completes in 5–15 seconds</div>
        </div>
      )}

      {result && result.satellite_image_url && (
        <div className="flex-1 overflow-hidden">
          <AerialViewer
            imageUrl={result.satellite_image_url}
            lat={result.lat ?? null}
            address={result.address || address}
            damageZones={damageZones}
            fillHeight
          />
        </div>
      )}

      {result && !result.satellite_image_url && (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-6">
          <div className="text-4xl">🗺</div>
          <p className="text-slate-400 text-sm">Satellite image unavailable for this location.<br/>Geocoding may not have resolved a precise coordinate.</p>
        </div>
      )}

      {result && damageZones.length > 0 && (
        <div className="flex-shrink-0 flex items-center justify-center py-2 px-4"
          style={{ background: 'rgba(15,23,42,0.97)', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <span className="text-amber-400 text-[11px] font-semibold">
            {damageZones.length} damage zone{damageZones.length > 1 ? 's' : ''} highlighted on image
          </span>
        </div>
      )}
    </div>
  )

  // ── Right panel ──────────────────────────────────────────────────────────────

  const rightPanel = (
    <div className="h-full overflow-y-auto p-4 space-y-5" style={{ background: 'rgba(255,255,255,0.97)' }}>
      {!result && (
        <div className="flex flex-col items-center justify-center h-full text-center gap-3">
          <div className="text-3xl">📊</div>
          <p className="text-slate-400 text-sm">Measurements, AI condition analysis, and weather risk will appear here after pulling a report.</p>
        </div>
      )}

      {result && (
        <>
          <MeasurementsPanel result={result} photoResult={photoResult} />
          <div className="border-t" style={{ borderColor: 'rgba(219,234,254,0.8)' }} />
          <DamagePanel damageResult={damageResult} loading={damageLoading} />
          {photoResult?.success && (
            <>
              <div className="border-t" style={{ borderColor: 'rgba(219,234,254,0.8)' }} />
              <PhotoDamagePanel photoResult={photoResult} />
            </>
          )}
          <div className="border-t" style={{ borderColor: 'rgba(219,234,254,0.8)' }} />
          <WeatherRiskPanel damageResult={damageResult} loading={damageLoading} />
          <div className="border-t" style={{ borderColor: 'rgba(219,234,254,0.8)' }} />
          <div>
            <SectionHeader title="Data Sources" />
            <div className="space-y-1 text-[10px] text-slate-400">
              <p>📡 <strong>Measurements:</strong> {result.source || 'AI property record estimate'}</p>
              <p>🛰 <strong>Imagery:</strong> Esri World Imagery (public satellite, 1280×840 @ ≈0.3 m/px)</p>
              <p>🤖 <strong>Condition:</strong> {damageResult?.vision_analysis?.can_analyze ? 'AI vision analysis of satellite image' : 'Pending or unavailable'}</p>
              <p>🔍 <strong>Weather:</strong> NOAA Storm Events + local news web search</p>
              {photoResult?.success && <p>📸 <strong>Photos:</strong> {photoResult.photos_analyzed} photos analyzed by AI vision</p>}
            </div>
          </div>
        </>
      )}
    </div>
  )

  const TABS: { id: MobileTab; label: string }[] = [
    { id: 'input',    label: '⚙ Input' },
    { id: 'view',     label: '🛰 View' },
    { id: 'analysis', label: '📊 Analysis' },
  ]

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {reportVisible && result && (
        <ReportModal result={result} damageResult={damageResult} photoResult={photoResult}
          type={reportType} onClose={() => setReportVisible(false)} />
      )}

      {/* Desktop 3-panel */}
      <div className="hidden lg:flex flex-1 min-h-0 overflow-hidden">
        <div className="w-72 flex-shrink-0 border-r" style={{ borderColor: 'rgba(219,234,254,0.9)' }}>
          {leftPanel}
        </div>
        <div className="flex-1 min-w-0 overflow-hidden">
          {centerPanel}
        </div>
        <div className="w-80 flex-shrink-0 border-l" style={{ borderColor: 'rgba(219,234,254,0.9)' }}>
          {rightPanel}
        </div>
      </div>

      {/* Mobile tab layout */}
      <div className="flex lg:hidden flex-col flex-1 min-h-0 overflow-hidden">
        <div className="flex-shrink-0 flex border-b bg-white" style={{ borderColor: 'rgba(219,234,254,0.9)' }}>
          {TABS.map(t => (
            <button key={t.id} onClick={() => setMobileTab(t.id)}
              className="flex-1 py-3 text-xs font-semibold transition-all relative"
              style={{ color: mobileTab === t.id ? '#6366f1' : '#94a3b8' }}>
              {t.label}
              {mobileTab === t.id && <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-indigo-500" />}
            </button>
          ))}
        </div>
        <div className="flex-1 min-h-0 overflow-hidden">
          {mobileTab === 'input'    && leftPanel}
          {mobileTab === 'view'     && centerPanel}
          {mobileTab === 'analysis' && rightPanel}
        </div>
      </div>
    </div>
  )
}
