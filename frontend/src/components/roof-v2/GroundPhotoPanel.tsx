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
import { supabase } from '@/lib/supabase'

type Findings = NonNullable<Awaited<ReturnType<typeof api.roofing.v2.analyzeGroundPhoto>>['findings']>

interface PhotoEntry {
  url: string
  name: string
  status: 'uploading' | 'analyzing' | 'done' | 'error'
  findings?: Findings
  error?: string
}

interface Props {
  runId: string
  projectId: string
  userId: string
  /** apply a detected pitch to all facets */
  onApplyPitch?: (pitch: string) => void
  /** notify the editor a chimney was added (so it can refresh penetrations/flashing) */
  onChimneyAdded?: () => void
}

const ACCEPTED = 'image/jpeg,image/png,image/webp'

export default function GroundPhotoPanel({ runId, projectId, userId, onApplyPitch, onChimneyAdded }: Props) {
  const [photos, setPhotos] = useState<PhotoEntry[]>([])
  const fileRef = useRef<HTMLInputElement>(null)

  const analyze = useCallback(async (url: string) => {
    setPhotos(prev => prev.map(p => p.url === url ? { ...p, status: 'analyzing' } : p))
    try {
      const res = await api.roofing.v2.analyzeGroundPhoto(runId, url)
      setPhotos(prev => prev.map(p => p.url === url
        ? { ...p, status: 'done', findings: res.findings ?? undefined, error: res.findings ? undefined : res.message }
        : p))
    } catch (e) {
      setPhotos(prev => prev.map(p => p.url === url
        ? { ...p, status: 'error', error: e instanceof Error ? e.message : 'analysis failed' } : p))
    }
  }, [runId])

  const handleFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return
    for (const file of Array.from(files)) {
      if (!ACCEPTED.includes(file.type)) {
        toast.error(`${file.name}: unsupported type`)
        continue
      }
      const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
      const path = `${userId}/${projectId}/ground-${Date.now()}-${safe}`
      const entry: PhotoEntry = { url: '', name: file.name, status: 'uploading' }
      setPhotos(prev => [...prev, entry])
      try {
        const { error: upErr } = await supabase.storage.from('exterior-photos').upload(path, file, {
          cacheControl: '3600', upsert: false, contentType: file.type || 'image/jpeg',
        })
        if (upErr) throw upErr
        const { data: pub } = supabase.storage.from('exterior-photos').getPublicUrl(path)
        const url = pub.publicUrl
        setPhotos(prev => prev.map(p => (p === entry || (p.name === file.name && !p.url)) ? { ...p, url } : p))
        await analyze(url)
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'upload failed'
        setPhotos(prev => prev.map(p => (p === entry || p.name === file.name) ? { ...p, status: 'error', error: msg } : p))
        toast.error(`${file.name}: ${msg}`)
      }
    }
  }, [userId, projectId, analyze])

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
            Upload ground-level photos. AI reads what the satellite can&apos;t — roof
            <strong> pitch</strong>, <strong>chimneys</strong>, dormers, gable walls, materials — and you apply the findings.
          </p>
        </div>
        <button
          onClick={() => fileRef.current?.click()}
          className="rounded bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-500"
        >+ Add photos</button>
        <input ref={fileRef} type="file" accept={ACCEPTED} multiple hidden
          onChange={e => { void handleFiles(e.target.files); if (fileRef.current) fileRef.current.value = '' }} />
      </div>

      {photos.length === 0 && (
        <p className="mt-3 text-xs text-slate-500">
          No photos yet. A clear shot of a gable end gives the best pitch reading.
        </p>
      )}

      <ul className="mt-3 space-y-2">
        {photos.map((p, i) => (
          <li key={i} className="flex gap-3 rounded-md border border-white/10 p-2">
            {p.url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={p.url} alt={p.name} className="h-16 w-16 shrink-0 rounded object-cover" />
            ) : (
              <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded bg-slate-800 text-[10px] text-slate-500">…</div>
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs text-slate-300">{p.name}</div>
              {p.status === 'uploading' && <div className="text-[11px] text-blue-300">Uploading…</div>}
              {p.status === 'analyzing' && <div className="text-[11px] text-blue-300">Analyzing with AI…</div>}
              {p.status === 'error' && <div className="text-[11px] text-rose-400">{p.error}</div>}
              {p.status === 'done' && p.findings && <FindingsView f={p.findings} onApplyPitch={applyPitch} onAddChimney={addChimney} />}
              {p.status === 'done' && !p.findings && <div className="text-[11px] text-amber-400">{p.error || 'No usable findings'}</div>}
            </div>
          </li>
        ))}
      </ul>
    </section>
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
        ) : <span className="text-slate-500">Pitch not visible in this photo</span>}
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
