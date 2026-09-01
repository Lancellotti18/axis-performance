'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { api } from '@/lib/api'
import { getUser } from '@/lib/auth'
import { STATES } from '@/lib/jurisdictions'
import type { Project } from '@/types'
import { toUploadable, isHeic } from '@/lib/image'

const cardStyle = {
  boxShadow: '0 2px 12px rgba(59,130,246,0.07)',
  border: '1px solid rgba(255,255,255,0.10)',
}

// Roof-first: the Visualizer is about showing the homeowner their NEW ROOF.
const EXAMPLE_PROMPTS = [
  'Replace the roof with charcoal architectural asphalt shingles, keep everything else',
  'Show the roof in a weathered-wood shingle color, same house',
  'Change the roof to a dark gray standing-seam metal roof',
  'Replace the roof with a rich brown architectural shingle',
]

const BACKEND = 'https://build-backend-jcp9.onrender.com'

// The Visualizer is a VISUAL sales tool — keep pricing out of it so quotes live
// in one place (the proposal). Flip to true to bring the cost estimate back.
const SHOW_COST_ESTIMATE = false

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
  // "Use in a report": attach this render to a project as its report hero image.
  const [projects, setProjects]       = useState<Project[] | null>(null)
  const [pickerOpen, setPickerOpen]   = useState(false)
  const [savingTo, setSavingTo]       = useState<string | null>(null)
  const [savedTo, setSavedTo]         = useState<string | null>(null)

  const openPicker = useCallback(async () => {
    setPickerOpen(true)
    if (projects) return
    try {
      const u = await getUser()
      if (u) setProjects((await api.projects.list(u.id)) as Project[])
      else setProjects([])
    } catch { setProjects([]) }
  }, [projects])

  const useInReport = useCallback(async (projectId: string, projectName: string) => {
    if (!result?.generated_image_url) return
    setSavingTo(projectId)
    try {
      await api.projects.setHeroRender(projectId, result.generated_image_url)
      // Send the source photo along as the "before". The render on its own is
      // just a nice picture; it only sells the job next to what's there today,
      // and until now the original never left the browser — so the project page
      // had nothing to pair it with. Best-effort: a failed upload must not lose
      // the render we just attached.
      if (file) {
        try {
          // HEIC must be converted here — storage accepts the bytes but nothing
          // downstream can decode them, so the photo silently disappears.
          const uploadable = await toUploadable(file)
          await api.projectPhotos.upload(projectId, uploadable, 'before', 'Before — Roof Visualizer')
        } catch (err: any) {
          // Never swallow this. The old bare `catch {}` discarded the reason,
          // which is why this failure went unexplained for so long.
          console.error('[visualizer] before-photo upload failed:', err)
          const why = err?.message ? `: ${err.message}` : ''
          toast(`Render saved, but the "before" photo didn't upload${why}`,
                { icon: '⚠️', duration: 9000 })
        }
      }
      setSavedTo(projectName)
      setPickerOpen(false)
      toast.success(`Added to “${projectName}” — it’ll appear at the top of that project’s report`)
    } catch {
      toast.error('Could not attach the render — please try again.')
    } finally {
      setSavingTo(null)
    }
  }, [result, file])

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
    // `accept` does not filter drops, so a .heic dropped here used to sail
    // straight through to storage as an undecodable "jpg".
    if (f && (f.type.startsWith('image/') || isHeic(f))) handleFile(f)
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
    <div className="min-h-screen p-6 md:p-8">
      <div className="max-w-4xl mx-auto space-y-6">

        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-[#1a1a1a] tracking-tight">Roof Visualizer</h1>
          <p className="text-[#6b7280] text-sm mt-1">
            Upload a photo of the home, pick the new roof, and show the homeowner a photoreal
            preview of their finished roof — the easiest way to close the sale.
          </p>
        </div>

        {/* Input card */}
        <div className="bg-[#f8f8f7] rounded-2xl p-6 space-y-5" style={cardStyle}>

          {/* Photo upload */}
          <div>
            <label className="text-xs font-semibold text-[#6b7280] uppercase tracking-wider block mb-2">
              Property Photo
            </label>
            <div
              onDragOver={e => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`relative border-2 border-dashed rounded-2xl cursor-pointer transition-all overflow-hidden ${ dragOver ? 'border-blue-400 bg-blue-500/10' : preview ? 'border-emerald-300' : 'border-[#dededc] hover:border-blue-300 hover:bg-blue-500/30' }`}
              style={{ minHeight: 180 }}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif"
                className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }}
              />
              {preview ? (
                <div className="relative">
                  <img src={preview} alt="Property" className="w-full object-cover rounded-2xl" style={{ maxHeight: 320 }} />
                  <div className="absolute inset-0 bg-black/0 hover:bg-black/20 transition-all rounded-2xl flex items-center justify-center opacity-0 hover:opacity-100">
                    <span className="text-[#1a1a1a] font-semibold text-sm bg-black/50 px-3 py-1.5 rounded-full">Click to change photo</span>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center p-10 space-y-2">
                  <div className="text-4xl"></div>
                  <div className="text-[#9ca3af] font-semibold text-sm">Drop a photo or click to upload</div>
                  <div className="text-[#6b7280] text-xs">JPG, PNG, or WebP · max 10 MB</div>
                </div>
              )}
            </div>
          </div>

          {/* Description */}
          <div>
            <label className="text-xs font-semibold text-[#6b7280] uppercase tracking-wider block mb-2">
              What changes do you want? *
            </label>
            <textarea
              rows={3}
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Describe ONLY what to change — the original house, roofline, windows and angle will be preserved. e.g. 'repaint siding charcoal gray, add black shutters'"
              className="w-full border border-[#dededc] rounded-xl px-4 py-3 text-sm text-[#1a1a1a] placeholder-[#9ca3af] focus:outline-none focus:ring-2 focus:ring-blue-300 resize-none leading-relaxed"
            />
            <p className="text-[11px] text-[#6b7280] mt-1.5">
              Tip: the AI edits your photo — don't redescribe the whole house, just the change.
            </p>
            {/* Example prompts */}
            <div className="flex flex-wrap gap-2 mt-2">
              {EXAMPLE_PROMPTS.map((p, i) => (
                <button key={i} onClick={() => setDescription(p)}
                  className="text-[11px] px-2.5 py-1 rounded-full border border-blue-100 bg-blue-500/10 text-blue-600 hover:bg-blue-100 transition-colors">
                  {p.length > 45 ? p.slice(0, 45) + '…' : p}
                </button>
              ))}
            </div>
          </div>

          {/* Location — only used for the cost estimate, so hidden with it. */}
          {SHOW_COST_ESTIMATE && (
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-semibold text-[#6b7280] uppercase tracking-wider">State <span className="text-[#9ca3af] normal-case font-normal">(optional — improves cost accuracy)</span></label>
              <select
                value={state}
                onChange={e => setState(e.target.value)}
                className="w-full border border-[#dededc] rounded-xl px-3 py-2.5 text-sm text-[#1a1a1a] focus:outline-none focus:ring-2 focus:ring-blue-300 bg-[#f8f8f7]"
              >
                <option value="">Select state</option>
                {STATES.map(s => <option key={s.code} value={s.code}>{s.name}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-semibold text-[#6b7280] uppercase tracking-wider">City <span className="text-[#9ca3af] normal-case font-normal">(optional)</span></label>
              <input
                type="text"
                value={city}
                onChange={e => setCity(e.target.value)}
                placeholder="e.g. Austin"
                className="w-full border border-[#dededc] rounded-xl px-3 py-2.5 text-sm text-[#1a1a1a] placeholder-[#9ca3af] focus:outline-none focus:ring-2 focus:ring-blue-300"
              />
            </div>
          </div>
          )}

          {/* Submit */}
          <button
            onClick={handleSubmit}
            disabled={!canSubmit || loading}
            className="w-full py-3.5 rounded-xl text-[#1a1a1a] font-semibold text-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            style={{
              background: !canSubmit || loading
                ? '#94a3b8'
                : '#7c3aed',
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
            <p className="text-[#6b7280] text-xs text-center -mt-2">
              {!file ? 'Upload a photo' : ''}{!file && !description.trim() ? ' and ' : ''}{!description.trim() ? 'describe the changes' : ''} to continue.
            </p>
          )}
        </div>

        {/* Loading state */}
        {loading && (
          <div className="bg-[#f8f8f7] rounded-2xl p-10 text-center" style={cardStyle}>
            <div className="relative w-16 h-16 mx-auto mb-5">
              <svg className="animate-spin text-purple-200" width="64" height="64" viewBox="0 0 64 64" fill="none">
                <circle cx="32" cy="32" r="28" stroke="currentColor" strokeWidth="6"/>
              </svg>
              <svg className="animate-spin text-purple-600 absolute inset-0" width="64" height="64" viewBox="0 0 64 64" fill="none" style={{ animationDuration: '1s' }}>
                <path d="M32 4a28 28 0 0128 28" stroke="currentColor" strokeWidth="6" strokeLinecap="round"/>
              </svg>
              <div className="absolute inset-0 flex items-center justify-center text-2xl"></div>
            </div>
            <div className="text-[#1a1a1a] font-bold text-base mb-1">Generating your visualization…</div>
            <div className="text-[#6b7280] text-sm mb-4">This takes 30–90 seconds on first run</div>
            <div className="flex justify-center gap-6 text-xs text-[#6b7280]">
              <span>Processing photo</span>
              <span>Applying changes</span>
              <span>Estimating costs</span>
            </div>
          </div>
        )}

        {/* Error */}
        {error && !loading && (
          <div className="bg-rose-500/10 border border-red-200 rounded-2xl p-4 text-red-600 text-sm flex gap-3">
            <svg className="flex-shrink-0 mt-0.5" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            {error}
          </div>
        )}

        {/* Results */}
        {result && !loading && (
          <div className="space-y-5">

            {/* Before / After */}
            <div>
              <div className="text-xs font-bold text-[#6b7280] uppercase tracking-wider mb-3">Before / After</div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Before */}
                <div className="rounded-2xl overflow-hidden" style={cardStyle}>
                  {preview && <img src={preview} alt="Before" className="w-full object-cover" style={{ maxHeight: 320 }} />}
                  <div className="px-4 py-2.5 flex items-center gap-2">
                    <span className="text-xs font-bold text-[#6b7280] uppercase tracking-wider">Before</span>
                    <span className="text-[#9ca3af] text-xs">Original photo</span>
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
                    <span className="text-[#6b7280] text-xs">AI concept render</span>
                  </div>
                </div>
              </div>

              {/* Use this render in a project's report */}
              <div className="mt-3 relative">
                {savedTo ? (
                  <div className="flex items-center justify-center gap-2 rounded-xl border border-emerald-400/25 bg-emerald-50 py-2.5 text-sm font-semibold text-emerald-800">
                    ✓ Added to “{savedTo}” — shows at the top of that project’s report
                  </div>
                ) : (
                  <button onClick={openPicker}
                    className="w-full rounded-xl py-2.5 text-sm font-bold text-white transition-all hover:scale-[1.01]"
                    style={{ background: '#7c3aed', boxShadow: '0 4px 14px rgba(124,58,237,0.3)' }}>
                    🖼️ Use in a report
                  </button>
                )}
                {pickerOpen && (
                  <div className="absolute left-0 right-0 z-20 mt-2 max-h-72 overflow-y-auto rounded-xl border border-[#dededc] bg-[#f8f8f7] p-1.5 shadow-lg">
                    <div className="flex items-center justify-between px-2.5 py-1.5">
                      <span className="text-xs font-semibold text-[#2d2d2d]">Add to which project?</span>
                      <button onClick={() => setPickerOpen(false)} className="text-xs text-[#6b7280] hover:text-[#2d2d2d]">✕</button>
                    </div>
                    {projects === null ? (
                      <div className="px-3 py-4 text-center text-xs text-[#6b7280]">Loading…</div>
                    ) : projects.length === 0 ? (
                      <div className="px-3 py-4 text-center text-xs text-[#6b7280]">No projects yet — create one first.</div>
                    ) : projects.map(p => (
                      <button key={p.id} onClick={() => useInReport(p.id, p.name)} disabled={savingTo === p.id}
                        className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm text-[#1a1a1a] hover:bg-[#f8f8f7] disabled:opacity-50">
                        <span className="truncate">{p.name}</span>
                        <span className="text-[11px] text-[#6b7280]">{savingTo === p.id ? 'Saving…' : 'Use →'}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Concept render disclaimer */}
              <div className="mt-2 flex items-center gap-2 text-[#6b7280] text-xs">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                AI concept render — results are for visualization purposes. Final appearance depends on materials, contractor, and site conditions.
              </div>
            </div>

            {/* Cost estimate — hidden: pricing lives in the proposal, not here. */}
            {SHOW_COST_ESTIMATE && estimate && (
              <div className="bg-[#f8f8f7] rounded-2xl overflow-hidden" style={cardStyle}>
                <div className="px-5 py-4 border-b" style={{ borderColor: 'rgba(255,255,255,0.10)' }}>
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-[#1a1a1a] font-bold text-sm">Cost Estimate</div>
                      {estimate.location && <div className="text-[#6b7280] text-xs mt-0.5">{estimate.location}</div>}
                    </div>
                    <div className="flex gap-4 text-center">
                      <div>
                        <div className="text-emerald-600 font-bold text-base leading-none">{fmt(estimate.total_low)}</div>
                        <div className="text-[#6b7280] text-[10px] mt-0.5">Low</div>
                      </div>
                      <div>
                        <div className="text-blue-600 font-bold text-base leading-none">{fmt(estimate.total_mid)}</div>
                        <div className="text-[#6b7280] text-[10px] mt-0.5">Mid</div>
                      </div>
                      <div>
                        <div className="text-[#1a1a1a] font-bold text-base leading-none">{fmt(estimate.total_high)}</div>
                        <div className="text-[#6b7280] text-[10px] mt-0.5">High</div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Line items table */}
                {estimate.line_items && estimate.line_items.length > 0 && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.10)' }}>
                          <th className="text-left px-5 py-2.5 text-[#6b7280] font-semibold">Item</th>
                          <th className="text-right px-3 py-2.5 text-[#6b7280] font-semibold">Qty</th>
                          <th className="text-right px-3 py-2.5 text-[#6b7280] font-semibold">Low</th>
                          <th className="text-right px-3 py-2.5 text-[#6b7280] font-semibold">Mid</th>
                          <th className="text-right px-3 py-2.5 text-[#6b7280] font-semibold">High</th>
                          <th className="text-left px-5 py-2.5 text-[#6b7280] font-semibold hidden md:table-cell">Source</th>
                        </tr>
                      </thead>
                      <tbody>
                        {estimate.line_items.map((item: any, i: number) => (
                          <tr key={i} className="hover:bg-[#f8f8f7]/50 transition-colors" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                            <td className="px-5 py-3 text-[#1a1a1a] font-medium">{item.item}</td>
                            <td className="px-3 py-3 text-[#6b7280] text-right whitespace-nowrap">{item.quantity} {item.unit}</td>
                            <td className="px-3 py-3 text-emerald-600 font-semibold text-right">{fmt(item.total_low)}</td>
                            <td className="px-3 py-3 text-blue-600 font-semibold text-right">{fmt(item.total_mid)}</td>
                            <td className="px-3 py-3 text-[#9ca3af] font-semibold text-right">{fmt(item.total_high)}</td>
                            <td className="px-5 py-3 text-[#6b7280] hidden md:table-cell">{item.source}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="font-bold" style={{ borderTop: '2px solid rgba(255,255,255,0.10)' }}>
                          <td className="px-5 py-3 text-[#1a1a1a]">Total</td>
                          <td />
                          <td className="px-3 py-3 text-emerald-600 text-right">{fmt(estimate.total_low)}</td>
                          <td className="px-3 py-3 text-blue-600 text-right">{fmt(estimate.total_mid)}</td>
                          <td className="px-3 py-3 text-[#1a1a1a] text-right">{fmt(estimate.total_high)}</td>
                          <td className="hidden md:table-cell" />
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}

                {/* Notes */}
                {estimate.notes && estimate.notes.length > 0 && (
                  <div className="px-5 py-4 border-t space-y-2" style={{ borderColor: 'rgba(255,255,255,0.10)' }}>
                    <div className="text-xs font-bold text-[#6b7280] uppercase tracking-wider mb-2">Notes</div>
                    {estimate.notes.map((note: string, i: number) => (
                      <div key={i} className="flex items-start gap-2 text-[#6b7280] text-xs">
                        <span className="text-blue-400 mt-0.5 flex-shrink-0">•</span>
                        {note}
                      </div>
                    ))}
                  </div>
                )}

                {/* Disclaimer */}
                {estimate.disclaimer && (
                  <div className="px-5 pb-4">
                    <div className="bg-amber-500/10 border border-amber-100 rounded-xl px-4 py-3 text-amber-700 text-xs">
                      {estimate.disclaimer}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* New visualization button */}
            <button
              onClick={() => { setResult(null); setFile(null); setPreview(null); setDescription(''); setState(''); setCity('') }}
              className="w-full py-3 rounded-xl text-[#9ca3af] font-semibold text-sm border border-[#dededc] hover:border-blue-300 hover:text-blue-600 transition-all bg-[#f8f8f7]"
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
