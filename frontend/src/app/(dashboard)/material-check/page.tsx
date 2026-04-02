'use client'

import { useRef, useState, useCallback } from 'react'
import { api } from '@/lib/api'
import { STATES, COUNTIES, CITIES } from '@/lib/jurisdictions'

const PROJECT_TYPES = [
  { value: 'residential', label: 'Residential' },
  { value: 'commercial',  label: 'Commercial' },
  { value: 'roofing',     label: 'Roofing' },
  { value: 'renovation',  label: 'Renovation' },
]

const cardStyle = {
  boxShadow: '0 2px 12px rgba(59,130,246,0.07)',
  border: '1px solid rgba(219,234,254,0.8)',
}

// ── Result sub-components (identical style to project compliance tab) ─────────

function StatusIcon({ status }: { status: string }) {
  if (status === 'pass') return (
    <div className="w-5 h-5 rounded-full bg-emerald-100 flex items-center justify-center flex-shrink-0 mt-0.5">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="3" strokeLinecap="round">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
    </div>
  )
  if (status === 'fail') return (
    <div className="w-5 h-5 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0 mt-0.5">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="3" strokeLinecap="round">
        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    </div>
  )
  // warning
  return (
    <div className="w-5 h-5 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0 mt-0.5">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="3" strokeLinecap="round">
        <path d="M12 9v4M12 17h.01"/>
      </svg>
    </div>
  )
}

