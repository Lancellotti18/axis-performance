'use client'

/**
 * CompanyCam-style photo detail modal.
 *
 * Shows the photo with a side panel containing captured time/geo, user notes
 * (editable), manual tags, and Claude-generated auto-tags. One click to run
 * auto-tagging. All metadata changes hit the PATCH or autotag endpoints and
 * bubble the updated Photo back through onUpdate so the parent list stays
 * in sync without a full refetch.
 */
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import type { Photo, PhotoAutoTags } from '@/types'

function formatCapturedAt(iso?: string | null): string | null {
  if (!iso) return null
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return null
    return d.toLocaleString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit',
    })
  } catch {
    return null
  }
}

export default function PhotoLightbox({
  photo,
  projectId,
  onClose,
  onUpdate,
}: {
  photo: Photo
  projectId: string
  onClose: () => void
  onUpdate: (updated: Photo) => void
}) {
  const [notes, setNotes] = useState(photo.notes || '')
  const [tagInput, setTagInput] = useState('')
  const [tags, setTags] = useState<string[]>(photo.tags || [])
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [tagging, setTagging] = useState(false)
  const [autoTags, setAutoTags] = useState<PhotoAutoTags | null>(photo.auto_tags || null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setNotes(photo.notes || '')
    setTags(photo.tags || [])
    setAutoTags(photo.auto_tags || null)
  }, [photo.id, photo.notes, photo.tags, photo.auto_tags])

  const dirty = notes !== (photo.notes || '') || tags.join('|') !== (photo.tags || []).join('|')
  const capturedLabel = formatCapturedAt(photo.captured_at || photo.created_at)
  const hasGeo = typeof photo.latitude === 'number' && typeof photo.longitude === 'number'

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const updated = await api.photos.update(projectId, photo.id, { notes, tags })
      onUpdate({ ...photo, ...updated })
      setSavedAt(Date.now())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    }
    setSaving(false)
  }

  async function runAutoTag() {
    setTagging(true)
    setError(null)
    try {
      const res = await api.photos.autoTag(projectId, photo.id)
      const tagsResult = res.auto_tags as PhotoAutoTags
      setAutoTags(tagsResult)
      onUpdate({ ...photo, auto_tags: tagsResult, ai_tagged_at: new Date().toISOString() })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Auto-tag failed')
    }
    setTagging(false)
  }

  function addTag() {
    const v = tagInput.trim().toLowerCase()
    if (!v) return
    if (tags.includes(v)) { setTagInput(''); return }
    setTags([...tags, v])
    setTagInput('')
  }

  function removeTag(t: string) {
    setTags(tags.filter(x => x !== t))
  }

  const phaseColors: Record<string, string> = {
    before: 'bg-blue-500', during: 'bg-amber-500', after: 'bg-emerald-500',
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.85)' }} onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-2xl max-w-6xl w-full max-h-[92vh] overflow-hidden flex flex-col md:flex-row"
        onClick={e => e.stopPropagation()}
      >
        {/* Image side */}
        <div className="flex-1 bg-black flex items-center justify-center min-h-[40vh] md:min-h-0">
          <img src={photo.url} alt={photo.filename} className="max-w-full max-h-[92vh] object-contain" />
        </div>

        {/* Metadata panel */}
        <div className="w-full md:w-96 flex flex-col bg-white border-l border-slate-100 overflow-y-auto">
          <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
            <div className="min-w-0">
              <div className="text-slate-800 font-bold text-sm truncate">{photo.filename}</div>
              <div className="flex items-center gap-2 mt-1">
                <span className={`text-[10px] font-bold text-white px-2 py-0.5 rounded-full capitalize ${phaseColors[photo.phase] || 'bg-slate-500'}`}>
                  {photo.phase}
                </span>
                {capturedLabel && (
                  <span className="text-[11px] text-slate-400">{capturedLabel}</span>
                )}
              </div>
            </div>
            <button onClick={onClose} aria-label="Close" className="w-8 h-8 rounded-lg bg-slate-100 hover:bg-slate-200 flex items-center justify-center text-slate-500 font-bold">
              ✕
            </button>
          </div>

          <div className="flex-1 p-5 space-y-5">
            {/* Geo */}
            {hasGeo && (
              <div className="bg-slate-50 rounded-xl px-4 py-3">
                <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Location</div>
                <div className="flex items-center gap-2 text-sm text-slate-700">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
                  <span className="font-mono text-xs">{photo.latitude!.toFixed(5)}, {photo.longitude!.toFixed(5)}</span>
                </div>
                <a
                  href={`https://www.google.com/maps/search/?api=1&query=${photo.latitude},${photo.longitude}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] text-blue-600 hover:text-blue-800 font-semibold mt-1 inline-block"
                >
                  Open in Maps →
                </a>
              </div>
            )}

            {/* Notes */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Notes</label>
                {savedAt && !dirty && (
                  <span className="text-[10px] text-emerald-600 font-semibold">✓ Saved</span>
                )}
              </div>
              <textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="Add a note about this photo…"
                rows={4}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 placeholder-slate-400 focus:outline-none focus:border-blue-400 resize-none"
              />
            </div>

            {/* Tags */}
            <div>
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1.5">Tags</label>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {tags.length === 0 && <span className="text-xs text-slate-400 italic">No tags yet</span>}
                {tags.map(t => (
                  <span key={t} className="inline-flex items-center gap-1 bg-indigo-50 border border-indigo-200 text-indigo-700 text-[11px] font-semibold px-2 py-0.5 rounded-full">
                    {t}
                    <button onClick={() => removeTag(t)} className="text-indigo-400 hover:text-indigo-700" aria-label={`Remove tag ${t}`}>×</button>
                  </span>
                ))}
              </div>
              <div className="flex gap-2">
                <input
                  value={tagInput}
                  onChange={e => setTagInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTag() } }}
                  placeholder="Add tag…"
                  className="flex-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-700 focus:outline-none focus:border-blue-400"
                />
                <button
                  onClick={addTag}
                  className="text-xs font-semibold text-white bg-indigo-500 hover:bg-indigo-600 rounded-lg px-3"
                >
                  Add
                </button>
              </div>
            </div>

            {/* Auto tags */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">AI Tags</label>
                <button
                  onClick={runAutoTag}
                  disabled={tagging}
                  className="text-[11px] font-semibold text-indigo-600 hover:text-indigo-800 disabled:opacity-50"
                >
                  {tagging ? 'Analyzing…' : autoTags ? 'Re-run' : '✨ Auto-tag with AI'}
                </button>
              </div>
              {autoTags ? (
                <div className="bg-slate-50 rounded-xl px-3 py-2.5 space-y-2">
                  {autoTags.autotag_unverified && (
                    <div className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                      Model couldn&apos;t confidently tag this photo.
                    </div>
                  )}
                  {autoTags.summary && (
                    <div className="text-xs text-slate-600 italic">&ldquo;{autoTags.summary}&rdquo;</div>
                  )}
                  <div className="flex flex-wrap gap-1">
                    {autoTags.area && (
                      <span className="text-[10px] font-bold bg-white border border-slate-200 text-slate-700 px-2 py-0.5 rounded-full capitalize">
                        area: {autoTags.area}
                      </span>
                    )}
                    {autoTags.phase && (
                      <span className="text-[10px] font-bold bg-white border border-slate-200 text-slate-700 px-2 py-0.5 rounded-full capitalize">
                        phase: {autoTags.phase}
                      </span>
                    )}
                    {(autoTags.materials || []).map(m => (
                      <span key={m} className="text-[10px] font-semibold bg-blue-50 border border-blue-200 text-blue-700 px-2 py-0.5 rounded-full">{m}</span>
                    ))}
                    {(autoTags.damage || []).map(d => (
                      <span key={d} className="text-[10px] font-semibold bg-red-50 border border-red-200 text-red-700 px-2 py-0.5 rounded-full">⚠ {d}</span>
                    ))}
                    {(autoTags.safety || []).map(s => (
                      <span key={s} className="text-[10px] font-semibold bg-amber-50 border border-amber-200 text-amber-700 px-2 py-0.5 rounded-full">{s}</span>
                    ))}
                  </div>
                  {typeof autoTags.confidence === 'number' && autoTags.confidence > 0 && (
                    <div className="text-[10px] text-slate-400">
                      Confidence {Math.round((autoTags.confidence || 0) * 100)}%
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-xs text-slate-400 italic">Click Auto-tag to let AI label materials, damage, and phase.</div>
              )}
            </div>

            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 text-xs rounded-xl px-3 py-2">
                {error}
              </div>
            )}
          </div>

          <div className="px-5 py-3 border-t border-slate-100 flex items-center justify-between bg-slate-50">
            <button onClick={onClose} className="text-sm font-semibold text-slate-500 hover:text-slate-700">
              Close
            </button>
            <button
              onClick={save}
              disabled={!dirty || saving}
              className="text-sm font-bold text-white px-4 py-2 rounded-xl transition-all disabled:opacity-40 disabled:cursor-not-allowed hover:scale-[1.02]"
              style={{ background: 'linear-gradient(135deg, #3b82f6, #1d4ed8)' }}
            >
              {saving ? 'Saving…' : 'Save notes & tags'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
