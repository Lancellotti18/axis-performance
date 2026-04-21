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
import { useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'

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
    emoji: '🏠',
  },
  {
    key: 'front_right',
    title: 'Front-right corner',
    instruction: 'Move to the front-right corner of the property at roughly 45°.',
    framing: 'Both the front and right side should be visible in the frame.',
    emoji: '↗️',
  },
  {
    key: 'right',
    title: 'Right elevation',
    instruction: 'Stand directly to the right of the house, perpendicular to the right wall.',
    framing: 'The right side should fill the frame — no angled walls.',
    emoji: '➡️',
  },
  {
    key: 'back_right',
    title: 'Back-right corner',
    instruction: 'Move around to the back-right corner, again at a 45° angle.',
    framing: 'Back wall and right wall both visible.',
    emoji: '↘️',
  },
  {
    key: 'back',
    title: 'Back elevation',
    instruction: 'Stand directly behind the house, perpendicular to the rear wall.',
    framing: 'Keep the entire back wall in frame, horizon level.',
    emoji: '⬅️',
  },
  {
    key: 'back_left',
    title: 'Back-left corner',
    instruction: 'Move to the back-left corner at a 45° angle.',
    framing: 'Back wall and left wall both visible.',
    emoji: '↙️',
  },
  {
    key: 'left',
    title: 'Left elevation',
    instruction: 'Stand directly to the left of the house, perpendicular to the left wall.',
    framing: 'Left side fills the frame.',
    emoji: '⬆️',
  },
  {
    key: 'front_left',
    title: 'Front-left corner',
    instruction: 'Finish at the front-left corner at a 45° angle.',
    framing: 'Front wall and left wall both visible.',
    emoji: '↖️',
  },
]

type CapturedShot = {
  key: string
  file: File
  previewUrl: string
  uploaded: boolean
  uploadError?: string | null
  capturedAt: string            // ISO-8601, from Date at pick time
  latitude?: number
  longitude?: number
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
}: {
  projectId: string
  onComplete: () => void
  onClose: () => void
}) {
  const [stepIdx, setStepIdx] = useState(0)
  const [shots, setShots] = useState<Record<string, CapturedShot>>({})
  const [uploading, setUploading] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [analysisResult, setAnalysisResult] = useState<any>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const uploadInputRef = useRef<HTMLInputElement>(null)

  const step = STEPS[stepIdx]
  const shot = shots[step.key]
  const completed = STEPS.filter(s => shots[s.key]?.uploaded).length
  const allCaptured = STEPS.every(s => shots[s.key])

  // Clean up object URLs when unmounting to avoid leaks.
  useEffect(() => {
    return () => {
      Object.values(shots).forEach(s => URL.revokeObjectURL(s.previewUrl))
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
      if (old) URL.revokeObjectURL(old.previewUrl)
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

  async function uploadAll() {
    setUploading(true)
    setError(null)
    try {
      for (const s of STEPS) {
        const captured = shots[s.key]
        if (!captured || captured.uploaded) continue
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
          phase: 'during',
          captured_at: captured.capturedAt,
          latitude: captured.latitude,
          longitude: captured.longitude,
          tags: ['exterior', `angle:${s.key}`],
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
      const result = await api.photos.measure(projectId)
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
            ✕
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
                    ✓ Uploaded
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
                ✓ {(analysisResult as any).photos_analyzed} photos analyzed
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
                disabled={!allCaptured || uploading || analyzing}
                className="inline-flex items-center gap-1.5 text-white font-bold px-5 py-2 rounded-xl text-sm transition-all hover:scale-[1.02] disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ background: 'linear-gradient(135deg, #059669, #047857)' }}
              >
                {uploading ? 'Uploading…' : analyzing ? 'Analyzing…' : '✓ Upload & Analyze'}
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
                        ✓
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
