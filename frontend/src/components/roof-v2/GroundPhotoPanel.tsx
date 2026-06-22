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

/** Convert an iPhone HEIC/HEIF file to a JPEG File in the browser. heic2any is
 *  loaded lazily so it only downloads when a HEIC is actually picked. */
async function heicToJpeg(file: File): Promise<File> {
  const heic2any = (await import('heic2any')).default as (opts: {
    blob: Blob; toType?: string; quality?: number
  }) => Promise<Blob | Blob[]>
  const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 })
  const blob = Array.isArray(out) ? out[0] : out
  const name = file.name.replace(/\.(heic|heif)$/i, '.jpg')
  return new File([blob], name || 'photo.jpg', { type: 'image/jpeg' })
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
          } catch {
            throw new Error('Could not convert this HEIC photo — please export it as JPG and retry.')
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
                        ? <FindingsView f={r.findings} onApplyPitch={applyPitch} onAddChimney={addChimney} />
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

/** Optional but recommended photo-taking walkthrough. */
function PhotoGuide() {
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-2 rounded-md border border-blue-400/20 bg-blue-500/5">
      <button onClick={() => setOpen(o => !o)} className="flex w-full items-center justify-between px-3 py-2 text-left text-xs">
        <span className="font-semibold text-blue-200">📸 Recommended photos — how to shoot for the best AI results</span>
        <span className="text-slate-400">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className="border-t border-blue-400/10 px-3 py-2 text-[11px] text-slate-300">
          <p className="mb-2 text-slate-400">Optional, but each shot makes the estimate more accurate. Stand back so the whole feature is in frame, hold the phone level, shoot in daylight.</p>
          <ol className="space-y-1.5">
            <li><strong className="text-white">1. A gable end (most important).</strong> Stand facing the triangular end wall of the roof, square-on. → gives true <strong>pitch</strong>, which drives roof area + flashing.</li>
            <li><strong className="text-white">2. Each corner of the house (4 shots).</strong> Step to each corner so two sides of the roof show. → confirms plane count + slope directions.</li>
            <li><strong className="text-white">3. Any chimney, straight-on.</strong> Include the full height + where it meets the roof. → adds chimney + cricket flashing automatically.</li>
            <li><strong className="text-white">4. A skylight or dormer, if present.</strong> → adds the right flashing kit.</li>
            <li><strong className="text-white">5. A close-up of the shingles/roof surface.</strong> → identifies material + color for the report.</li>
          </ol>
          <p className="mt-2 text-slate-500">Tip: a clear, square-on gable shot in good light is worth more than ten blurry angles.</p>
          <p className="mt-1 text-slate-500">Uploading a <strong>PDF</strong>? Every page is read as a separate photo (up to 12) — each page gets its own findings.</p>
        </div>
      )}
    </div>
  )
}

function FindingsView({
  f, onApplyPitch, onAddChimney,
}: { f: Findings; onApplyPitch: (p: string) => void; onAddChimney: (n: number) => void }) {
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
          <span>Chimney ×{f.chimney.count || 1} · {f.chimney.height} · {f.chimney.material}</span>
          <button onClick={() => onAddChimney(f.chimney.count || 1)}
            className="rounded bg-purple-700 px-2 py-0.5 text-[10px] text-white hover:bg-purple-600">Add chimney</button>
        </div>
      )}
      <div className="text-[10px] text-slate-500">
        {f.dormers > 0 && `${f.dormers} dormer(s) · `}
        {f.gable_walls_visible > 0 && `${f.gable_walls_visible} gable wall(s) · `}
        {f.skylights > 0 && `${f.skylights} skylight(s) · `}
        {f.roof_material !== 'unknown' && `${f.roof_material.replace('_', ' ')}${f.roof_color ? ` (${f.roof_color})` : ''} · `}
        {f.stories} stor{f.stories === 1 ? 'y' : 'ies'}
      </div>
      {f.notes && <div className="text-[10px] italic text-slate-500">{f.notes}</div>}
    </div>
  )
}
