'use client'

/**
 * GroundPhotoPanel — Phase 3 exterior intelligence.
 *
 * A satellite tile is top-down: it can't show roof PITCH, chimney HEIGHT, or
 * gable walls. This panel lets the contractor upload ground-level photos; each
 * is analyzed by Gemini for the things that improve a ROOF estimate, and the
 * contractor applies the findings:
 *   • Apply pitch  → sets every facet's pitch (drives area + flashing accuracy)
 *   • Add chimney  → posts a chimney penetration (→ chimney/cricket flashing)
 *
 * Photos upload directly to the Supabase `exterior-photos` bucket (same bucket
 * + RLS the exterior module uses); analysis is read-only until the contractor
 * explicitly applies a finding.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'

import { api } from '@/lib/api'

type Findings = NonNullable<Awaited<ReturnType<typeof api.roofing.v2.analyzeGroundPhoto>>['findings']>
type PageResult = { page: number; findings: Findings | null; message: string }

const jpgName = (n: string) => n.replace(/\.(heic|heif)$/i, '.jpg') || 'photo.jpg'

/** Try the BROWSER's native decoder (Safari/macOS decodes HEIC; many others
 *  don't). Loads the file into an <img>, draws to a canvas, exports JPEG.
 *  Resolves null if the browser can't decode it — caller then falls back. */
function tryNativeHeicDecode(file: File): Promise<File | null> {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      try {
        if (!img.naturalWidth) { URL.revokeObjectURL(url); return resolve(null) }
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        const ctx = canvas.getContext('2d')
        if (!ctx) { URL.revokeObjectURL(url); return resolve(null) }
        ctx.drawImage(img, 0, 0)
        canvas.toBlob(blob => {
          URL.revokeObjectURL(url)
          resolve(blob ? new File([blob], jpgName(file.name), { type: 'image/jpeg' }) : null)
        }, 'image/jpeg', 0.9)
      } catch { URL.revokeObjectURL(url); resolve(null) }
    }
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null) }
    img.src = url
  })
}

/** Convert an iPhone HEIC/HEIF file to a JPEG File in the browser:
 *  native decoder first (most reliable where supported), then the heic2any
 *  WASM fallback. heic2any is lazy-loaded so it only downloads when needed. */
async function heicToJpeg(file: File): Promise<File> {
  const native = await tryNativeHeicDecode(file)
  if (native) return native

  const heic2any = (await import('heic2any')).default as (opts: {
    blob: Blob; toType?: string; quality?: number
  }) => Promise<Blob | Blob[]>
  const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 })
  const blob = Array.isArray(out) ? out[0] : out
  return new File([blob], jpgName(file.name), { type: 'image/jpeg' })
}

interface PhotoEntry {
  id: string
  slot: string
  previewUrl: string
  name: string
  isPdf: boolean
  status: 'analyzing' | 'done' | 'error'
  results?: PageResult[]
  error?: string
}

// Guided walk-around: the contractor uploads into the slot that matches where
// they're standing, in order, as if circling the house. Each slot is optional
// and accepts more than one photo; "extra" catches anything else.
interface Slot { key: string; label: string; emoji: string; hint: string; star?: boolean }
const SLOTS: Slot[] = [
  { key: 'front',   label: 'Front of house',      emoji: '🏠', hint: 'Whole front elevation, phone level' },
  { key: 'right',   label: 'Right side',          emoji: '↩️', hint: 'Stand at the corner — two roof sides in frame' },
  { key: 'back',    label: 'Back of house',       emoji: '🏡', hint: 'Whole rear elevation' },
  { key: 'left',    label: 'Left side',           emoji: '↪️', hint: 'Stand at the corner — two roof sides in frame' },
  { key: 'gable',   label: 'Gable end (pitch)',   emoji: '📐', hint: 'Triangular end wall, square-on — best shot for pitch', star: true },
  { key: 'chimney', label: 'Chimney',             emoji: '🧱', hint: 'Full height + where it meets the roof' },
  { key: 'features',label: 'Skylights / dormers', emoji: '🔲', hint: 'Any skylight, dormer, or roof-to-wall spot' },
  { key: 'shingle', label: 'Shingle close-up',    emoji: '🎨', hint: '~3 ft from a roof edge — material + color' },
  { key: 'extra',   label: 'Additional photos',   emoji: '➕', hint: 'Anything else worth capturing' },
]

