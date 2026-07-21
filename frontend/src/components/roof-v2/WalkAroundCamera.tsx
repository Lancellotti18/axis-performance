'use client'

/**
 * WalkAroundCamera — a live in-app camera for the ground-photo walk-around.
 * Opens the device camera (rear on phones), shows a live preview, and lets the
 * contractor shoot photo after photo as they circle the house, tagging each to
 * a slot without leaving the camera. Falls back gracefully if the browser
 * blocks or lacks camera access.
 */
import { useEffect, useRef, useState } from 'react'

interface SlotOpt { key: string; label: string }

export default function WalkAroundCamera({
  slots, initialSlot, onCapture, onClose,
}: {
  slots: SlotOpt[]
  initialSlot: string
  onCapture: (file: File, slot: string) => void
  onClose: () => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [slot, setSlot] = useState(initialSlot)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [shotCount, setShotCount] = useState<Record<string, number>>({})
  const [lastShot, setLastShot] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('This browser can’t open the camera here. Use the Upload button, or open Axis in Safari/Chrome.')
        return
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } }, audio: false,
        }).catch(() => navigator.mediaDevices.getUserMedia({ video: true, audio: false }))
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return }
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play().catch(() => {})
        }
        setReady(true)
      } catch {
        setError('Camera access was blocked. Allow the camera in your browser settings, or use Upload instead.')
      }
    }
    start()
    return () => {
      cancelled = true
      streamRef.current?.getTracks().forEach(t => t.stop())
      streamRef.current = null
    }
  }, [])

  function shoot() {
    const video = videoRef.current
    if (!video || !video.videoWidth) return
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(video, 0, 0)
    canvas.toBlob(blob => {
      if (!blob) return
      const file = new File([blob], `${slot}-${Date.now()}.jpg`, { type: 'image/jpeg' })
      onCapture(file, slot)
      setShotCount(c => ({ ...c, [slot]: (c[slot] || 0) + 1 }))
      setLastShot(URL.createObjectURL(blob))
    }, 'image/jpeg', 0.9)
  }

  const total = Object.values(shotCount).reduce((a, b) => a + b, 0)

  return (
    <div className="fixed inset-0 z-[100] flex flex-col bg-black">
      {/* Live preview */}
      <div className="relative flex-1 overflow-hidden">
        <video ref={videoRef} playsInline muted className="h-full w-full object-cover" />
        {!ready && !error && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-white/70">Opening camera…</div>
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center p-8 text-center text-sm text-white/80">{error}</div>
        )}

        {/* Top bar: slot picker + close */}
        <div className="absolute inset-x-0 top-0 flex items-start justify-between gap-3 bg-gradient-to-b from-black/70 to-transparent p-3">
          <div className="flex flex-wrap gap-1.5">
            {slots.map(s => (
              <button key={s.key} onClick={() => setSlot(s.key)}
                className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${slot === s.key ? 'bg-white text-slate-900' : 'bg-white/15 text-white/90 hover:bg-white/25'}`}>
                {s.label}{shotCount[s.key] ? ` · ${shotCount[s.key]}` : ''}
              </button>
            ))}
          </div>
          <button onClick={onClose} aria-label="Close camera"
            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-white/15 text-white hover:bg-white/25">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>

        {/* Currently-shooting label */}
        {ready && (
          <div className="absolute inset-x-0 bottom-24 text-center text-xs font-medium text-white/90">
            Shooting: <span className="font-bold">{slots.find(s => s.key === slot)?.label}</span> — tap the shutter, then walk to the next spot
          </div>
        )}
      </div>

      {/* Shutter bar */}
      <div className="flex items-center justify-between gap-4 bg-black px-6 py-4">
        <div className="h-12 w-12 overflow-hidden rounded-lg border border-white/20 bg-white/5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {lastShot && <img src={lastShot} alt="Last shot" className="h-full w-full object-cover" />}
        </div>
        <button onClick={shoot} disabled={!ready} aria-label="Take photo"
          className="flex h-16 w-16 items-center justify-center rounded-full border-4 border-white bg-white/90 transition active:scale-95 disabled:opacity-40">
          <span className="h-12 w-12 rounded-full bg-white" />
        </button>
        <button onClick={onClose}
          className="min-w-[3rem] text-sm font-semibold text-white/90">
          Done{total ? ` (${total})` : ''}
        </button>
      </div>
    </div>
  )
}
