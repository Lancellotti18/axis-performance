'use client'

/**
 * ProjectPhotos — a crew-facing photo gallery for a project.
 *  • Organized by job phase (Before / In-progress / Damage / Completed).
 *  • Each photo takes a caption + non-destructive markup (arrows / circles /
 *    text pins) drawn on an overlay, stored as fractional coords.
 *  • A shareable link lets the crew view the album + markup on their phone,
 *    no login. Exports PhotoMarkup so the public crew page renders identically.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { api, type ProjectPhoto, type PhotoAnnotation } from '@/lib/api'

export const PHASE_ORDER = ['before', 'progress', 'damage', 'completed'] as const
export const PHASE_META: Record<string, { label: string; ring: string; chip: string }> = {
  before:    { label: 'Before',       ring: 'ring-blue-400/30',    chip: 'bg-blue-50 text-blue-900' },
  progress:  { label: 'In-progress',  ring: 'ring-amber-400/30',   chip: 'bg-amber-50 text-amber-900' },
  damage:    { label: 'Damage',       ring: 'ring-rose-400/30',    chip: 'bg-rose-50 text-rose-900' },
  completed: { label: 'Completed',    ring: 'ring-emerald-400/30', chip: 'bg-emerald-50 text-emerald-900' },
}

// iPhone HEIC → JPEG in the browser (native decoder first, heic2any fallback).
async function toUploadable(file: File): Promise<File> {
  const isHeic = /^image\/hei[cf]$/i.test(file.type) || /\.(heic|heif)$/i.test(file.name)
  if (!isHeic) return file
  const name = file.name.replace(/\.(heic|heif)$/i, '.jpg')
  try {
    const url = URL.createObjectURL(file)
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url
    })
    if (img.naturalWidth) {
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight
      c.getContext('2d')!.drawImage(img, 0, 0)
      const blob = await new Promise<Blob | null>(r => c.toBlob(r, 'image/jpeg', 0.9))
      URL.revokeObjectURL(url)
      if (blob) return new File([blob], name, { type: 'image/jpeg' })
    }
  } catch { /* fall through */ }
  const heic2any = (await import('heic2any')).default as (o: { blob: Blob; toType?: string; quality?: number }) => Promise<Blob | Blob[]>
  const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 })
  return new File([Array.isArray(out) ? out[0] : out], name, { type: 'image/jpeg' })
}

/** Read-only markup overlay — used in the editor preview and the crew page.
 *  Shapes/circles live in an SVG (100×100, stretched); text pins are HTML so
 *  they never distort on non-square photos. */
export function PhotoMarkup({ annotations }: { annotations: PhotoAnnotation[] }) {
  return (
    <>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 h-full w-full">
        <defs>
          <marker id="pm-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="#f43f5e" />
          </marker>
        </defs>
        {annotations.map((a, i) => {
          if (a.type === 'arrow') return <line key={i} x1={a.x1 * 100} y1={a.y1 * 100} x2={a.x2 * 100} y2={a.y2 * 100} stroke={a.color || '#f43f5e'} strokeWidth={2.5} vectorEffect="non-scaling-stroke" markerEnd="url(#pm-arrow)" />
          if (a.type === 'circle') return <ellipse key={i} cx={a.cx * 100} cy={a.cy * 100} rx={a.r * 100} ry={a.r * 100} fill="none" stroke={a.color || '#f43f5e'} strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
          return null
        })}
      </svg>
      {annotations.map((a, i) => a.type === 'text' ? (
        <div key={i} className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded bg-rose-600 px-1.5 py-0.5 text-[11px] font-bold text-white shadow"
          style={{ left: `${a.x * 100}%`, top: `${a.y * 100}%` }}>{a.text}</div>
      ) : null)}
    </>
  )
}

type Tool = 'arrow' | 'circle' | 'text'