interface Props {
  runId: string
  /** apply a detected pitch to all facets; returns true if any facet was updated */
  onApplyPitch?: (pitch: string) => boolean
  /** notify the editor a chimney was added (so it can refresh penetrations/flashing) */
  onChimneyAdded?: () => void
}

export default function GroundPhotoPanel({ runId, onApplyPitch, onChimneyAdded }: Props) {
  const [photos, setPhotos] = useState<PhotoEntry[]>([])
  const idRef = useRef(0)

  const handleFiles = useCallback(async (slot: string, files: FileList | null) => {
    if (!files || files.length === 0) return
    for (const original of Array.from(files)) {
      const id = `p${idRef.current++}`
      const isPdf = original.type === 'application/pdf' || /\.pdf$/i.test(original.name)
      const isHeic = !isPdf && (/^image\/hei[cf]$/i.test(original.type) || /\.(heic|heif)$/i.test(original.name))
      setPhotos(prev => [...prev, { id, slot, previewUrl: '', name: original.name, isPdf, status: 'analyzing' }])
      try {
        // iPhone HEIC isn't decodable server-side reliably, so convert it to JPEG
        // RIGHT HERE in the browser before upload. Bulletproof + no server dep.
        let file = original
        if (isHeic) {
          try {
            file = await heicToJpeg(original)
          } catch (err) {
            const why = err instanceof Error ? err.message : 'unknown error'
            throw new Error(
              `Couldn't read this HEIC (${why}). Easiest fix: on iPhone set ` +
              `Settings → Camera → Formats → "Most Compatible" (shoots JPG), or ` +
              `share/export the photo as JPG and upload that.`,
            )
          }
        }
        // Now we have a viewable image (or PDF) — set the preview.
        const previewUrl = isPdf ? '' : URL.createObjectURL(file)
        setPhotos(prev => prev.map(p => p.id === id ? { ...p, previewUrl } : p))

        // Send the bytes straight to the backend — no storage round-trip.
        const res = await api.roofing.v2.analyzeGroundPhoto(runId, file, slot)
        const results = res.results ?? (res.findings ? [{ page: 1, findings: res.findings, message: res.message }] : [])
        const anyUsable = results.some(r => r.findings)
        setPhotos(prev => prev.map(p => p.id === id
          ? { ...p, status: 'done', results, error: anyUsable ? undefined : res.message }
          : p))
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'analysis failed'
        setPhotos(prev => prev.map(p => p.id === id ? { ...p, status: 'error', error: msg } : p))
        toast.error(`${original.name}: ${msg}`)
      }
    }
  }, [runId])

  const removePhoto = useCallback((id: string) => setPhotos(prev => prev.filter(p => p.id !== id)), [])

  // On open, reload photos already saved to this run so they reappear in their
  // walk-around slots — a contractor's job-site pictures are never lost.
  useEffect(() => {
    let cancelled = false
    api.roofing.v2.getRun(runId).then(r => {
      if (cancelled) return
      const saved = (((r as { run?: { ground_photo_urls?: Array<{ url?: string; slot?: string } | string> } }).run?.ground_photo_urls) || [])
      const entries: PhotoEntry[] = saved.map((s, i) => {
        const url = typeof s === 'string' ? s : (s.url || '')
        const slot = typeof s === 'string' ? 'extra' : (s.slot || 'extra')
        return { id: `saved-${i}`, slot, previewUrl: url, name: 'Saved photo', isPdf: false, status: 'done' as const }
      }).filter(e => e.previewUrl)
      if (entries.length) setPhotos(entries)
    }).catch(() => { /* best-effort — a fresh session still works */ })
    return () => { cancelled = true }
  }, [runId])

  const applyPitch = useCallback((pitch: string): boolean => {
    if (!pitch || !onApplyPitch) return false
    const applied = onApplyPitch(pitch)
    if (applied) toast.success(`Applied ${pitch} pitch to every facet — areas recomputed`)
    else toast.error('No facets yet — auto-detect or draw your roof first, then apply pitch.')
    return applied
  }, [onApplyPitch])

  const addChimney = useCallback(async (count: number) => {
    try {
      for (let i = 0; i < Math.max(1, count); i++) {
        await api.roofing.v2.addPenetration(runId, {
          type: 'chimney', count: 1, width_in: 24, height_in: 24,
          ai_suggested: true, user_confirmed: true,
          notes: 'Added from ground-photo analysis',
        })
      }
      toast.success(`Added ${Math.max(1, count)} chimney — re-run flashing to include it`)
      onChimneyAdded?.()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not add chimney')
    }
  }, [runId, onChimneyAdded])

  const addSkylight = useCallback(async (count: number) => {
    try {
      for (let i = 0; i < Math.max(1, count); i++) {
        await api.roofing.v2.addPenetration(runId, {
          type: 'skylight', count: 1, width_in: 24, height_in: 36,
          ai_suggested: true, user_confirmed: true,
          notes: 'Added from ground-photo analysis',
        })
      }
      toast.success(`Added ${Math.max(1, count)} skylight — re-run flashing to include it`)
      onChimneyAdded?.()   // generic "penetration added — refresh flashing" hook
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not add skylight')
    }
  }, [runId, onChimneyAdded])

  return (
    <section className="rounded-lg border border-white/10 bg-slate-900/40 p-4 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">Ground-photo intelligence</h3>
          <p className="text-xs text-slate-400">
            Upload ground-level photos <strong>or a PDF</strong>. AI reads what the satellite can&apos;t — roof
            <strong> pitch</strong>, <strong>chimneys</strong>, dormers, gable walls, materials — and you apply the findings.
          </p>
        </div>
      </div>

      <PhotoGuide />

      {/* Guided walk-around: drop each photo into the slot where you're standing. */}
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {SLOTS.map(slot => (
          <PhotoSlot key={slot.key} slot={slot}
            photos={photos.filter(p => p.slot === slot.key)}
            onFiles={files => handleFiles(slot.key, files)}
            onRemove={removePhoto}
            onApplyPitch={applyPitch} onAddChimney={addChimney} onAddSkylight={addSkylight} />
        ))}
      </div>
    </section>
  )
}