function ChecklistItem({ item }: { item: any }) {
  const isFail = item.status === 'fail'
  const isWarn = item.status === 'warning'
  const isPass = item.status === 'pass'
  return (
    <div className="bg-white rounded-xl overflow-hidden" style={{
      boxShadow: isFail ? '0 2px 12px rgba(239,68,68,0.08)' : isWarn ? '0 2px 12px rgba(245,158,11,0.08)' : '0 2px 8px rgba(59,130,246,0.06)',
      border: isFail ? '1px solid rgba(254,202,202,0.9)' : isWarn ? '1px solid rgba(253,230,138,0.9)' : '1px solid rgba(167,243,208,0.7)',
    }}>
      <div className="px-4 py-3 flex items-start gap-3">
        <StatusIcon status={item.status} />
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <span className="text-slate-800 text-sm font-semibold">{item.item_name}</span>
            {item.category && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 font-medium flex-shrink-0 capitalize">
                {item.category}
              </span>
            )}
          </div>
          {isPass && item.note && <p className="text-slate-500 text-xs mt-0.5">{item.note}</p>}
          {isPass && item.code_reference && <p className="text-emerald-600 text-[10px] mt-0.5 font-medium">{item.code_reference}</p>}
          {(isFail || isWarn) && item.rule_text && (
            <blockquote className={`mt-2 pl-3 border-l-2 text-slate-500 text-xs italic leading-relaxed ${isFail ? 'border-red-300' : 'border-amber-300'}`}>
              {item.rule_text}
            </blockquote>
          )}
          {(isFail || isWarn) && item.violation_reason && (
            <p className="mt-1.5 text-slate-600 text-xs">{item.violation_reason}</p>
          )}
          {(isFail || isWarn) && item.fix_suggestion && (
            <div className="mt-2 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2">
              <span className="text-[10px] font-bold text-blue-600 uppercase tracking-wider">Fix: </span>
              <span className="text-slate-700 text-xs">{item.fix_suggestion}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function MissingItem({ item }: { item: any }) {
  return (
    <div className="bg-white rounded-xl px-4 py-3 flex items-start gap-3"
      style={{ boxShadow: '0 2px 12px rgba(245,158,11,0.08)', border: '1px solid rgba(253,230,138,0.9)' }}>
      <div className="w-5 h-5 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0 mt-0.5">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="3" strokeLinecap="round">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
      </div>
      <div className="flex-1">
        <span className="text-slate-800 text-sm font-semibold">{item.item_name}</span>
        {item.rule_text && (
          <blockquote className="mt-1.5 pl-3 border-l-2 border-amber-300 text-slate-500 text-xs italic leading-relaxed">
            {item.rule_text}
          </blockquote>
        )}
        {item.reason_required && <p className="mt-1 text-slate-500 text-xs">{item.reason_required}</p>}
      </div>
    </div>
  )
}

function ComplianceResults({ result }: { result: any }) {
  const checklist: any[] = result.checklist || []
  const missing: any[] = result.missing_required_items || []
  const passCount = checklist.filter((c: any) => c.status === 'pass').length
  const failCount = checklist.filter((c: any) => c.status === 'fail').length
  const warnCount = checklist.filter((c: any) => c.status === 'warning').length
  const loc = result.location
  const locationStr = [loc?.city, loc?.county, loc?.state].filter(Boolean).join(', ')

  const statusColor =
    result.overall_status === 'pass'    ? 'bg-emerald-50 border-emerald-200 text-emerald-700' :
    result.overall_status === 'warning' ? 'bg-amber-50 border-amber-200 text-amber-700' :
                                          'bg-red-50 border-red-200 text-red-700'

  return (
    <div className="space-y-4">
      {/* Summary header */}
      <div className="bg-white rounded-2xl px-5 py-4" style={cardStyle}>
        <div className="flex items-start justify-between gap-4 mb-3">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-slate-800 font-bold text-sm">Materials Code Compliance</span>
              <span className={`text-xs px-2.5 py-0.5 rounded-full font-semibold border capitalize ${statusColor}`}>
                {result.overall_status}
              </span>
            </div>
            {locationStr && (
              <div className="text-slate-400 text-xs">{locationStr} · {result.project_type}</div>
            )}
          </div>
          <div className="flex gap-3 text-center flex-shrink-0">
            <div>
              <div className="text-emerald-600 font-bold text-lg leading-none">{passCount}</div>
              <div className="text-slate-400 text-[10px] mt-0.5">Pass</div>
            </div>
            {warnCount > 0 && (
              <div>
                <div className="text-amber-500 font-bold text-lg leading-none">{warnCount}</div>
                <div className="text-slate-400 text-[10px] mt-0.5">Warn</div>
              </div>
            )}
            <div>
              <div className="text-red-500 font-bold text-lg leading-none">{failCount + missing.length}</div>
              <div className="text-slate-400 text-[10px] mt-0.5">Fail</div>
            </div>
          </div>
        </div>
        {result.summary && (
          <p className="text-slate-500 text-sm leading-relaxed border-t pt-3" style={{ borderColor: 'rgba(219,234,254,0.6)' }}>
            {result.summary}
          </p>
        )}
        {/* Code sources */}
        {result.code_sources && result.code_sources.length > 0 && (
          <div className="mt-3 border-t pt-3" style={{ borderColor: 'rgba(219,234,254,0.6)' }}>
            <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">Code Sources</div>
            <div className="flex flex-wrap gap-2">
              {result.code_sources.map((src: string, i: number) => (
                <span key={i} className="text-[10px] px-2 py-1 bg-slate-50 border border-slate-200 rounded-lg text-slate-500">{src}</span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Parsed materials list */}
      {result.parsed_materials && result.parsed_materials.length > 0 && (
        <details className="group">
          <summary className="text-xs font-bold text-slate-400 uppercase tracking-wider cursor-pointer select-none list-none flex items-center gap-2 mb-2">
            <svg className="group-open:rotate-90 transition-transform" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="9 18 15 12 9 6"/></svg>
            Parsed Materials ({result.parsed_materials.length} items) — expand to verify
          </summary>
          <div className="bg-white rounded-xl overflow-hidden mt-2" style={cardStyle}>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b" style={{ borderColor: 'rgba(219,234,254,0.8)' }}>
                  <th className="text-left px-4 py-2 text-slate-400 font-semibold">Item</th>
                  <th className="text-left px-4 py-2 text-slate-400 font-semibold">Category</th>
                  <th className="text-right px-4 py-2 text-slate-400 font-semibold">Qty</th>
                  <th className="text-left px-4 py-2 text-slate-400 font-semibold">Unit</th>
                </tr>
              </thead>
              <tbody>
                {result.parsed_materials.map((m: any, i: number) => (
                  <tr key={i} className="border-b last:border-0 hover:bg-slate-50/50 transition-colors" style={{ borderColor: 'rgba(219,234,254,0.5)' }}>
                    <td className="px-4 py-2 text-slate-700 font-medium">{m.item_name}</td>
                    <td className="px-4 py-2 text-slate-500 capitalize">{m.category}</td>
                    <td className="px-4 py-2 text-slate-600 text-right">{m.quantity || '—'}</td>
                    <td className="px-4 py-2 text-slate-500">{m.unit}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {/* Per-material checklist */}
      {checklist.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">
            Materials Checklist ({checklist.length} items)
          </div>
          {checklist.map((item: any, i: number) => (
            <ChecklistItem key={i} item={item} />
          ))}
        </div>
      )}

      {/* Missing required items */}
      {missing.length > 0 && (
        <div>
          <div className="text-xs font-bold text-amber-600 uppercase tracking-wider mb-2">
            Missing Required Items ({missing.length})
          </div>
          <div className="space-y-2">
            {missing.map((m: any, i: number) => (
              <MissingItem key={i} item={m} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function MaterialCheckPage() {
  // Input mode
  const [mode, setMode] = useState<'file' | 'text'>('file')
  const [dragOver, setDragOver] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [rawText, setRawText] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Location
  const [selectedState, setSelectedState] = useState('')
  const [selectedCounty, setSelectedCounty] = useState('')
  const [selectedCity, setSelectedCity] = useState('')
  const [projectType, setProjectType] = useState('residential')

  // Result
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<any>(null)

  const counties = selectedState ? (COUNTIES[selectedState] || []) : []
  const cities = (selectedState && selectedCounty && CITIES[selectedState])
    ? (CITIES[selectedState][selectedCounty] || [])
    : []

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const dropped = e.dataTransfer.files[0]
    if (dropped) {
      setFile(dropped)
      setMode('file')
    }
  }, [])

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (f) { setFile(f); setMode('file') }
  }

  const canSubmit = (mode === 'file' ? !!file : rawText.trim().length > 0) &&
    !!selectedState && !!selectedCity

  const handleSubmit = async () => {
    if (!canSubmit) return
    setLoading(true)
    setError(null)
    setResult(null)

    try {
      let res: any
      if (mode === 'file' && file) {
        res = await api.materialCheck.uploadFile(file, selectedCity, selectedState, selectedCounty, projectType)
      } else {
        res = await api.materialCheck.checkText(rawText, selectedCity, selectedState, selectedCounty, projectType)
      }
      setResult(res)
    } catch (err: any) {
      setError(err.message || 'Compliance check failed. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen p-6 md:p-8" style={{ background: 'linear-gradient(135deg, #f0f7ff 0%, #f8faff 100%)' }}>
      <div className="max-w-3xl mx-auto space-y-6">

        {/* Page header */}
        <div>
          <h1 className="text-2xl font-bold text-slate-800 tracking-tight">Material Compliance</h1>
          <p className="text-slate-400 text-sm mt-1">
            Upload or paste your material list and verify it meets the building codes for your jurisdiction.
            Every result is sourced from official .gov building codes — nothing is fabricated.
          </p>
        </div>

        {/* Input card */}
        <div className="bg-white rounded-2xl p-6 space-y-5" style={cardStyle}>

          {/* Mode toggle */}
          <div className="flex gap-2">
            {(['file', 'text'] as const).map(m => (
              <button key={m} onClick={() => setMode(m)}
                className={`px-4 py-1.5 rounded-xl text-sm font-semibold transition-all border ${
                  mode === m
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-white text-slate-500 border-slate-200 hover:border-blue-300'
                }`}>
                {m === 'file' ? 'Upload File' : 'Paste / Type List'}
              </button>
            ))}
          </div>

          {/* File drop zone */}
          {mode === 'file' && (
            <div
              onDragOver={e => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer transition-all ${
                dragOver
                  ? 'border-blue-400 bg-blue-50'
                  : file
                  ? 'border-emerald-300 bg-emerald-50/40'
                  : 'border-slate-200 hover:border-blue-300 hover:bg-blue-50/30'
              }`}
            >
              <input ref={fileInputRef} type="file" accept=".csv,.xlsx,.xls,.txt" className="hidden" onChange={handleFileChange} />
              {file ? (
                <div className="space-y-1">
                  <div className="text-2xl">📄</div>
                  <div className="text-slate-800 font-semibold text-sm">{file.name}</div>
                  <div className="text-slate-400 text-xs">{(file.size / 1024).toFixed(1)} KB · click to change</div>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="text-3xl">📋</div>
                  <div className="text-slate-600 font-semibold text-sm">Drop your material list here</div>
                  <div className="text-slate-400 text-xs">CSV, Excel (.xlsx), or plain text (.txt) · max 10 MB</div>
                  <div className="text-slate-400 text-xs">CSV columns: <span className="font-mono bg-slate-100 px-1 rounded">item_name</span>, <span className="font-mono bg-slate-100 px-1 rounded">category</span>, <span className="font-mono bg-slate-100 px-1 rounded">quantity</span>, <span className="font-mono bg-slate-100 px-1 rounded">unit</span></div>
                </div>
              )}
            </div>
          )}

          {/* Text input */}
          {mode === 'text' && (
            <div className="space-y-2">
              <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Material List</label>
              <textarea
                rows={10}
                value={rawText}
                onChange={e => setRawText(e.target.value)}
                placeholder={"One item per line. Examples:\n2x4 lumber, 200, pieces\n3-tab shingles, 25, squares\nPVC pipe 4\", 50, lf\nR-19 batt insulation, 800, sqft"}
                className="w-full border border-slate-200 rounded-xl px-4 py-3 text-sm text-slate-700 placeholder-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-300 focus:border-transparent resize-none font-mono leading-relaxed"
              />
              <div className="text-slate-400 text-xs">
                Format: <span className="font-mono">item name, quantity, unit</span> — quantity and unit are optional
              </div>
            </div>
          )}

          {/* Location selectors */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider">State *</label>
              <select
                value={selectedState}
                onChange={e => { setSelectedState(e.target.value); setSelectedCounty(''); setSelectedCity('') }}
                className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-300 bg-white"
              >
                <option value="">Select state</option>
                {STATES.map(s => (
                  <option key={s.code} value={s.code}>{s.name}</option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider">County</label>
              <select
                value={selectedCounty}
                onChange={e => { setSelectedCounty(e.target.value); setSelectedCity('') }}
                disabled={!selectedState}
                className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-300 bg-white disabled:opacity-50"
              >
                <option value="">Select county</option>
                {counties.map(c => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider">City *</label>
              {cities.length > 0 ? (
                <select
                  value={selectedCity}
                  onChange={e => setSelectedCity(e.target.value)}
                  className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-300 bg-white"
                >
                  <option value="">Select city</option>
                  {cities.map(c => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={selectedCity}
                  onChange={e => setSelectedCity(e.target.value)}
                  placeholder="Enter city"
                  className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-300"
                />
              )}
            </div>

            <div className="space-y-1">
              <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Project Type</label>
              <select
                value={projectType}
                onChange={e => setProjectType(e.target.value)}
                className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-300 bg-white"
              >
                {PROJECT_TYPES.map(t => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Submit button */}
          <button
            onClick={handleSubmit}
            disabled={!canSubmit || loading}
            className="w-full py-3 rounded-xl text-white font-semibold text-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            style={{
              background: loading || !canSubmit
                ? '#94a3b8'
                : 'linear-gradient(135deg, #7c3aed, #5b21b6)',
              boxShadow: canSubmit && !loading ? '0 4px 14px rgba(124,58,237,0.3)' : undefined,
            }}
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/>
                </svg>
                Checking against local building codes…
              </span>
            ) : '⚖ Check Compliance'}
          </button>

          {!canSubmit && !loading && (
            <p className="text-slate-400 text-xs text-center -mt-2">
              {mode === 'file' && !file ? 'Upload a material list file, ' : ''}
              {mode === 'text' && !rawText.trim() ? 'Enter your material list, ' : ''}
              {!selectedState ? 'select a state' : !selectedCity ? 'enter or select a city' : ''}
              {' '}to continue.
            </p>
          )}
        </div>

        {/* Loading state */}
        {loading && (
          <div className="bg-white rounded-2xl p-10 text-center" style={cardStyle}>
            <svg className="animate-spin text-purple-500 mx-auto mb-4" width="28" height="28" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/>
            </svg>
            <div className="text-slate-700 font-semibold text-sm mb-1">Checking materials against local codes…</div>
            <div className="text-slate-400 text-xs">
              Searching {selectedCity}, {selectedState} building codes and IRC 2021 / IBC base standard
            </div>
          </div>
        )}

        {/* Error state */}
        {error && !loading && (
          <div className="bg-red-50 border border-red-200 rounded-2xl p-4 text-red-600 text-sm">
            {error}
          </div>
        )}

        {/* Results */}
        {result && !loading && <ComplianceResults result={result} />}

        {/* Info footer */}
        <div className="bg-blue-50/60 border border-blue-100 rounded-2xl px-5 py-4 flex gap-3 items-start">
          <svg className="flex-shrink-0 text-blue-400 mt-0.5" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <div className="text-slate-500 text-xs leading-relaxed">
            <strong className="text-slate-700">How it works:</strong> This tool searches official state and local government building code databases (.gov sites) and cross-references your materials against IRC 2021 / IBC standards using AI analysis. Nothing is fabricated — every result cites the code source it was checked against. Always verify results with your local building department before construction.
          </div>
        </div>

      </div>
    </div>
  )
}
