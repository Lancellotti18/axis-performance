'use client'

/**
 * Hover-inspired guided exterior capture.
 * Walks the contractor through a structured 8-shot capture of a property
 * (front / right / back / left elevations + 4 corner obliques) so the
 * downstream photo analysis has enough coverage to reason about stories,
 * pitch, siding, and damage. Each shot has an overlay with positioning
 * guidance and the completed photos are uploaded as project photos tagged
 * with their role in the filename.
 *
 * This is deliberately phone-first: the "Take Photo" button triggers the
 * native camera via <input capture="environment">, and a cache of taken
 * images is shown as thumbnails so the user can retake any angle.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '@/lib/api'
import type { Photo } from '@/types'

const ANGLE_TAG_PREFIX = 'angle:'

export interface CaptureStep {
  key: string
  title: string
  instruction: string
  framing: string
  emoji: string
}

const STEPS: CaptureStep[] = [
  {
    key: 'front',
    title: 'Front elevation',
    instruction: 'Stand directly in front of the house, back up until the whole facade fits in the frame.',
    framing: 'Keep the roofline near the top of the frame and the ground near the bottom.',
    emoji: '',
  },
  {
    key: 'front_right',
    title: 'Front-right corner',
    instruction: 'Move to the front-right corner of the property at roughly 45°.',
    framing: 'Both the front and right side should be visible in the frame.',
    emoji: '',
  },
  {
    key: 'right',
    title: 'Right elevation',
    instruction: 'Stand directly to the right of the house, perpendicular to the right wall.',
    framing: 'The right side should fill the frame — no angled walls.',
    emoji: '',
  },
  {
    key: 'back_right',
    title: 'Back-right corner',
    instruction: 'Move around to the back-right corner, again at a 45° angle.',
    framing: 'Back wall and right wall both visible.',
    emoji: '',
  },
  {
    key: 'back',
    title: 'Back elevation',
    instruction: 'Stand directly behind the house, perpendicular to the rear wall.',
    framing: 'Keep the entire back wall in frame, horizon level.',
    emoji: '',
  },
  {
    key: 'back_left',
    title: 'Back-left corner',
    instruction: 'Move to the back-left corner at a 45° angle.',
    framing: 'Back wall and left wall both visible.',
    emoji: '',
  },
  {
    key: 'left',
    title: 'Left elevation',
    instruction: 'Stand directly to the left of the house, perpendicular to the left wall.',
    framing: 'Left side fills the frame.',
    emoji: '',
  },
  {
    key: 'front_left',
    title: 'Front-left corner',
    instruction: 'Finish at the front-left corner at a 45° angle.',
    framing: 'Front wall and left wall both visible.',
    emoji: '',
  },
]

type CapturedShot = {
  key: string
  /** New file from camera/upload. Undefined for shots backed by an existing project photo. */
  file?: File
  /** If this slot is filled by a photo already in the project, this is its id. */
  existingPhotoId?: string
  previewUrl: string
  /** True when the shot lives on the backend (existing photo or successful upload). */
  uploaded: boolean
  uploadError?: string | null
  capturedAt: string            // ISO-8601, from Date at pick time
  latitude?: number
  longitude?: number
}

function getAngleFromTags(tags: string[] | null | undefined): string | null {
  if (!tags || tags.length === 0) return null
  const hit = tags.find(t => t.startsWith(ANGLE_TAG_PREFIX))
  return hit ? hit.slice(ANGLE_TAG_PREFIX.length) : null
}

/**
 * Pick photos eligible to feed into the wizard. We include every phase so the
 * contractor can reuse anything they've already uploaded (before/during/after)
 * as reference material for an angle — filtering too aggressively here was
 * leaving the pool empty when users had photos tagged 'during'.
 */
function selectRelevantPhotos(all: Photo[]): Photo[] {
  return all.filter(p => !!p && !!p.url)
}

/** Ask the browser for a single GPS fix. Resolves to null if denied or unavailable. */
function getLocationOnce(): Promise<{ latitude: number; longitude: number } | null> {
  return new Promise(resolve => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      resolve(null)
      return
    }
    const timer = setTimeout(() => resolve(null), 8000)
    navigator.geolocation.getCurrentPosition(
      pos => {
        clearTimeout(timer)
        resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude })
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      },
      { enableHighAccuracy: true, maximumAge: 30_000, timeout: 7000 },
    )
  })
}

