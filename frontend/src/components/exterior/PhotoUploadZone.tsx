'use client'

/**
 * Axis Performance — Exterior photo upload zone.
 *
 * Drag-drop or browse-to-select multiple photos. Uploads each photo to
 * Supabase Storage under `exterior-photos/{user_id}/{job_id}/{filename}`,
 * then calls the backend /exterior/v1/photos endpoint so Gemini Vision can
 * classify the elevation and produce qualitative observations.
 *
 * Honest contract:
 *   - Vision classifies the elevation and lists features (siding material
 *     guess, openings visible, photo quality) — for navigation/tagging only.
 *   - No dimensions are derived from the photo at this stage. Measurements
 *     come from contractor traces in MeasurementTraceTool with a scale anchor.
 */
import { useCallback, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { api } from '@/lib/api'

interface Props {
  jobId: string
  userId: string
  onPhotosRegistered: () => void
  maxPhotos?: number
}

interface UploadStatus {
  filename: string
  status: 'queued' | 'uploading' | 'classifying' | 'done' | 'error'
  error?: string
}

const ACCEPTED = 'image/jpeg,image/png,image/webp,image/heic,image/heif'

export function PhotoUploadZone({ jobId, userId, onPhotosRegistered, maxPhotos = 50 }: Props) {
  const [dragOver, setDragOver] = useState(false)
  const [statuses, setStatuses] = useState<UploadStatus[]>([])
  const inputRef = useRef<HTMLInputElement | null>(null)

  const handleFiles = useCallback(async (files: FileList | File[]) => {
    const fileArr = Array.from(files).filter(f => f.type.startsWith('image/'))
    if (fileArr.length === 0) return

    const initial: UploadStatus[] = fileArr.map(f => ({ filename: f.name, status: 'queued' }))
    setStatuses(prev => [...prev, ...initial])

    for (let i = 0; i < fileArr.length; i++) {
      const file = fileArr[i]
      const idx = statuses.length + i

      setStatuses(prev => prev.map((s, j) => j === idx ? { ...s, status: 'uploading' } : s))

      try {
        const ext = (file.name.split('.').pop() || 'jpg').toLowerCase()
        const safeName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
        const storagePath = `${userId}/${jobId}/${safeName}`

        const { error: upErr } = await supabase.storage
          .from('exterior-photos')
          .upload(storagePath, file, {
            cacheControl: '3600',
            upsert: false,
            contentType: file.type || 'image/jpeg',
          })
        if (upErr) throw new Error(upErr.message)

        const { data: pub } = supabase.storage.from('exterior-photos').getPublicUrl(storagePath)
        const photoUrl = pub.publicUrl

        setStatuses(prev => prev.map((s, j) => j === idx ? { ...s, status: 'classifying' } : s))

        const dims = await readImageDims(file).catch(() => ({ width: 0, height: 0 }))
        await api.exterior.registerPhoto({
          job_id: jobId,
          photo_url: photoUrl,
          storage_path: storagePath,
          original_filename: file.name,
          file_size_kb: Math.round(file.size / 1024),
          width_px: dims.width,
          height_px: dims.height,
        })

        setStatuses(prev => prev.map((s, j) => j === idx ? { ...s, status: 'done' } : s))
      } catch (err) {
        setStatuses(prev => prev.map((s, j) => j === idx
          ? { ...s, status: 'error', error: err instanceof Error ? err.message : 'upload failed' }
          : s))
      }
    }
    onPhotosRegistered()
  }, [jobId, userId, statuses.length, onPhotosRegistered])

  const onDrop = useCallback((ev: React.DragEvent) => {
    ev.preventDefault()
    setDragOver(false)
    if (ev.dataTransfer.files.length === 0) return
    void handleFiles(ev.dataTransfer.files)
  }, [handleFiles])

  const onPick = useCallback((ev: React.ChangeEvent<HTMLInputElement>) => {
    if (!ev.target.files) return
    void handleFiles(ev.target.files)
    ev.target.value = ''   // allow re-selecting same files
  }, [handleFiles])

  const activeCount = statuses.filter(s => s.status === 'uploading' || s.status === 'classifying').length

  return (
    <div className="space-y-3">
      <div
        onDragOver={(ev) => { ev.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 text-center transition ${
          dragOver
            ? 'border-blue-400 bg-blue-500/10'
            : 'border-white/15 bg-slate-900/40 hover:border-white/30'
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED}
          multiple
          onChange={onPick}
          className="hidden"
        />
        <div className="text-sm text-slate-200">
          <strong>Drop photos here</strong> or click to browse
        </div>
        <div className="mt-1 text-xs text-slate-500">
          JPEG, PNG, WebP, HEIC. 6 minimum recommended, {maxPhotos} max. Each photo is
          classified by Gemini Vision (elevation + features) — never used to estimate dimensions.
        </div>
      </div>

      {statuses.length > 0 && (
        <ul className="space-y-1 text-xs">
          {statuses.map((s, i) => (
            <li key={i} className="flex items-center justify-between rounded bg-slate-800/40 px-2 py-1">
              <span className="truncate text-slate-300">{s.filename}</span>
              <span className={`ml-2 shrink-0 rounded px-2 py-0.5 text-[10px] ${
                s.status === 'done' ? 'bg-emerald-500/20 text-emerald-300'
                : s.status === 'error' ? 'bg-rose-500/20 text-rose-300'
                : s.status === 'classifying' ? 'bg-amber-500/20 text-amber-300'
                : 'bg-slate-700 text-slate-300'
              }`}>
                {s.status === 'done' ? 'ready'
                  : s.status === 'classifying' ? 'classifying…'
                  : s.status === 'uploading' ? 'uploading…'
                  : s.status === 'error' ? `error: ${s.error}`
                  : 'queued'}
              </span>
            </li>
          ))}
        </ul>
      )}

      {activeCount > 0 && (
        <p className="text-xs text-slate-500">
          {activeCount} photo{activeCount === 1 ? '' : 's'} still processing. Gemini classification takes a few seconds per photo.
        </p>
      )}
    </div>
  )
}

async function readImageDims(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve({ width: img.naturalWidth, height: img.naturalHeight })
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('image decode failed'))
    }
    img.src = url
  })
}

export default PhotoUploadZone
