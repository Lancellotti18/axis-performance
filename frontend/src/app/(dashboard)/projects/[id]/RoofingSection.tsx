'use client'
import { useState, useEffect } from 'react'
import { api } from '@/lib/api'

interface RoofMeasurements {
  id?: string
  total_sqft: number
  pitch: string
  facets: number
  ridges_ft: number
  valleys_ft: number
  eaves_ft: number
  rakes_ft: number
  waste_pct: number
  roof_type: string
  stories: number
  confidence: number
  notes: string
  confirmed: boolean
}

interface ShingleMaterial {
  item_name: string
  category: string
  quantity: number
  unit: string
  unit_cost: number
  total_cost: number
  notes?: string
}

type RoofTab = 'measurements' | 'waste' | 'shingles'

const cardStyle = { boxShadow: '0 2px 12px rgba(59,130,246,0.08)', border: '1px solid rgba(219,234,254,0.8)' }

function formatMoney(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}

function ConfidenceBadge({ pct }: { pct: number }) {
  const color = pct >= 75 ? 'bg-emerald-50 text-emerald-600 border-emerald-200'
    : pct >= 50 ? 'bg-amber-50 text-amber-600 border-amber-200'
    : 'bg-red-50 text-red-500 border-red-200'
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full border ${color}`}>
      AI Confidence: {pct}%
    </span>
  )
}

export default function RoofingSection({
  blueprintId,
  projectId,
}: {
  blueprintId: string
  projectId: string
}) {
  const [tab, setTab] = useState<RoofTab>('measurements')
  const [measurements, setMeasurements] = useState<RoofMeasurements | null>(null)
  const [draft, setDraft] = useState<RoofMeasurements | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [shingleData, setShingleData] = useState<any>(null)
  const [loadingShingles, setLoadingShingles] = useState(false)
  const [analysisError, setAnalysisError] = useState<string | null>(null)
  const [downloadingPdf, setDownloadingPdf] = useState(false)
  const [pdfError, setPdfError] = useState<string | null>(null)

  // Load existing measurements on mount
  useEffect(() => {
    async function load() {
      try {
        const data = await api.roofing.getMeasurements(blueprintId)
        if (data && data.total_sqft) {
          setMeasurements(data)
          setDraft({ ...data })
        }
      } catch {}
    }
    load()
  }, [blueprintId])

  // Load shingle estimate when tab changes
  useEffect(() => {
    if (tab === 'shingles') {
      loadShingleEstimate()
    }
  }, [tab])

  async function loadShingleEstimate() {
    setLoadingShingles(true)
    try {
      const data = await api.roofing.getShingleEstimate(projectId)
      setShingleData(data)
    } catch {}
    setLoadingShingles(false)
  }

  async function handleAnalyze() {
    setAnalyzing(true)
    setAnalysisError(null)
    try {
      const data = await api.roofing.analyzeMeasurements(blueprintId)
      setMeasurements(data)
      setDraft({ ...data })
    } catch (err: any) {
      setAnalysisError(err.message || 'Analysis failed. Please try again.')
    }
    setAnalyzing(false)
  }

  async function handleConfirm() {
    if (!draft) return
    setConfirming(true)
    try {
      const data = await api.roofing.confirmMeasurements(blueprintId, draft)
      setMeasurements(data)
      setDraft({ ...data })
    } catch {}
    setConfirming(false)
  }

  async function handleDownloadPdf() {
    setDownloadingPdf(true)
    setPdfError(null)
    try {
      await api.roofing.downloadPdfReport(projectId)
    } catch (err: any) {
      setPdfError(err?.message || 'Could not generate PDF. Please try again.')
    }
    setDownloadingPdf(false)
  }

  function updateDraft(field: keyof RoofMeasurements, value: any) {
    setDraft(prev => prev ? { ...prev, [field]: value } : prev)
  }

  const inputCls = 'w-full bg-slate-50 border border-slate-200 focus:border-blue-400 focus:ring-2 focus:ring-blue-100 rounded-xl px-3 py-2 text-slate-700 text-sm focus:outline-none transition-all'
  const labelCls = 'block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1'

  const ROOF_TABS: { key: RoofTab; label: string }[] = [
    { key: 'measurements', label: '📐 Measurements' },
    { key: 'waste',        label: '📊 Waste Calc' },
    { key: 'shingles',     label: '🏠 Shingle Estimator' },
  ]

  // Waste calc derived values
  const grossSqft = draft ? draft.total_sqft * (1 + draft.waste_pct / 100) : 0
  const squares = grossSqft / 100

  return (
    <div>
      {/* Sub-tabs */}
      <div className="flex items-center gap-1 mb-6 bg-slate-100 p-1 rounded-2xl w-fit">
        {ROOF_TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 rounded-xl text-sm font-semibold transition-all ${
              tab === t.key ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── MEASUREMENTS TAB ─────────────────────────────────── */}
      {tab === 'measurements' && (
        <div className="space-y-5">
          {/* Action banner */}
          {!measurements && !analyzing && (
            <div className="bg-blue-50 border border-blue-200 rounded-2xl p-6 text-center">
              <div className="w-14 h-14 bg-blue-100 rounded-2xl flex items-center justify-center mx-auto mb-4 text-2xl">📐</div>
              <h3 className="text-slate-800 font-bold mb-1">Analyze Roof Measurements</h3>
              <p className="text-slate-500 text-sm mb-4 max-w-sm mx-auto">
                AI will analyze your uploaded blueprint or roof image to extract measurements. You'll review and confirm before anything is used.
              </p>
              {analysisError && (
                <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-red-600 text-sm mb-4">{analysisError}</div>
              )}
              <button
                onClick={handleAnalyze}
                className="inline-flex items-center gap-2 text-white font-bold px-6 py-2.5 rounded-xl text-sm transition-all hover:scale-[1.02]"
                style={{ background: 'linear-gradient(135deg, #3b82f6, #1d4ed8)', boxShadow: '0 4px 14px rgba(59,130,246,0.3)' }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
                Analyze Roof Measurements
              </button>
            </div>
          )}

          {analyzing && (
            <div className="bg-white rounded-2xl p-10 text-center" style={cardStyle}>
              <svg className="w-10 h-10 text-blue-500 animate-spin mx-auto mb-4" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/>
              </svg>
              <p className="text-slate-700 font-semibold">Analyzing roof measurements…</p>
              <p className="text-slate-400 text-sm mt-1">Claude is examining your blueprint for dimensions, pitch, and structure.</p>
            </div>
          )}

          {measurements && draft && !analyzing && (
            <>
              {/* Confirmed / unconfirmed banner */}
              {measurements.confirmed ? (
                <div className="flex flex-wrap items-center gap-3 bg-emerald-50 border border-emerald-200 rounded-2xl px-5 py-3">
                  <span className="text-emerald-500 text-xl">✓</span>
                  <div className="min-w-0">
                    <div className="text-emerald-700 font-semibold text-sm">Measurements Confirmed</div>
                    <div className="text-emerald-600 text-xs">These measurements are being used for the shingle estimator.</div>
                  </div>
                  <div className="ml-auto flex items-center gap-2">
                    <button
                      onClick={handleDownloadPdf}
                      disabled={downloadingPdf}
                      className="inline-flex items-center gap-1.5 text-xs font-bold text-white px-3 py-1.5 rounded-xl transition-all hover:scale-[1.02] disabled:opacity-60 disabled:cursor-not-allowed"
                      style={{ background: 'linear-gradient(135deg, #059669, #047857)', boxShadow: '0 2px 10px rgba(5,150,105,0.25)' }}
                      title="Download professional roof report PDF"
                    >
                      {downloadingPdf ? (
                        <>
                          <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/>
                          </svg>
                          Generating…
                        </>
                      ) : (
                        <>
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                          Download PDF Report
                        </>
                      )}
                    </button>
                    <button onClick={handleAnalyze} className="text-xs text-emerald-600 underline hover:no-underline">Re-analyze</button>
                  </div>
                  {pdfError && (
                    <div className="basis-full text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-2.5 py-1.5 mt-1">
                      {pdfError}
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-2xl px-5 py-3">
                  <span className="text-amber-500 text-xl">⚠</span>
                  <div>
                    <div className="text-amber-700 font-semibold text-sm">Review & Confirm</div>
                    <div className="text-amber-600 text-xs">AI measurements below — adjust any values, then confirm to use them.</div>
                  </div>
                  <ConfidenceBadge pct={measurements.confidence} />
                </div>
              )}

              {measurements.notes && (
                <div className="bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-slate-600 text-sm italic">
                  💬 {measurements.notes}
                </div>
              )}

              {/* Measurement fields */}
              <div className="bg-white rounded-2xl p-6" style={cardStyle}>
                <h3 className="text-slate-800 font-bold text-sm mb-4">Roof Measurements</h3>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div>
                    <label className={labelCls}>Total Sq Ft</label>
                    <input type="number" value={draft.total_sqft} onChange={e => updateDraft('total_sqft', parseFloat(e.target.value) || 0)} className={inputCls} />
                  </div>
                  <div>
                    <label className={labelCls}>Pitch</label>
                    <input type="text" value={draft.pitch} onChange={e => updateDraft('pitch', e.target.value)} className={inputCls} placeholder="6/12" />
                  </div>
                  <div>
                    <label className={labelCls}>Facets</label>
                    <input type="number" value={draft.facets} onChange={e => updateDraft('facets', parseInt(e.target.value) || 0)} className={inputCls} />
                  </div>
                  <div>
                    <label className={labelCls}>Roof Type</label>
                    <select value={draft.roof_type} onChange={e => updateDraft('roof_type', e.target.value)} className={inputCls}>
                      {['gable','hip','complex','flat','gambrel','mansard','shed','unknown'].map(t => (
                        <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className={labelCls}>Ridges (ft)</label>
                    <input type="number" value={draft.ridges_ft} onChange={e => updateDraft('ridges_ft', parseFloat(e.target.value) || 0)} className={inputCls} />
                  </div>
                  <div>
                    <label className={labelCls}>Valleys (ft)</label>
                    <input type="number" value={draft.valleys_ft} onChange={e => updateDraft('valleys_ft', parseFloat(e.target.value) || 0)} className={inputCls} />
                  </div>
                  <div>
                    <label className={labelCls}>Eaves (ft)</label>
                    <input type="number" value={draft.eaves_ft} onChange={e => updateDraft('eaves_ft', parseFloat(e.target.value) || 0)} className={inputCls} />
                  </div>
                  <div>
                    <label className={labelCls}>Rakes (ft)</label>
                    <input type="number" value={draft.rakes_ft} onChange={e => updateDraft('rakes_ft', parseFloat(e.target.value) || 0)} className={inputCls} />
                  </div>
                  <div>
                    <label className={labelCls}>Waste % </label>
                    <input type="number" value={draft.waste_pct} onChange={e => updateDraft('waste_pct', parseFloat(e.target.value) || 10)} className={inputCls} min={5} max={30} />
                  </div>
                  <div>
                    <label className={labelCls}>Stories</label>
                    <input type="number" value={draft.stories} onChange={e => updateDraft('stories', parseInt(e.target.value) || 1)} className={inputCls} min={1} max={4} />
                  </div>
                </div>

                <div className="flex gap-3 mt-5 pt-4 border-t" style={{ borderColor: 'rgba(219,234,254,0.6)' }}>
                  <button
                    onClick={handleConfirm}
                    disabled={confirming}
                    className="flex items-center gap-2 text-white font-bold px-6 py-2.5 rounded-xl text-sm transition-all disabled:opacity-40"
                    style={{ background: 'linear-gradient(135deg, #10b981, #059669)', boxShadow: '0 4px 14px rgba(16,185,129,0.25)' }}
                  >
                    {confirming ? 'Saving…' : '✓ Confirm Measurements'}
                  </button>
                  <button onClick={handleAnalyze} className="text-sm text-slate-500 hover:text-slate-700 font-medium px-4 py-2 rounded-xl bg-slate-50 hover:bg-slate-100 transition-all">
                    Re-analyze
                  </button>
                </div>
              </div>

              {/* Quick summary card */}
              <div className="grid grid-cols-3 gap-4">
                {[
                  { label: 'Roof Squares', value: (draft.total_sqft / 100).toFixed(1), sub: '100 sq ft each' },
                  { label: 'Gross w/ Waste', value: (draft.total_sqft * (1 + draft.waste_pct / 100) / 100).toFixed(1) + ' sq', sub: `${draft.waste_pct}% waste factor` },
                  { label: 'Perimeter Est.', value: `${Math.round(draft.eaves_ft + draft.rakes_ft)} ft`, sub: 'Eaves + rakes' },
                ].map(s => (
                  <div key={s.label} className="bg-white rounded-2xl p-4 text-center" style={cardStyle}>
                    <div className="text-2xl font-black text-slate-800">{s.value}</div>
                    <div className="text-slate-600 text-sm font-semibold mt-0.5">{s.label}</div>
                    <div className="text-slate-400 text-xs">{s.sub}</div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── WASTE CALC TAB ─────────────────────────────────── */}
      {tab === 'waste' && (
        <div className="space-y-5">
          <div className="bg-white rounded-2xl p-6" style={cardStyle}>
            <h3 className="text-slate-800 font-bold text-sm mb-1">Waste & Overage Calculator</h3>
            <p className="text-slate-400 text-xs mb-5">Adjust inputs to see how waste percentage affects your order quantities.</p>

            {!draft ? (
              <div className="text-center py-10 text-slate-400">
                <div className="text-4xl mb-3">📐</div>
                Run roof measurements first to use the waste calculator.
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
                  <div>
                    <label className={labelCls}>Net Roof Sq Ft</label>
                    <input type="number" value={draft.total_sqft} onChange={e => updateDraft('total_sqft', parseFloat(e.target.value) || 0)} className={inputCls} />
                  </div>
                  <div>
                    <label className={labelCls}>Waste %</label>
                    <input type="number" value={draft.waste_pct} onChange={e => updateDraft('waste_pct', parseFloat(e.target.value) || 10)} className={inputCls} min={5} max={30} />
                  </div>
                  <div>
                    <label className={labelCls}>Pitch</label>
                    <select value={draft.pitch} onChange={e => updateDraft('pitch', e.target.value)} className={inputCls}>
                      {['3/12','4/12','5/12','6/12','7/12','8/12','9/12','10/12','12/12'].map(p => (
                        <option key={p} value={p}>{p}</option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Waste guide */}
                <div className="bg-slate-50 rounded-xl p-4 mb-5">
                  <div className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Recommended Waste by Roof Type</div>
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    {[
                      { type: 'Simple Gable (2 facets)', pct: '10%' },
                      { type: 'Hip Roof (4 facets)', pct: '12–15%' },
                      { type: 'Complex (5+ facets)', pct: '15–20%' },
                      { type: 'Steep pitch (>8/12)', pct: '+2–3%' },
                      { type: 'Many valleys/cuts', pct: '+3–5%' },
                      { type: 'Cut-up dormers', pct: '+5%' },
                    ].map(r => (
                      <div key={r.type} className="bg-white rounded-lg p-2.5 border border-slate-200">
                        <div className="font-bold text-slate-700">{r.pct}</div>
                        <div className="text-slate-400 mt-0.5">{r.type}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Results */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  {[
                    { label: 'Net Sq Ft', value: draft.total_sqft.toLocaleString(), unit: 'sq ft' },
                    { label: 'Gross Sq Ft', value: Math.ceil(grossSqft).toLocaleString(), unit: 'sq ft' },
                    { label: 'Squares Needed', value: Math.ceil(squares * 10) / 10, unit: 'squares' },
                    { label: 'Bundles (3/sq)', value: Math.ceil(squares * 3), unit: 'bundles' },
                  ].map(r => (
                    <div key={r.label} className="bg-blue-50 border border-blue-100 rounded-xl p-4 text-center">
                      <div className="text-2xl font-black text-blue-700">{r.value}</div>
                      <div className="text-blue-600 text-xs font-semibold mt-0.5">{r.unit}</div>
                      <div className="text-slate-400 text-xs mt-0.5">{r.label}</div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── SHINGLE ESTIMATOR TAB ─────────────────────────────────── */}
      {tab === 'shingles' && (
        <div className="space-y-5">
          {loadingShingles ? (
            <div className="flex items-center justify-center py-16 text-slate-400">Loading estimate…</div>
          ) : !shingleData || !shingleData.ready ? (
            <div className="bg-white rounded-2xl p-10 text-center" style={cardStyle}>
              <div className="text-4xl mb-3">🏠</div>
              <div className="text-slate-700 font-bold mb-1">Measurements Not Confirmed</div>
              <div className="text-slate-400 text-sm mb-4">
                {shingleData?.message || 'Confirm your roof measurements first to generate the shingle material list.'}
              </div>
              <button
                onClick={() => setTab('measurements')}
                className="text-sm text-blue-600 font-semibold hover:text-blue-800 underline"
              >
                Go to Measurements →
              </button>
            </div>
          ) : (
            <>
              {/* Summary */}
              <div className="grid grid-cols-3 gap-4">
                {[
                  { label: 'Roof Squares', value: shingleData.squares, sub: 'after waste' },
                  { label: 'Materials Cost', value: formatMoney(shingleData.total_materials_cost), sub: 'materials only' },
                  { label: 'Pitch', value: shingleData.measurements?.pitch || '—', sub: shingleData.measurements?.roof_type || '' },
                ].map(s => (
                  <div key={s.label} className="bg-white rounded-2xl p-5" style={cardStyle}>
                    <div className="text-2xl font-black text-slate-800">{s.value}</div>
                    <div className="text-slate-600 text-sm font-semibold mt-0.5">{s.label}</div>
                    <div className="text-slate-400 text-xs">{s.sub}</div>
                  </div>
                ))}
              </div>

              {/* Materials table */}
              <div className="bg-white rounded-2xl overflow-hidden" style={cardStyle}>
                <div className="px-6 py-4 border-b flex items-center justify-between" style={{ borderColor: 'rgba(219,234,254,0.6)' }}>
                  <h3 className="text-slate-800 font-bold text-sm">Roofing Material List</h3>
                  <span className="text-xs text-slate-400">Quantities include waste factor</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b bg-slate-50" style={{ borderColor: 'rgba(219,234,254,0.6)' }}>
                        <th className="text-left px-6 py-3 text-xs font-bold text-slate-500 uppercase tracking-wider">Material</th>
                        <th className="text-right px-4 py-3 text-xs font-bold text-slate-500 uppercase tracking-wider">Qty</th>
                        <th className="text-right px-4 py-3 text-xs font-bold text-slate-500 uppercase tracking-wider">Unit</th>
                        <th className="text-right px-4 py-3 text-xs font-bold text-slate-500 uppercase tracking-wider">Unit Cost</th>
                        <th className="text-right px-6 py-3 text-xs font-bold text-slate-500 uppercase tracking-wider">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(shingleData.materials as ShingleMaterial[]).map((m, i) => (
                        <tr key={i} className="border-b hover:bg-blue-50/30 transition-colors" style={{ borderColor: 'rgba(219,234,254,0.4)' }}>
                          <td className="px-6 py-4">
                            <div className="text-slate-800 font-medium text-sm">{m.item_name}</div>
                            {m.notes && <div className="text-slate-400 text-xs mt-0.5">{m.notes}</div>}
                          </td>
                          <td className="px-4 py-4 text-right text-slate-700 font-semibold text-sm">{m.quantity}</td>
                          <td className="px-4 py-4 text-right text-slate-400 text-sm">{m.unit}</td>
                          <td className="px-4 py-4 text-right text-slate-600 text-sm">${m.unit_cost.toFixed(2)}</td>
                          <td className="px-6 py-4 text-right font-bold text-slate-800 text-sm">{formatMoney(m.total_cost)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="bg-blue-50 border-t-2 border-blue-200">
                        <td colSpan={4} className="px-6 py-4 text-sm font-bold text-slate-700">Total Materials</td>
                        <td className="px-6 py-4 text-right text-lg font-black text-blue-700">{formatMoney(shingleData.total_materials_cost)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>

              <div className="bg-amber-50 border border-amber-200 rounded-xl px-5 py-3 text-amber-700 text-xs">
                ⚠ These are estimated material costs. Labor, permits, disposal, and contractor markup are not included. Always get supplier quotes before finalizing bids.
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