export default function ExteriorCaptureWizard({
  projectId,
  onComplete,
  onClose,
  initialPhotos,
}: {
  projectId: string
  onComplete: () => void
  onClose: () => void
  /**
   * Existing project photos. The wizard auto-fills angle slots from any photo
   * tagged `angle:<key>` and shows the rest in a pool so the contractor can
   * tap-to-assign instead of re-taking.
   */
  initialPhotos?: Photo[]
}) {
  const [stepIdx, setStepIdx] = useState(0)
  const [shots, setShots] = useState<Record<string, CapturedShot>>({})
  const [poolPhotos, setPoolPhotos] = useState<Photo[]>([])
  const [uploading, setUploading] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [analysisResult, setAnalysisResult] = useState<any>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const uploadInputRef = useRef<HTMLInputElement>(null)

  const step = STEPS[stepIdx]
  const shot = shots[step.key]
  const completed = STEPS.filter(s => shots[s.key]?.uploaded).length
  const anyCaptured = STEPS.some(s => shots[s.key])
  const allCaptured = STEPS.every(s => shots[s.key])
  const hasNewFiles = useMemo(
    () => STEPS.some(s => !!shots[s.key]?.file && !shots[s.key]?.uploaded),
    [shots],
  )

  const applyPhotoList = (list: Photo[]) => {
    const relevant = selectRelevantPhotos(list)
    const seeded: Record<string, CapturedShot> = {}
    const unassigned: Photo[] = []
    const validKeys = new Set(STEPS.map(s => s.key))
    for (const p of relevant) {
      const angle = getAngleFromTags(p.tags)
      if (angle && validKeys.has(angle) && !seeded[angle]) {
        seeded[angle] = {
          key: angle,
          existingPhotoId: p.id,
          previewUrl: p.url,
          uploaded: true,
          capturedAt: p.captured_at || p.created_at,
          latitude: p.latitude ?? undefined,
          longitude: p.longitude ?? undefined,
        }
      } else {
        unassigned.push(p)
      }
    }
    setShots(seeded)
    setPoolPhotos(unassigned)
  }

  // Seed slots + pool from existing project photos. Photos carrying an
  // `angle:<key>` tag fill the matching slot as already-uploaded; the rest
  // land in the pool so the user can tap to assign them to the current angle.
  //
  // We always refetch on open, even when the parent passes `initialPhotos`:
  // the parent's `photos` state may still be empty while the initial list
  // request is in flight, and the fresh fetch also guarantees any photos
  // tagged/uploaded since the page mounted are included.
  useEffect(() => {
    let cancelled = false
    if (initialPhotos && initialPhotos.length > 0) {
      applyPhotoList(initialPhotos)
    }
    async function refresh() {
      try {
        const list = await api.photos.list(projectId)
        if (cancelled) return
        applyPhotoList(list || [])
      } catch {
        /* keep whatever seed we have */
      }
    }
    refresh()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  // Only revoke blob: URLs we created; existing photos use real HTTP URLs.
  useEffect(() => {
    return () => {
      Object.values(shots).forEach(s => {
        if (s.file && s.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(s.previewUrl)
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setError(null)
    e.target.value = ''
    const capturedAt = new Date().toISOString()
    // Fire-and-await a single GPS fix so the backend can geotag. Silent if denied.
    const geo = await getLocationOnce()
    setShots(prev => {
      const old = prev[step.key]
      if (old?.file && old.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(old.previewUrl)
      return {
        ...prev,
        [step.key]: {
          key: step.key,
          file,
          previewUrl: URL.createObjectURL(file),
          uploaded: false,
          capturedAt,
          latitude: geo?.latitude,
          longitude: geo?.longitude,
        },
      }
    })
  }

  /**
   * Assign a pool photo (existing project photo) to the current angle slot.
   * Persists the `angle:<key>` + `exterior` tags on the backend so the mapping
   * survives across wizard sessions.
   */
  async function assignFromPool(photo: Photo) {
    const targetKey = step.key
    setPoolPhotos(prev => prev.filter(p => p.id !== photo.id))
    setShots(prev => {
      const old = prev[targetKey]
      if (old?.file && old.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(old.previewUrl)
      return {
        ...prev,
        [targetKey]: {
          key: targetKey,
          existingPhotoId: photo.id,
          previewUrl: photo.url,
          uploaded: true,
          capturedAt: photo.captured_at || photo.created_at,
          latitude: photo.latitude ?? undefined,
          longitude: photo.longitude ?? undefined,
        },
      }
    })
    const existingTags = photo.tags || []
    const newTags = Array.from(new Set([
      ...existingTags.filter(t => !t.startsWith(ANGLE_TAG_PREFIX)),
      `${ANGLE_TAG_PREFIX}${targetKey}`,
      'exterior',
    ]))
    try {
      await api.photos.update(projectId, photo.id, { tags: newTags })
    } catch {
      // Assignment still works locally if the tag PATCH fails; it just won't
      // survive a full reload. Stay silent — not worth a user-facing error.
    }
  }

  async function uploadAll() {
    setUploading(true)
    setError(null)
    try {
      for (const s of STEPS) {
        const captured = shots[s.key]
        // Skip slots that are empty or already backed by a saved photo.
        if (!captured || captured.uploaded || !captured.file) continue
        const filename = `exterior_${s.key}_${Date.now()}.jpg`
        const { upload_url, key } = await api.photos.getUploadUrl(
          projectId,
          filename,
          captured.file.type || 'image/jpeg',
        )
        const res = await fetch(upload_url, {
          method: 'PUT',
          body: captured.file,
          headers: { 'Content-Type': captured.file.type || 'image/jpeg' },
        })
        if (!res.ok) throw new Error(`Upload failed for ${s.title}`)
        await api.photos.register(projectId, {
          storage_key: key,
          filename,
          phase: 'before',
          captured_at: captured.capturedAt,
          latitude: captured.latitude,
          longitude: captured.longitude,
          tags: ['exterior', `${ANGLE_TAG_PREFIX}${s.key}`],
        })
        setShots(prev => ({
          ...prev,
          [s.key]: { ...prev[s.key], uploaded: true, uploadError: null },
        }))
      }
    } catch (err: any) {
      setError(err?.message || 'Upload failed. Please retry.')
    }
    setUploading(false)
  }

  async function runAnalysis() {
    setAnalyzing(true)
    setError(null)
    setAnalysisResult(null)
    try {
      // Run measurement + bulk damage tagging in parallel — tagging populates
      // auto_tags.damage so the damage report PDF has something to show without
      // the contractor having to hit "Auto-tag" on each photo.
      const [result] = await Promise.all([
        api.photos.measure(projectId),
        api.photos.autoTagBulk(projectId).catch(() => {
          // Non-blocking — tagging is advisory. The measurement is what the
          // wizard promises. If tagging 503s the user can retry it from the
          // damage-report button later.
          return null
        }),
      ])
      setAnalysisResult(result)
      onComplete()
    } catch (err: any) {
      setError(err?.message || 'Analysis failed. Upload succeeded — you can retry from the Photos tab.')
    }
    setAnalyzing(false)
  }

  async function captureAndAnalyze() {
    await uploadAll()
    if (!error) await runAnalysis()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/70 backdrop-blur-sm p-4">
      <div className="bg-white rounded-3xl shadow-2xl max-w-2xl w-full max-h-[92vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <div>
            <div className="text-xs text-blue-600 font-bold uppercase tracking-wider">Guided Capture</div>
            <div className="text-slate-800 font-black text-lg">Exterior Photo Wizard</div>
          </div>
          <button
            onClick={onClose}
            className="w-9 h-9 rounded-xl bg-slate-100 hover:bg-slate-200 flex items-center justify-center text-slate-500 font-bold"
            aria-label="Close"
          >

          </button>
        </div>

        {/* Progress */}
        <div className="px-6 pt-4">
          <div className="flex items-center gap-2 mb-2">
            <div className="text-xs text-slate-500 font-semibold">
              Step {stepIdx + 1} of {STEPS.length}
            </div>
            <div className="text-xs text-slate-400">·</div>
            <div className="text-xs text-slate-500 font-semibold">
              {Object.keys(shots).length} captured, {completed} uploaded
            </div>
          </div>
          <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-blue-500 to-indigo-500 transition-all"
              style={{ width: `${((stepIdx + (shot ? 1 : 0)) / STEPS.length) * 100}%` }}
            />
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {/* Pool of existing uploaded project photos — tap to assign to current angle. */}
          {poolPhotos.length > 0 && (
            <div className="mb-4 bg-blue-50/70 border border-blue-100 rounded-2xl p-3">
              <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
                <div className="text-[11px] font-bold text-blue-700 uppercase tracking-wide">
                  Your uploaded photos · {poolPhotos.length}
                </div>
                <div className="text-[10px] text-blue-600/90 font-semibold">
                  Tap one to use for &ldquo;{step.title}&rdquo;
                </div>
              </div>
              <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
                {poolPhotos.map(p => {
                  const phaseColors: Record<string, string> = {
                    before: 'bg-blue-500',
                    during: 'bg-amber-500',
                    after: 'bg-emerald-500',
                  }
                  return (
                    <button
                      key={p.id}
                      onClick={() => assignFromPool(p)}
                      className="group relative aspect-square rounded-lg overflow-hidden border border-blue-200 hover:border-blue-500 bg-slate-100 transition-all"
                      title={`Use for ${step.title}`}
                    >
                      <img
                        src={p.url}
                        alt={p.filename || 'project photo'}
                        loading="lazy"
                        className="absolute inset-0 w-full h-full object-cover"
                      />
                      {p.phase && (
                        <span
                          className={`absolute top-1 left-1 text-[8px] font-bold text-white px-1 py-0.5 rounded-full capitalize ${phaseColors[p.phase] || 'bg-slate-500'}`}
                        >
                          {p.phase}
                        </span>
                      )}
                      <div className="absolute inset-0 bg-blue-600/0 group-hover:bg-blue-600/60 transition-all flex items-center justify-center">
                        <span className="text-white text-[10px] font-bold opacity-0 group-hover:opacity-100">
                          Use
                        </span>
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>
          )}
          <div className="flex items-start gap-4 mb-4">
            <div className="w-14 h-14 bg-blue-50 border border-blue-100 rounded-2xl flex items-center justify-center text-3xl flex-shrink-0">
              {step.emoji}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-slate-800 font-bold text-base">{step.title}</div>
              <div className="text-slate-500 text-sm mt-1">{step.instruction}</div>
              <div className="text-xs text-slate-400 mt-1 italic">{step.framing}</div>
            </div>
          </div>

          {/* Preview / placeholder */}
          <div className="relative aspect-[4/3] bg-slate-100 rounded-2xl overflow-hidden border border-slate-200">
            {shot ? (
              <img src={shot.previewUrl} alt={step.title} className="absolute inset-0 w-full h-full object-cover" />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="text-center">
                  <div className="text-5xl mb-2 opacity-40">{step.emoji}</div>
                  <div className="text-slate-400 text-sm">No photo yet</div>
                </div>
              </div>
            )}

            {/* Framing overlay guides */}
            <div className="absolute inset-0 pointer-events-none">
              <div className="absolute top-0 left-0 right-0 h-px bg-white/60" style={{ top: '20%' }} />
              <div className="absolute bottom-0 left-0 right-0 h-px bg-white/60" style={{ bottom: '15%' }} />
              <div className="absolute top-0 bottom-0 w-px bg-white/40" style={{ left: '33.3%' }} />
              <div className="absolute top-0 bottom-0 w-px bg-white/40" style={{ left: '66.6%' }} />
              <div className="absolute top-2 left-3 text-[10px] font-bold text-white/90 bg-slate-900/50 px-2 py-0.5 rounded-full">
                Roofline
              </div>
              <div className="absolute bottom-2 left-3 text-[10px] font-bold text-white/90 bg-slate-900/50 px-2 py-0.5 rounded-full">
                Ground
              </div>
            </div>

            {/* Upload status badge */}
            {shot && (
              <div className="absolute top-3 right-3">
                {shot.uploaded ? (
                  <span className="inline-flex items-center gap-1 text-[11px] font-bold bg-emerald-500 text-white px-2.5 py-1 rounded-full">
                    Uploaded
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-[11px] font-bold bg-amber-500 text-white px-2.5 py-1 rounded-full">
                    Not uploaded
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Capture + upload inputs */}
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={onFilePicked}
            className="hidden"
          />
          <input
            ref={uploadInputRef}
            type="file"
            accept="image/*"
            onChange={onFilePicked}
            className="hidden"
          />
          <div className="grid grid-cols-2 gap-2 mt-4">
            <button
              onClick={() => cameraInputRef.current?.click()}
              className="inline-flex items-center justify-center gap-2 text-white font-bold px-4 py-3 rounded-xl text-sm transition-all hover:scale-[1.01]"
              style={{ background: 'linear-gradient(135deg, #3b82f6, #1d4ed8)', boxShadow: '0 4px 14px rgba(59,130,246,0.3)' }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>
              {shot ? 'Retake photo' : 'Take photo'}
            </button>
            <button
              onClick={() => uploadInputRef.current?.click()}
              className="inline-flex items-center justify-center gap-2 font-bold px-4 py-3 rounded-xl text-sm transition-all hover:scale-[1.01] border"
              style={{ background: '#fff', color: '#1d4ed8', borderColor: '#bfdbfe', boxShadow: '0 2px 8px rgba(59,130,246,0.08)' }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              Upload photo
            </button>
          </div>
          <div className="mt-2 text-[11px] text-slate-400 text-center">
            Use your camera on phone, or upload an existing photo from your device.
          </div>

          {error && (
            <div className="mt-3 bg-red-50 border border-red-200 text-red-600 text-sm rounded-xl px-4 py-3">
              {error}
            </div>
          )}

          {analysisResult && (analysisResult as any).success && (
            <div className="mt-4 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-sm">
              <div className="text-emerald-700 font-bold mb-1">
                {(analysisResult as any).photos_analyzed} photos analyzed
              </div>
              {(analysisResult as any).pitch_estimate && (
                <div className="text-emerald-700">
                  Pitch estimate: <strong>{(analysisResult as any).pitch_estimate}</strong>
                  {' '}(confidence {Math.round(((analysisResult as any).pitch_confidence || 0) * 100)}%)
                </div>
              )}
              {Array.isArray((analysisResult as any).features_detected) && (analysisResult as any).features_detected.length > 0 && (
                <div className="text-emerald-600 text-xs mt-1">
                  Features: {(analysisResult as any).features_detected.join(', ')}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-slate-100 bg-slate-50">
          <button
            onClick={() => setStepIdx(Math.max(0, stepIdx - 1))}
            disabled={stepIdx === 0}
            className="text-sm font-semibold text-slate-500 hover:text-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            ← Back
          </button>

          <div className="flex items-center gap-2">
            {stepIdx < STEPS.length - 1 ? (
              <button
                onClick={() => setStepIdx(stepIdx + 1)}
                disabled={!shot}
                className="inline-flex items-center gap-1.5 text-white font-bold px-4 py-2 rounded-xl text-sm transition-all hover:scale-[1.02] disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ background: 'linear-gradient(135deg, #3b82f6, #1d4ed8)' }}
              >
                Next angle →
              </button>
            ) : (
              <button
                onClick={captureAndAnalyze}
                disabled={!anyCaptured || uploading || analyzing}
                className="inline-flex items-center gap-1.5 text-white font-bold px-5 py-2 rounded-xl text-sm transition-all hover:scale-[1.02] disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ background: 'linear-gradient(135deg, #059669, #047857)' }}
                title={allCaptured ? '' : 'Not all 8 angles are filled — analysis will run with what you have.'}
              >
                {uploading
                  ? 'Uploading…'
                  : analyzing
                  ? 'Analyzing…'
                  : hasNewFiles
                  ? 'Upload & Analyze'
                  : 'Analyze existing photos'}
              </button>
            )}
          </div>
        </div>

        {/* Thumbnails strip */}
        <div className="flex items-center gap-2 px-6 py-3 border-t border-slate-100 overflow-x-auto">
          {STEPS.map((s, i) => {
            const sh = shots[s.key]
            const isCurrent = i === stepIdx
            return (
              <button
                key={s.key}
                onClick={() => setStepIdx(i)}
                className={`flex-shrink-0 w-14 h-14 rounded-xl overflow-hidden border-2 relative transition-all ${
                  isCurrent ? 'border-blue-500 scale-105' : 'border-slate-200 hover:border-slate-300'
                }`}
                title={s.title}
              >
                {sh ? (
                  <>
                    <img src={sh.previewUrl} alt={s.title} className="w-full h-full object-cover" />
                    {sh.uploaded && (
                      <div className="absolute top-0.5 right-0.5 w-4 h-4 bg-emerald-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center">

                      </div>
                    )}
                  </>
                ) : (
                  <div className="w-full h-full bg-slate-100 flex items-center justify-center text-lg opacity-60">
                    {s.emoji}
                  </div>
                )}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
