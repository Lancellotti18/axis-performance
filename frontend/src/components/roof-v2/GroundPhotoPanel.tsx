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
import { useCallback, useRef, useState } from 'react'
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
  previewUrl: string
  name: string
  isPdf: boolean
  status: 'analyzing' | 'done' | 'error'
  results?: PageResult[]
  error?: string
}

interface Props {
  runId: string
  /** apply a detected pitch to all facets */
  onApplyPitch?: (pitch: string) => void
  /** notify the editor a chimney was added (so it can refresh penetrations/flashing) */
  onChimneyAdded?: () => void
}

export default function GroundPhotoPanel({ runId, onApplyPitch, onChimneyAdded }: Props) {
  const [photos, setPhotos] = useState<PhotoEntry[]>([])
  const fileRef = useRef<HTMLInputElement>(null)
  const cameraRef = useRef<HTMLInputElement>(null)
  const idRef = useRef(0)

  const handleFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return
    for (const original of Array.from(files)) {
      const id = `p${idRef.current++}`
      const isPdf = original.type === 'application/pdf' || /\.pdf$/i.test(original.name)
      const isHeic = !isPdf && (/^image\/hei[cf]$/i.test(original.type) || /\.(heic|heif)$/i.test(original.name))
      setPhotos(prev => [...prev, { id, previewUrl: '', name: original.name, isPdf, status: 'analyzing' }])
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
        const res = await api.roofing.v2.analyzeGroundPhoto(runId, file)
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

  const applyPitch = useCallback((pitch: string) => {
    if (!pitch || !onApplyPitch) return
    onApplyPitch(pitch)
    toast.success(`Applied ${pitch} pitch to all facets`)
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
        <div className="flex gap-2">
          <button
            onClick={() => cameraRef.current?.click()}
            className="flex items-center gap-1.5 rounded bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500"
          >📷 Take photo</button>
          <button
            onClick={() => fileRef.current?.click()}
            className="rounded bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-500"
          >Upload</button>
        </div>
        {/* Camera capture (mobile opens the rear camera directly). HEIC/HEIF
            extensions are listed EXPLICITLY — some file pickers don't match
            iPhone .heic files to the generic image/* type. The backend
            normalizes every format (incl. HEIC + PDF). */}
        <input ref={cameraRef} type="file" accept="image/*,.heic,.heif,.HEIC,.HEIF" capture="environment" hidden
          onChange={e => { void handleFiles(e.target.files); if (cameraRef.current) cameraRef.current.value = '' }} />
        <input ref={fileRef} type="file" accept="image/*,.heic,.heif,.HEIC,.HEIF,application/pdf,.pdf" multiple hidden
          onChange={e => { void handleFiles(e.target.files); if (fileRef.current) fileRef.current.value = '' }} />
      </div>

      <PhotoGuide />

      {photos.length === 0 && (
        <p className="mt-3 text-xs text-slate-500">
          On your phone, tap <strong>📷 Take photo</strong> to shoot a gable end / chimney right now — a clear gable shot gives the best pitch reading.
        </p>
      )}

      <ul className="mt-3 space-y-2">
        {photos.map(p => (
          <li key={p.id} className="flex gap-3 rounded-md border border-white/10 p-2">
            {p.isPdf ? (
              <div className="flex h-16 w-16 shrink-0 flex-col items-center justify-center rounded bg-rose-500/15 text-rose-300">
                <span className="text-lg leading-none">📄</span>
                <span className="mt-0.5 text-[9px] font-semibold">PDF</span>
              </div>
            ) : p.previewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={p.previewUrl} alt={p.name} className="h-16 w-16 shrink-0 rounded object-cover" />
            ) : (
              <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded bg-slate-800 text-[10px] text-slate-500">…</div>
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs text-slate-300">{p.name}</div>
              {p.status === 'analyzing' && <div className="flex items-center gap-1.5 text-[11px] text-blue-300"><span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-blue-400 border-t-transparent" /> Analyzing with AI…</div>}
              {p.status === 'error' && <div className="text-[11px] text-rose-400">{p.error}</div>}
              {p.status === 'done' && p.results && p.results.length > 0 ? (
                <div className="space-y-1.5">
                  {p.results.map(r => (
                    <div key={r.page}>
                      {p.results!.length > 1 && (
                        <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Page {r.page}</div>
                      )}
                      {r.findings
                        ? <FindingsView f={r.findings} onApplyPitch={applyPitch} onAddChimney={addChimney} onAddSkylight={addSkylight} />
                        : <div className="text-[11px] text-amber-400">{r.message || 'No usable findings'}</div>}
                    </div>
                  ))}
                </div>
              ) : p.status === 'done' && (
                <div className="text-[11px] text-amber-400">{p.error || 'No usable findings'}</div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
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
}: { f: Findings; onApplyPitch: (p: string) => void; onAddChimney: (n: number) => void; onAddSkylight: (n: number) => void }) {
  const confColor = f.pitch_confidence === 'high' ? 'text-emerald-300' : f.pitch_confidence === 'medium' ? 'text-amber-300' : 'text-rose-300'
  return (
    <div className="mt-1 space-y-1">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-300">
        {f.roof_pitch ? (
          <>
            <span>Pitch <strong className="text-white">{f.roof_pitch}</strong> <span className={confColor}>({f.pitch_confidence})</span></span>
            <button onClick={() => onApplyPitch(f.roof_pitch)}
              className="rounded bg-emerald-700 px-2 py-0.5 text-[10px] text-white hover:bg-emerald-600">Apply to facets</button>
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
