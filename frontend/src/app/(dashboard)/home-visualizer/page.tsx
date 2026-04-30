'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { STATES } from '@/lib/jurisdictions'

const cardStyle = {
  boxShadow: '0 2px 12px rgba(59,130,246,0.07)',
  border: '1px solid rgba(219,234,254,0.8)',
}

const EXAMPLE_PROMPTS = [
  'Change the siding to white board-and-batten, keep the roof and windows',
  'Repaint the trim black, add black shutters to every window',
  'Swap the front door for a natural wood double door, same opening',
  'Replace the roof with a dark gray standing-seam metal roof',
]

const BACKEND = 'https://build-backend-jcp9.onrender.com'

export default function HomeVisualizerPage() {
  // Wake the Render free tier backend as soon as the page loads
  useEffect(() => { fetch(`${BACKEND}/health`).catch(() => {}) }, [])

  const fileInputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver]       = useState(false)
  const [file, setFile]               = useState<File | null>(null)
  const [preview, setPreview]         = useState<string | null>(null)
  const [description, setDescription] = useState('')
  const [state, setState]             = useState('')
  const [city, setCity]               = useState('')
  const [loading, setLoading]         = useState(false)
  const [error, setError]             = useState<string | null>(null)
  const [result, setResult]           = useState<any>(null)

  const handleFile = (f: File) => {
    setFile(f)
    setResult(null)
    setError(null)
    const reader = new FileReader()
    reader.onload = e => setPreview(e.target?.result as string)
    reader.readAsDataURL(f)
  }

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer.files[0]
    if (f && f.type.startsWith('image/')) handleFile(f)
  }, [])

  const canSubmit = !!file && description.trim().length > 0

  const handleSubmit = async () => {
    if (!canSubmit || loading) return
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const res = await api.visualizer.generate(file!, description.trim(), city.trim(), state)
      setResult(res)
    } catch (err: any) {
      setError(err.message || 'Visualization failed. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const estimate = result?.cost_estimate
  const fmt = (n: number) => `$${n?.toLocaleString() ?? '—'}`

  return (
    <div className="min-h-screen p-6 md:p-8" style={{ background: 'linear-gradient(135deg, #f0f7ff 0%, #f8faff 100%)' }}>
      <div className="max-w-4xl mx-auto space-y-6">

        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-slate-800 tracking-tight">Home Visualizer</h1>
          <p className="text-slate-400 text-sm mt-1">
            Upload a photo of any property, describe the changes you want, and get an AI-generated
            concept render with a real cost estimate.
          </p>
        </div>

        {/* Input card */}
        <div className="bg-white rounded-2xl p-6 space-y-5" style={cardStyle}>

          {/* Photo upload */}
          <div>
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider block mb-2">
              Property Photo
            </label>
            <div
              onDragOver={e => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`relative border-2 border-dashed rounded-2xl cursor-pointer transition-all overflow-hidden ${
                dragOver ? 'border-blue-400 bg-blue-50' :
                preview   ? 'border-emerald-300' :
                'border-slate-200 hover:border-blue-300 hover:bg-blue-50/30'
              }`}
              style={{ minHeight: 180 }}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }}
              />
              {preview ? (
                <div className="relative">
                  <img src={preview} alt="Property" className="w-full object-cover rounded-2xl" style={{ maxHeight: 320 }} />
                  <div className="absolute inset-0 bg-black/0 hover:bg-black/20 transition-all rounded-2xl flex items-center justify-center opacity-0 hover:opacity-100">
                    <span className="text-white font-semibold text-sm bg-black/50 px-3 py-1.5 rounded-full">Click to change photo</span>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center p-10 space-y-2">
                  <div className="text-4xl"></div>
                  <div className="text-slate-600 font-semibold text-sm">Drop a photo or click to upload</div>
                  <div className="text-slate-400 text-xs">JPG, PNG, or WebP · max 10 MB</div>
                </div>
              )}
            </div>
          </div>

          {/* Description */}
          <div>
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider block mb-2">
              What changes do you want? *
            </label>
            <textarea
              rows={3}
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Describe ONLY what to change — the original house, roofline, windows and angle will be preserved. e.g. 'repaint siding charcoal gray, add black shutters'"
              className="w-full border border-slate-200 rounded-xl px-4 py-3 text-sm text-slate-700 placeholder-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-300 resize-none leading-relaxed"
            />
            <p className="text-[11px] text-slate-400 mt-1.5">
              Tip: the AI edits your photo — don't redescribe the whole house, just the change.
            </p>
            {/* Example prompts */}
            <div className="flex flex-wrap gap-2 mt-2">
              {EXAMPLE_PROMPTS.map((p, i) => (
                <button key={i} onClick={() => setDescription(p)}
                  className="text-[11px] px-2.5 py-1 rounded-full border border-blue-100 bg-blue-50 text-blue-600 hover:bg-blue-100 transition-colors">
                  {p.length > 45 ? p.slice(0, 45) + '…' : p}
                </button>
              ))}
            </div>
          </div>

          {/* Location (optional but improves cost accuracy) */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider">State <span className="text-slate-300 normal-case font-normal">(optional — improves cost accuracy)</span></label>
              <select
                value={state}
                onChange={e => setState(e.target.value)}
                className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-300 bg-white"
              >
                <option value="">Select state</option>
                {STATES.map(s => <option key={s.code} value={s.code}>{s.name}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider">City <span className="text-slate-300 normal-case font-normal">(optional)</span></label>
              <input
                type="text"
                value={city}
                onChange={e => setCity(e.target.value)}
                placeholder="e.g. Austin"
                className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm text-slate-700 placeholder-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-300"
              />
            </div>
          </div>

          {/* Submit */}
          <button
            onClick={handleSubmit}
            disabled={!canSubmit || loading}
            className="w-full py-3.5 rounded-xl text-white font-semibold text-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            style={{
              background: !canSubmit || loading
                ? '#94a3b8'
                : 'linear-gradient(135deg, #7c3aed, #5b21b6)',
              boxShadow: canSubmit && !loading ? '0 4px 16px rgba(124,58,237,0.35)' : undefined,
            }}
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/>
                </svg>
                Generating visualization…
              </span>
            ) : 'Visualize Changes'}
          </button>

          {!canSubmit && !loading && (
            <p className="text-slate-400 text-xs text-center -mt-2">
              {!file ? 'Upload a photo' : ''}{!file && !description.trim() ? ' and ' : ''}{!description.trim() ? 'describe the changes' : ''} to continue.
            </p>
          )}
        </div>

        {/* Loading state */}
        {loading && (
          <div className="bg-white rounded-2xl p-10 text-center" style={cardStyle}>
            <div className="relative w-16 h-16 mx-auto mb-5">
              <svg className="animate-spin text-purple-200" width="64" height="64" viewBox="0 0 64 64" fill="none">
                <circle cx="32" cy="32" r="28" stroke="currentColor" strokeWidth="6"/>
              </svg>
              <svg className="animate-spin text-purple-600 absolute inset-0" width="64" height="64" viewBox="0 0 64 64" fill="none" style={{ animationDuration: '1s' }}>
                <path d="M32 4a28 28 0 0128 28" stroke="currentColor" strokeWidth="6" strokeLinecap="round"/>
              </svg>
              <div className="absolute inset-0 flex items-center justify-center text-2xl"></div>
            </div>
            <div className="text-slate-800 font-bold text-base mb-1">Generating your visualization…</div>
            <div className="text-slate-400 text-sm mb-4">This takes 30–90 seconds on first run</div>
            <div className="flex justify-center gap-6 text-xs text-slate-400">
              <span>Processing photo</span>
              <span>Applying changes</span>
              <span>Estimating costs</span>
            </div>
          </div>
        )}

        {/* Error */}
        {error && !loading && (
          <div className="bg-red-50 border border-red-200 rounded-2xl p-4 text-red-600 text-sm flex gap-3">
            <svg className="flex-shrink-0 mt-0.5" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            {error}
          </div>
        )}

        {/* Results */}
        {result && !loading && (
          <div className="space-y-5">

            {/* Before / After */}
            <div>
              <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Before / After</div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Before */}
                <div className="rounded-2xl overflow-hidden" style={cardStyle}>
                  {preview && <img src={preview} alt="Before" className="w-full object-cover" style={{ maxHeight: 320 }} />}
                  <div className="px-4 py-2.5 flex items-center gap-2">
                    <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">Before</span>
                    <span className="text-slate-300 text-xs">Original photo</span>
                  </div>
                </div>
                {/* After */}
                <div className="rounded-2xl overflow-hidden" style={cardStyle}>
                  <img
                    src={result.generated_image_url}
                    alt="AI Visualization"
                    className="w-full object-cover"
                    style={{ maxHeight: 320 }}
                  />
                  <div className="px-4 py-2.5 flex items-center gap-2">
                    <span className="text-xs font-bold text-purple-600 uppercase tracking-wider">After</span>
                    <span className="text-slate-400 text-xs">AI concept render</span>
                  </div>
                </div>
              </div>
              {/* Concept render disclaimer */}
              <div className="mt-2 flex items-center gap-2 text-slate-400 text-xs">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                AI concept render — results are for visualization purposes. Final appearance depends on materials, contractor, and site conditions.
              </div>
            </div>

            {/* Cost estimate */}
            {estimate && (
              <div className="bg-white rounded-2xl overflow-hidden" style={cardStyle}>
                <div className="px-5 py-4 border-b" style={{ borderColor: 'rgba(219,234,254,0.8)' }}>
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-slate-800 font-bold text-sm">Cost Estimate</div>
                      {estimate.location && <div className="text-slate-400 text-xs mt-0.5">{estimate.location}</div>}
                    </div>
                    <div className="flex gap-4 text-center">
                      <div>
                        <div className="text-emerald-600 font-bold text-base leading-none">{fmt(estimate.total_low)}</div>
                        <div className="text-slate-400 text-[10px] mt-0.5">Low</div>
                      </div>
                      <div>
                        <div className="text-blue-600 font-bold text-base leading-none">{fmt(estimate.total_mid)}</div>
                        <div className="text-slate-400 text-[10px] mt-0.5">Mid</div>
                      </div>
                      <div>
                        <div className="text-slate-700 font-bold text-base leading-none">{fmt(estimate.total_high)}</div>
                        <div className="text-slate-400 text-[10px] mt-0.5">High</div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Line items table */}
                {estimate.line_items && estimate.line_items.length > 0 && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr style={{ borderBottom: '1px solid rgba(219,234,254,0.8)' }}>
                          <th className="text-left px-5 py-2.5 text-slate-400 font-semibold">Item</th>
                          <th className="text-right px-3 py-2.5 text-slate-400 font-semibold">Qty</th>
                          <th className="text-right px-3 py-2.5 text-slate-400 font-semibold">Low</th>
                          <th className="text-right px-3 py-2.5 text-slate-400 font-semibold">Mid</th>
                          <th className="text-right px-3 py-2.5 text-slate-400 font-semibold">High</th>
                          <th className="text-left px-5 py-2.5 text-slate-400 font-semibold hidden md:table-cell">Source</th>
                        </tr>
                      </thead>
                      <tbody>
                        {estimate.line_items.map((item: any, i: number) => (
                          <tr key={i} className="hover:bg-slate-50/50 transition-colors" style={{ borderBottom: '1px solid rgba(219,234,254,0.5)' }}>
                            <td className="px-5 py-3 text-slate-700 font-medium">{item.item}</td>
                            <td className="px-3 py-3 text-slate-500 text-right whitespace-nowrap">{item.quantity} {item.unit}</td>
                            <td className="px-3 py-3 text-emerald-600 font-semibold text-right">{fmt(item.total_low)}</td>
                            <td className="px-3 py-3 text-blue-600 font-semibold text-right">{fmt(item.total_mid)}</td>
                            <td className="px-3 py-3 text-slate-600 font-semibold text-right">{fmt(item.total_high)}</td>
                            <td className="px-5 py-3 text-slate-400 hidden md:table-cell">{item.source}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="font-bold" style={{ borderTop: '2px solid rgba(219,234,254,0.9)' }}>
                          <td className="px-5 py-3 text-slate-800">Total</td>
                          <td />
                          <td className="px-3 py-3 text-emerald-600 text-right">{fmt(estimate.total_low)}</td>
                          <td className="px-3 py-3 text-blue-600 text-right">{fmt(estimate.total_mid)}</td>
                          <td className="px-3 py-3 text-slate-700 text-right">{fmt(estimate.total_high)}</td>
                          <td className="hidden md:table-cell" />
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}

                {/* Notes */}
                {estimate.notes && estimate.notes.length > 0 && (
                  <div className="px-5 py-4 border-t space-y-2" style={{ borderColor: 'rgba(219,234,254,0.8)' }}>
                    <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Notes</div>
                    {estimate.notes.map((note: string, i: number) => (
                      <div key={i} className="flex items-start gap-2 text-slate-500 text-xs">
                        <span className="text-blue-400 mt-0.5 flex-shrink-0">•</span>
                        {note}
                      </div>
                    ))}
                  </div>
                )}

                {/* Disclaimer */}
                {estimate.disclaimer && (
                  <div className="px-5 pb-4">
                    <div className="bg-amber-50 border border-amber-100 rounded-xl px-4 py-3 text-amber-700 text-xs">
                      {estimate.disclaimer}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* New visualization button */}
            <button
              onClick={() => { setResult(null); setFile(null); setPreview(null); setDescription(''); setState(''); setCity('') }}
              className="w-full py-3 rounded-xl text-slate-600 font-semibold text-sm border border-slate-200 hover:border-blue-300 hover:text-blue-600 transition-all bg-white"
              style={cardStyle}
            >
              + New Visualization
            </button>

          </div>
        )}

      </div>
    </div>
  )
}