/** Full-screen editor: draw markup + edit caption/phase, save or delete. */
function PhotoAnnotator({ photo, onClose, onSaved, onDeleted }: {
  photo: ProjectPhoto
  onClose: () => void
  onSaved: (p: ProjectPhoto) => void
  onDeleted: (id: string) => void
}) {
  const [ann, setAnn] = useState<PhotoAnnotation[]>(photo.annotations || [])
  const [caption, setCaption] = useState(photo.caption || '')
  const [phase, setPhase] = useState(photo.phase)
  const [tool, setTool] = useState<Tool>('arrow')
  const [saving, setSaving] = useState(false)
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null)
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  const frac = (e: React.PointerEvent | React.MouseEvent) => {
    const r = boxRef.current!.getBoundingClientRect()
    return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) }
  }

  const onDown = (e: React.PointerEvent) => {
    const p = frac(e)
    if (tool === 'text') {
      const t = window.prompt('Note text (e.g. "replace flashing here")')?.trim()
      if (t) setAnn(a => [...a, { type: 'text', x: p.x, y: p.y, text: t }])
      return
    }
    setDrag(p); setCursor(p)
  }
  const onMove = (e: React.PointerEvent) => { if (drag) setCursor(frac(e)) }
  const onUp = (e: React.PointerEvent) => {
    if (!drag) return
    const p = frac(e)
    if (tool === 'arrow') {
      if (Math.hypot(p.x - drag.x, p.y - drag.y) > 0.01) setAnn(a => [...a, { type: 'arrow', x1: drag.x, y1: drag.y, x2: p.x, y2: p.y }])
    } else if (tool === 'circle') {
      const r = Math.hypot(p.x - drag.x, p.y - drag.y)
      if (r > 0.01) setAnn(a => [...a, { type: 'circle', cx: drag.x, cy: drag.y, r }])
    }
    setDrag(null); setCursor(null)
  }

  const save = async () => {
    setSaving(true)
    try {
      const updated = await api.projectPhotos.update(photo.id, { caption, annotations: ann, phase })
      onSaved(updated); toast.success('Saved'); onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save')
    } finally { setSaving(false) }
  }
  const del = async () => {
    if (!window.confirm('Delete this photo?')) return
    try { await api.projectPhotos.remove(photo.id); onDeleted(photo.id); onClose() }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Could not delete') }
  }

  // Live preview of the shape being dragged.
  const preview: PhotoAnnotation[] = drag && cursor
    ? [tool === 'arrow'
        ? { type: 'arrow', x1: drag.x, y1: drag.y, x2: cursor.x, y2: cursor.y }
        : { type: 'circle', cx: drag.x, cy: drag.y, r: Math.hypot(cursor.x - drag.x, cursor.y - drag.y) }]
    : []

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/90 p-4" onClick={onClose}>
      <div className="mx-auto flex max-h-full w-full max-w-4xl flex-col gap-3" onClick={e => e.stopPropagation()}>
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {(['arrow', 'circle', 'text'] as Tool[]).map(t => (
            <button key={t} onClick={() => setTool(t)}
              className={`rounded-lg px-3 py-1.5 font-semibold capitalize ${tool === t ? 'bg-rose-600 text-white' : 'bg-[#eeeeed] text-[#2d2d2d] hover:bg-white/15'}`}>
              {t === 'arrow' ? '↗ Arrow' : t === 'circle' ? '◯ Circle' : '🅣 Text'}
            </button>
          ))}
          <button onClick={() => setAnn(a => a.slice(0, -1))} disabled={!ann.length}
            className="rounded-lg bg-[#eeeeed] px-3 py-1.5 text-[#2d2d2d] hover:bg-white/15 disabled:opacity-40">Undo</button>
          <button onClick={() => setAnn([])} disabled={!ann.length}
            className="rounded-lg bg-[#eeeeed] px-3 py-1.5 text-[#2d2d2d] hover:bg-white/15 disabled:opacity-40">Clear</button>
          <div className="ml-auto flex items-center gap-2">
            <select value={phase} onChange={e => setPhase(e.target.value)}
              className="rounded-lg border border-[#dededc] bg-[#f8f8f7] px-2 py-1.5 text-[#1a1a1a]">
              {PHASE_ORDER.map(p => <option key={p} value={p}>{PHASE_META[p].label}</option>)}
            </select>
            <button onClick={onClose} className="rounded-lg bg-[#eeeeed] px-3 py-1.5 text-[#2d2d2d] hover:bg-white/15">Close</button>
          </div>
        </div>

        {/* Canvas */}
        <div ref={boxRef} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
          className="relative flex-1 touch-none select-none self-center overflow-hidden rounded-xl bg-[#f8f8f7]"
          style={{ maxHeight: '70vh', cursor: tool === 'text' ? 'copy' : 'crosshair' }}>
          {photo.url
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={photo.url} alt="" draggable={false} className="pointer-events-none block max-h-[70vh] w-auto select-none" />
            : <div className="flex h-64 w-96 items-center justify-center text-[#9ca3af]">image unavailable</div>}
          <PhotoMarkup annotations={[...ann, ...preview]} />
        </div>

        {/* Caption + actions */}
        <div className="flex flex-wrap items-center gap-2">
          <input value={caption} onChange={e => setCaption(e.target.value)} placeholder="Caption / note for the crew…"
            className="min-w-[200px] flex-1 rounded-lg border border-[#dededc] bg-[#f8f8f7] px-3 py-2 text-sm text-[#1a1a1a] placeholder-[#9ca3af] focus:border-blue-400/40 focus:outline-none" />
          <button onClick={del} className="rounded-lg border border-rose-400/30 px-3 py-2 text-sm font-semibold text-rose-800 hover:bg-rose-50">Delete</button>
          <button onClick={save} disabled={saving}
            className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-bold text-white hover:bg-blue-500 disabled:opacity-50">{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  )
}

