'use client'

/**
 * HousePicker — "tap your house" so facet auto-detect locks onto the RIGHT
 * building. Address geocodes are often offset (to the street/parcel), so we let
 * the contractor tap their roof once; the point (image fractions) is saved on
 * the run and the backend anchors its mask/crop on it. One tap, foolproof.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { api } from '@/lib/api'
import { fracToGeo } from './SolarAssistPanel'

interface Props {
  runId: string
  imageUrl: string
  /** Address coords — used to pull a Street View reference photo. */
  lat?: number
  lng?: number
  /** Formatted address, shown so the user knows which property this is. */
  address?: string
  /** Tile meta — lets the tap be converted to lat/lng so Solar/footprint
   *  lookups anchor on the RIGHT building, not the geocode. */
  imageWidthPx?: number
  imageHeightPx?: number
  feetPerPixel?: number
  initialPoint?: { x: number; y: number } | null
  onConfirmed?: (p: { x: number; y: number }) => void
}

export default function HousePicker({
  runId, imageUrl, lat, lng, address,
  imageWidthPx, imageHeightPx, feetPerPixel,
  initialPoint, onConfirmed,
}: Props) {
  const [point, setPoint] = useState<{ x: number; y: number }>(initialPoint ?? { x: 0.5, y: 0.5 })
  const [confirmed, setConfirmed] = useState<boolean>(!!initialPoint)
  const [saving, setSaving] = useState(false)
  const [streetView, setStreetView] = useState<string | null>(null)
  const imgRef = useRef<HTMLImageElement>(null)

  // Pull a street-level photo of the address so users who don't recognize the
  // house from the top-down view can match it. Best-effort — hidden if missing.
  useEffect(() => {
    if (lat == null || lng == null || (lat === 0 && lng === 0)) return
    let cancelled = false
    api.roofing.v2.getStreetView(lat, lng)
      .then(r => { if (!cancelled && r.available && r.image) setStreetView(r.image) })
      .catch(() => { /* best-effort */ })
    return () => { cancelled = true }
  }, [lat, lng])

  const place = useCallback((clientX: number, clientY: number) => {
    const el = imgRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const x = Math.max(0, Math.min(1, (clientX - r.left) / r.width))
    const y = Math.max(0, Math.min(1, (clientY - r.top) / r.height))
    setPoint({ x, y })
    setConfirmed(false)
  }, [])

  const confirm = useCallback(async () => {
    setSaving(true)
    try {
      // Convert the tap to lat/lng when we have the tile meta — this anchors
      // Google Solar + footprint lookups on the tapped house instead of the
      // (often off-target) geocode.
      let geo: { lat: number; lng: number } | undefined
      if (lat != null && lng != null && imageWidthPx && imageHeightPx && feetPerPixel) {
        geo = fracToGeo(point.x, point.y, lat, lng, imageWidthPx, imageHeightPx, feetPerPixel)
      }
      await api.roofing.v2.setSubjectPoint(runId, point.x, point.y, geo?.lat, geo?.lng)
      setConfirmed(true)
      onConfirmed?.(point)
      toast.success('Locked onto your house — auto-detect + Solar will use this spot')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save the location')
    } finally {
      setSaving(false)
    }
  }, [runId, point, lat, lng, imageWidthPx, imageHeightPx, feetPerPixel, onConfirmed])

  if (!imageUrl) return null

  return (
    <section className="rounded-lg border border-emerald-400/30 bg-emerald-500/[0.07] p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-emerald-100">📍 Tap your house</h3>
          <p className="text-xs text-slate-400">
            Tap the <strong>center of YOUR roof</strong> so auto-detect locks onto the right building —
            not a neighbor or a shed. The marker starts on the address; re-tap to adjust.
          </p>
          {address && (
            <p className="mt-1 text-[11px] text-emerald-200/80">
              Property: <span className="font-medium text-emerald-100">{address}</span>
            </p>
          )}
        </div>
        {confirmed && (
          <span className="shrink-0 rounded-full bg-emerald-500/20 px-2.5 py-1 text-[10px] font-semibold text-emerald-300">
            Locked ✓
          </span>
        )}
      </div>

      {/* Street-level reference: the view people actually recognize. Find THIS
          house on the satellite below, then tap its roof. */}
      {streetView && (
        <div className="mt-3 flex gap-3 rounded-lg border border-white/10 bg-slate-900/50 p-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={streetView}
            alt="Street view of the address"
            className="h-24 w-36 shrink-0 rounded-md border border-white/10 object-cover"
            draggable={false}
          />
          <div className="text-[11px] leading-relaxed text-slate-400">
            <span className="font-semibold text-slate-200">Don&apos;t recognize it from above?</span>{' '}
            This is the address from the street. Find <em>this same house</em> on the satellite
            image below — it&apos;s the building at the center — and tap its roof.
          </div>
        </div>
      )}

      <div className="mt-3 overflow-hidden rounded-lg border border-white/10 bg-black">
        <div className="relative">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            ref={imgRef}
            src={imageUrl}
            alt="satellite tile — tap your house"
            draggable={false}
            onClick={e => place(e.clientX, e.clientY)}
            className="block w-full cursor-crosshair select-none"
          />
          {/* Pulsing marker at the chosen point */}
          <div
            className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
          >
            <span className="absolute inset-0 -m-3 block animate-ping rounded-full bg-emerald-400/40" style={{ width: 24, height: 24 }} />
            <span className="relative block h-4 w-4 rounded-full border-2 border-white bg-emerald-500 shadow-lg ring-4 ring-emerald-400/30" />
          </div>
          {/* subtle crosshair guides */}
          <div className="pointer-events-none absolute inset-x-0" style={{ top: `${point.y * 100}%` }}>
            <div className="h-px w-full bg-emerald-300/20" />
          </div>
          <div className="pointer-events-none absolute inset-y-0" style={{ left: `${point.x * 100}%` }}>
            <div className="h-full w-px bg-emerald-300/20" />
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          onClick={confirm}
          disabled={saving}
          className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
        >
          {saving ? 'Saving…' : confirmed ? 'Saved ✓ — re-tap to change' : 'Confirm this is my house'}
        </button>
        <span className="text-[11px] text-slate-500">
          {confirmed ? 'Locked in. Now run Auto-detect below.' : 'Tap the roof, then confirm — takes 2 seconds.'}
        </span>
      </div>
    </section>
  )
}