/** One labeled walk-around slot: its own camera + upload, and inline results. */
function PhotoSlot({
  slot, photos, onFiles, onRemove, onApplyPitch, onAddChimney, onAddSkylight,
}: {
  slot: Slot
  photos: PhotoEntry[]
  onFiles: (files: FileList | null) => void
  onRemove: (id: string) => void
  onApplyPitch: (p: string) => boolean
  onAddChimney: (n: number) => void
  onAddSkylight: (n: number) => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const camRef = useRef<HTMLInputElement>(null)
  const done = photos.some(p => p.status === 'done')
  return (
    <div className={`rounded-lg border p-2.5 transition-colors ${done ? 'border-emerald-400/25 bg-emerald-500/[0.05]' : slot.star ? 'border-amber-400/30 bg-amber-500/[0.04]' : 'border-white/10 bg-slate-900/40'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-100">
            <span>{slot.emoji}</span><span>{slot.label}</span>
            {slot.star && <span className="rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[9px] font-bold uppercase text-amber-300">Best for pitch</span>}
            {done && <span className="text-emerald-400">✓</span>}
          </div>
          <div className="mt-0.5 text-[11px] leading-snug text-slate-400">{slot.hint}</div>
        </div>
        <div className="flex flex-shrink-0 gap-1">
          <button onClick={() => camRef.current?.click()} title="Take photo"
            className="rounded bg-emerald-600/90 px-2 py-1 text-[11px] font-semibold text-white hover:bg-emerald-500">📷</button>
          <button onClick={() => fileRef.current?.click()} title="Upload"
            className="rounded bg-blue-600/90 px-2 py-1 text-[11px] text-white hover:bg-blue-500">＋</button>
        </div>
        <input ref={camRef} type="file" accept="image/*,.heic,.heif,.HEIC,.HEIF" capture="environment" hidden
          onChange={e => { onFiles(e.target.files); if (camRef.current) camRef.current.value = '' }} />
        <input ref={fileRef} type="file" accept="image/*,.heic,.heif,.HEIC,.HEIF,application/pdf,.pdf" multiple hidden
          onChange={e => { onFiles(e.target.files); if (fileRef.current) fileRef.current.value = '' }} />
      </div>

      {photos.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {photos.map(p => (
            <li key={p.id} className="flex gap-2 rounded-md border border-white/10 bg-slate-900/50 p-1.5">
              {p.isPdf ? (
                <div className="flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded bg-rose-500/15 text-rose-300"><span className="text-sm leading-none">📄</span></div>
              ) : p.previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={p.previewUrl} alt={p.name} className="h-12 w-12 shrink-0 rounded object-cover" />
              ) : (
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded bg-slate-800 text-[10px] text-slate-500">…</div>
              )}
              <div className="min-w-0 flex-1">
                {p.status === 'analyzing' && <div className="flex items-center gap-1.5 text-[11px] text-blue-300"><span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-blue-400 border-t-transparent" /> Analyzing…</div>}
                {p.status === 'error' && <div className="text-[11px] text-rose-400">{p.error}</div>}
                {p.status === 'done' && p.results && p.results.some(r => r.findings) ? (
                  <div className="space-y-1">
                    {p.results.map(r => r.findings
                      ? <FindingsView key={r.page} f={r.findings} onApplyPitch={onApplyPitch} onAddChimney={onAddChimney} onAddSkylight={onAddSkylight} />
                      : null)}
                  </div>
                ) : p.status === 'done' && (
                  <div className="text-[11px] text-amber-400">{p.error || 'No usable findings — the photo still saves.'}</div>
                )}
              </div>
              <button onClick={() => onRemove(p.id)} title="Remove"
                className="h-5 w-5 flex-shrink-0 rounded text-slate-500 hover:bg-rose-500/15 hover:text-rose-300">✕</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Contractor photo playbook — exactly what to shoot, how many, and the angle. */
function PhotoGuide() {
  const [open, setOpen] = useState(true)
  return (
    <div className="mt-2 rounded-md border border-blue-400/20 bg-blue-500/5">
      <button onClick={() => setOpen(o => !o)} className="flex w-full items-center justify-between px-3 py-2 text-left text-xs">
        <span className="font-semibold text-blue-200">📸 Photo playbook — exactly what to shoot for an accurate estimate</span>
        <span className="text-slate-400">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-blue-400/10 px-3 py-2.5 text-[11px] text-slate-300">
          <div className="rounded bg-slate-900/50 p-2">
            <div className="font-semibold text-blue-200">The 30-second walk-around (6–8 photos)</div>
            <p className="mt-0.5 text-slate-400">Walk the perimeter once. Shoot in daylight, hold the phone level (landscape), and stand back far enough that the <em>whole</em> feature is in frame. More clear photos = more accurate — but a few good ones beat a dozen blurry ones.</p>
          </div>

          <ol className="space-y-2">
            <li>
              <div className="font-semibold text-white">1 · Gable end — square-on <span className="text-emerald-300">(most important — 1–2 shots)</span></div>
              <div className="text-slate-400">Face the <strong>triangular end wall</strong> dead-on, not at an angle. This is the single best shot for <strong>pitch</strong>, which drives roof area, squares, and flashing. If the house has gable ends at both ends, shoot both.</div>
            </li>
            <li>
              <div className="font-semibold text-white">2 · The four corners <span className="text-slate-400">(4 shots)</span></div>
              <div className="text-slate-400">Stand at each corner of the house so <strong>two roof sides show at once</strong>. Confirms how many planes there are and which way they face — the count sanity-check in auto-detect uses this.</div>
            </li>
            <li>
              <div className="font-semibold text-white">3 · Every chimney — straight-on <span className="text-purple-300">(1 per chimney)</span></div>
              <div className="text-slate-400">Get the <strong>full height</strong> and the line <strong>where it meets the roof</strong>. → one-tap chimney + cricket flashing.</div>
            </li>
            <li>
              <div className="font-semibold text-white">4 · Skylights, dormers, and roof-to-wall spots <span className="text-amber-300">(as needed)</span></div>
              <div className="text-slate-400">Any <strong>dormer</strong>, <strong>skylight</strong>, or place a <strong>lower roof runs into a taller wall</strong> (porch/garage meeting a 2-story wall). → these become your step-flashing edges to confirm.</div>
            </li>
            <li>
              <div className="font-semibold text-white">5 · A shingle close-up <span className="text-slate-400">(1 shot)</span></div>
              <div className="text-slate-400">Stand ~3 ft from a roof edge or a ground-level sample. → identifies material + color for the report.</div>
            </li>
          </ol>

          <div className="rounded border border-amber-400/20 bg-amber-500/5 p-2 text-amber-200/90">
            <div className="font-semibold">Angle cheatsheet</div>
            <ul className="mt-0.5 list-disc space-y-0.5 pl-4">
              <li><strong>Pitch</strong> → shoot the gable end perfectly side-on (you should see the roof slope as a clean triangle).</li>
              <li><strong>Flashing</strong> → include both the feature AND the roof line it touches in the same frame.</li>
              <li>Avoid: steep up-angles, backlight/sun behind the house, and zoom (walk closer instead).</li>
            </ul>
          </div>

          <p className="text-slate-500">Formats: JPG/PNG/HEIC, or a <strong>PDF</strong> (each page is read as its own photo, up to 12). You can also tap <strong>📷 Take photo</strong> on your phone to shoot right now.</p>
        </div>
      )}
    </div>
  )
}

function FindingsView({
  f, onApplyPitch, onAddChimney, onAddSkylight,
}: { f: Findings; onApplyPitch: (p: string) => boolean; onAddChimney: (n: number) => void; onAddSkylight: (n: number) => void }) {
  const confColor = f.pitch_confidence === 'high' ? 'text-emerald-300' : f.pitch_confidence === 'medium' ? 'text-amber-300' : 'text-rose-300'
  const [applied, setApplied] = useState(false)
  return (
    <div className="mt-1 space-y-1">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-300">
        {f.roof_pitch ? (
          <>
            <span>
              Pitch <strong className="text-white">{f.roof_pitch}</strong>{' '}
              <span
                className={confColor}
                title="How sure the AI is about the pitch read — not measured accuracy. A square-on shot of a gable END (the triangular wall) reads 'high'. 'Medium' is usable; verify it or re-shoot the gable straight-on for 'high'."
              >({f.pitch_confidence})</span>
            </span>
            {applied ? (
              <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-300 ring-1 ring-emerald-400/30">✓ Applied to all facets</span>
            ) : (
              <button onClick={() => { if (onApplyPitch(f.roof_pitch)) setApplied(true) }}
                className="rounded bg-emerald-700 px-2 py-0.5 text-[10px] text-white hover:bg-emerald-600">Apply to facets</button>
            )}
            {f.pitch_confidence !== 'high' && (
              <span className="text-[10px] text-slate-500">↳ for &quot;high&quot;, shoot the gable end square-on</span>
            )}
          </>
        ) : <span className="text-amber-300/80">No clear roof slope here — for pitch, shoot a <strong>gable end</strong> (the triangular end wall) square-on.</span>}
      </div>
      {f.chimney.present && (
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-300">
          <span>🧱 Chimney ×{f.chimney.count || 1} · {f.chimney.height} · {f.chimney.material} <span className="text-slate-500">→ chimney + cricket flashing</span></span>
          <button onClick={() => onAddChimney(f.chimney.count || 1)}
            className="rounded bg-purple-700 px-2 py-0.5 text-[10px] text-white hover:bg-purple-600">Add chimney</button>
        </div>
      )}
      {f.skylights > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-300">
          <span>🔲 Skylight ×{f.skylights} <span className="text-slate-500">→ skylight flashing kit</span></span>
          <button onClick={() => onAddSkylight(f.skylights)}
            className="rounded bg-purple-700 px-2 py-0.5 text-[10px] text-white hover:bg-purple-600">Add skylight</button>
        </div>
      )}
      {f.dormers > 0 && (
        <div className="rounded bg-amber-500/10 px-2 py-1 text-[10px] text-amber-200/90">
          🏠 {f.dormers} dormer(s) → needs step flashing. In the editor, label each dormer&apos;s
          side (&quot;cheek&quot;) edges as <strong>wall intersection</strong> so flashing picks them up.
        </div>
      )}
      {f.wall_abutment?.present && (
        <div className="rounded bg-amber-500/10 px-2 py-1 text-[10px] text-amber-200/90">
          🧱 Roof meets a taller wall → needs <strong>step/apron flashing</strong>. In the editor,
          label that roof-to-wall edge as <strong>wall intersection</strong> so flashing includes it.
          {f.wall_abutment.note ? <span className="text-amber-200/60"> ({f.wall_abutment.note})</span> : null}
        </div>
      )}
      <div className="text-[10px] text-slate-500">
        {f.gable_walls_visible > 0 && `${f.gable_walls_visible} gable wall(s) · `}
        {f.roof_material !== 'unknown' && `${f.roof_material.replace('_', ' ')}${f.roof_color ? ` (${f.roof_color})` : ''} · `}
        {f.stories} stor{f.stories === 1 ? 'y' : 'ies'}
      </div>
      {f.notes && <div className="text-[10px] italic text-slate-500">{f.notes}</div>}
    </div>
  )
}