export default function ProjectPhotos({ projectId }: { projectId: string }) {
  const [photos, setPhotos] = useState<ProjectPhoto[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState<string | null>(null)  // phase currently uploading
  const [editing, setEditing] = useState<ProjectPhoto | null>(null)
  const [shareUrl, setShareUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // Re-fetch the gallery, which mints fresh signed URLs. Also the retry behind
  // an expired-link tile — the photo is fine, only its URL went stale.
  const reload = useCallback(async () => {
    try {
      const r = await api.projectPhotos.list(projectId)
      setPhotos(r.photos)
    } catch { /* the existing tiles stay on screen */ }
  }, [projectId])

  useEffect(() => {
    void reload().finally(() => setLoading(false))
  }, [reload])

  const handleFiles = useCallback(async (phase: string, files: FileList | null) => {
    if (!files?.length) return
    setUploading(phase)
    try {
      for (const f of Array.from(files)) {
        if (!/^image\//.test(f.type) && !/\.(heic|heif)$/i.test(f.name)) continue
        const file = await toUploadable(f)
        const p = await api.projectPhotos.upload(projectId, file, phase)
        setPhotos(prev => [...prev, p])
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Upload failed')
    } finally { setUploading(null) }
  }, [projectId])

  const share = useCallback(async () => {
    try {
      const { token } = await api.projectPhotos.getShare(projectId)
      const url = `${window.location.origin}/crew/${token}`
      setShareUrl(url)
      await navigator.clipboard.writeText(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2500) }).catch(() => {})
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create the crew link')
    }
  }, [projectId])

  if (loading) return <div className="py-16 text-center text-sm text-[#6b7280]">Loading photos…</div>

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-[#1a1a1a]">Project photos</h2>
          <p className="text-sm text-[#6b7280]">Organize job-site photos by phase, mark them up, and share a link your crew can open on their phone.</p>
        </div>
        <div className="flex items-center gap-2">
          {shareUrl && (
            <span className="max-w-[240px] truncate rounded-lg bg-[#f8f8f7] px-2.5 py-1.5 text-[11px] text-[#6b7280]">{shareUrl}</span>
          )}
          <button onClick={share}
            className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500">
            {copied ? '✓ Link copied' : '🔗 Share with crew'}
          </button>
        </div>
      </div>

      {PHASE_ORDER.map(phase => {
        const inPhase = photos.filter(p => p.phase === phase)
        const meta = PHASE_META[phase]
        return (
          <section key={phase} className="rounded-2xl border border-[#dededc] bg-[#f8f8f7] p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide ${meta.chip}`}>{meta.label}</span>
                <span className="text-xs text-[#6b7280]">{inPhase.length} photo{inPhase.length === 1 ? '' : 's'}</span>
              </div>
              <label className="cursor-pointer rounded-lg border border-[#dededc] bg-[#f8f8f7] px-3 py-1.5 text-xs font-semibold text-[#1a1a1a] hover:bg-[#f8f8f7]">
                {uploading === phase ? 'Uploading…' : '+ Add photos'}
                <input type="file" accept="image/*,.heic,.heif,.HEIC,.HEIF" multiple hidden
                  onChange={e => { handleFiles(phase, e.target.files); e.currentTarget.value = '' }} />
              </label>
            </div>
            {inPhase.length === 0 ? (
              <div className="rounded-lg border border-dashed border-[#dededc] py-6 text-center text-xs text-[#9ca3af]">No {meta.label.toLowerCase()} photos yet — add some.</div>
            ) : (
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4">
                {inPhase.map(p => (
                  <button key={p.id} onClick={() => setEditing(p)}
                    className={`group relative aspect-square overflow-hidden rounded-lg bg-[#f8f8f7] ring-1 ${meta.ring} transition-transform hover:scale-[1.02]`}>
                    {p.url
                      // eslint-disable-next-line @next/next/no-img-element
                      ? <img src={p.url} alt={p.caption || ''} loading="lazy" className="h-full w-full object-cover" />
                      // A photo that uploaded fine but couldn't be signed showed
                      // a bare "unavailable" tile with no cause and no way out —
                      // indistinguishable from a lost photo. Say what happened
                      // and offer the retry, since re-signing usually works.
                      : (
                        <div className="flex h-full flex-col items-center justify-center gap-1 px-2 text-center">
                          <span className="text-base leading-none">🔒</span>
                          <span className="text-[9px] leading-tight text-[#6b7280]">Link expired</span>
                          <span onClick={e => { e.stopPropagation(); void reload() }}
                            className="cursor-pointer text-[9px] font-semibold text-blue-400 underline">Refresh</span>
                        </div>
                      )}
                    <PhotoMarkup annotations={p.annotations || []} />
                    {(p.annotations?.length || p.caption) && (
                      <span className="absolute right-1 top-1 rounded bg-black/70 px-1.5 py-0.5 text-[9px] font-semibold text-[#1a1a1a]">✎ marked</span>
                    )}
                    {p.caption && (
                      <div className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/80 to-transparent px-2 pb-1.5 pt-4 text-left text-[10px] text-white">{p.caption}</div>
                    )}
                  </button>
                ))}
              </div>
            )}
          </section>
        )
      })}

      {editing && (
        <PhotoAnnotator photo={editing} onClose={() => setEditing(null)}
          onSaved={u => setPhotos(prev => prev.map(p => p.id === u.id ? u : p))}
          onDeleted={id => setPhotos(prev => prev.filter(p => p.id !== id))} />
      )}
    </div>
  )
}
