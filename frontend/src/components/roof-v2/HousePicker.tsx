'use client'

/**
 * HousePicker — "tap your house" so facet auto-detect locks onto the RIGHT
 * building. Address geocodes are often offset (to the street/parcel), so we let
 * the contractor tap their roof once; the point (image fractions) is saved on
 * the run and the backend anchors its mask/crop on it. One tap, foolproof.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { api, invalidateApiCache } from '@/lib/api'
import { fracToGeo, geoToFrac } from './SolarAssistPanel'

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
  // 'loading' until the lookup answers; a reason string when there's no photo, so
  // a switched-off API is visible instead of silently showing nothing.
  const [svState, setSvState] = useState<'loading' | 'ok' | 'no_coverage' | 'unavailable'>('loading')
  const [svZoom, setSvZoom] = useState(false)

  // Two stages, in the order a person actually identifies a house:
  //   'street'    — recognise it from the road, where houses are recognisable
  //   'satellite' — confirm the building we picked out for you from above
  // Resuming a saved run skips straight to 'satellite'; so does a missing photo,
  // because there is nothing to recognise it from.
  const [stage, setStage] = useState<'street' | 'satellite'>(initialPoint ? 'satellite' : 'street')
  // The building OSM has at this address, as image fractions on the tile.
  const [outline, setOutline] = useState<{ x: number; y: number }[] | null>(null)
  const [autoPicked, setAutoPicked] = useState(false)
  // Set when the user says the street photo is NOT their house: the geocode is
  // wrong, so the footprint at that geocode is wrong too and must not be trusted.
  const [geocodeRejected, setGeocodeRejected] = useState(false)
  const imgRef = useRef<HTMLImageElement>(null)

  // On project resume the saved house point arrives asynchronously (after this
  // panel has already mounted). Sync to it so the previously-confirmed house
  // shows as locked instead of resetting to the tile center.
  useEffect(() => {
    if (initialPoint && typeof initialPoint.x === 'number') {
      setPoint({ x: initialPoint.x, y: initialPoint.y })
      setConfirmed(true)
    }
  }, [initialPoint?.x, initialPoint?.y])   // eslint-disable-line react-hooks/exhaustive-deps

  // Pull a street-level photo of the address so users who don't recognize the
  // house from the top-down view can match it. Best-effort — hidden if missing.
  useEffect(() => {
    // No usable coordinates — there is nothing to look up. Say so instead of
    // leaving the skeleton pulsing forever, which reads as a hung request.
    if (lat == null || lng == null || (lat === 0 && lng === 0)) {
      setSvState('unavailable'); setStage('satellite'); return
    }
    let cancelled = false
    setSvState('loading')
    api.roofing.v2.getStreetView(lat, lng)
      .then(r => {
        if (cancelled) return
        if (r.available && r.image) { setStreetView(r.image); setSvState('ok'); return }
        setStreetView(null)
        setSvState(r.reason === 'no_coverage' ? 'no_coverage' : 'unavailable')
        setStage(st => (st === 'street' ? 'satellite' : st))
      })
      .catch(() => {
        if (cancelled) return
        setStreetView(null); setSvState('unavailable')
        setStage(st => (st === 'street' ? 'satellite' : st))
      })
    return () => { cancelled = true }
  }, [lat, lng])

  // Project the building's OSM outline onto the tile. This is what lets us pick
  // the house out for the user instead of asking them to find it. Needs real tile
  // scale — without feetPerPixel the projection is meaningless, so skip it.
  useEffect(() => {
    if (lat == null || lng == null || !imageWidthPx || !imageHeightPx || !feetPerPixel) return
    let cancelled = false
    api.roofing.v2.getFootprint(runId)
      .then(fp => {
        if (cancelled || !fp.available || !fp.ring?.length) return
        const pts = fp.ring.map(p => {
          const [x, y] = geoToFrac(p.lat, p.lng, lat, lng, imageWidthPx, imageHeightPx, feetPerPixel)
          return { x, y }
        })
        setOutline(pts)
      })
      .catch(() => { /* best-effort — the manual tap still works */ })
    return () => { cancelled = true }
  }, [runId, lat, lng, imageWidthPx, imageHeightPx, feetPerPixel])

  // Drop the marker in the middle of that building once we have it — but never
  // over a point the user placed themselves, and never when they've told us the
  // address is wrong.
  useEffect(() => {
    if (!outline || autoPicked || confirmed || geocodeRejected) return
    const cx = outline.reduce((a, p) => a + p.x, 0) / outline.length
    const cy = outline.reduce((a, p) => a + p.y, 0) / outline.length
    setPoint({ x: cx, y: cy })
    setAutoPicked(true)
  }, [outline, autoPicked, confirmed, geocodeRejected])

  const place = useCallback((clientX: number, clientY: number) => {
    const el = imgRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const x = Math.max(0, Math.min(1, (clientX - r.left) / r.width))
    const y = Math.max(0, Math.min(1, (clientY - r.top) / r.height))
    setPoint({ x, y })
    setConfirmed(false)
    setAutoPicked(false)      // their tap wins over our guess
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
      // The anchor changed → cached Solar/footprint responses (which may hold
      // the WRONG building) must never be served again for this run.
      invalidateApiCache('/solar')
      invalidateApiCache('/footprint')
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
          <h3 className="text-sm font-semibold text-emerald-900">
            {stage === 'street' ? '🏠 Is this the house?' : '📍 Confirm the roof'}
          </h3>
          <p className="text-xs text-[#6b7280]">
            {stage === 'street'
              ? 'Houses are far easier to recognise from the road than from above. Check this is the right one, and we\u2019ll pick it out on the satellite for you.'
              : autoPicked
                ? 'We found this building at the address and highlighted it. Check the outline sits on YOUR roof \u2014 tap elsewhere if it\u2019s wrong.'
                : 'Tap the center of YOUR roof so auto-detect locks onto the right building \u2014 not a neighbor or a shed.'}
          </p>
          {address && (
            <p className="mt-1 text-[11px] text-emerald-900/80">
              Property: <span className="font-medium text-emerald-900">{address}</span>
            </p>
          )}
        </div>
        {confirmed && (
          <span className="shrink-0 rounded-full bg-emerald-500/20 px-2.5 py-1 text-[10px] font-semibold text-emerald-800">
            Locked ✓
          </span>
        )}
      </div>

      {/* The street photo. In stage 1 it is the subject of the question, so it
          gets the full width; afterwards it stays as a small reference. */}
      {streetView && (
        <div className="mt-3 rounded-lg border border-[#dededc] bg-[#f8f8f7] p-2.5">
          <div className={stage === 'street' ? '' : 'flex gap-3'}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={streetView}
              alt="Street view of the address"
              onClick={() => setSvZoom(true)}
              className={stage === 'street'
                ? 'w-full cursor-zoom-in rounded-md border border-[#dededc] object-cover transition hover:brightness-95'
                : 'h-28 w-44 shrink-0 cursor-zoom-in rounded-md border border-[#dededc] object-cover transition hover:brightness-95'}
              draggable={false}
            />
            {stage === 'street' ? (
              <div className="mt-2.5">
                <p className="text-[11px] leading-relaxed text-[#6b7280]">
                  This is <span className="font-medium text-[#1a1a1a]">{address || 'the address'}</span> from
                  the street. Click the photo to enlarge it.
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setStage('satellite')}
                    className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500"
                  >
                    Yes — that&apos;s the house
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      // The photo is of the geocoded address. If that's the wrong
                      // house, the geocode is wrong, so the footprint sitting at
                      // that same geocode is wrong too — drop it rather than
                      // highlight a building we now know we can't trust.
                      setGeocodeRejected(true)
                      setOutline(null)
                      setAutoPicked(false)
                      setStage('satellite')
                    }}
                    className="rounded-md border border-[#dededc] bg-white px-4 py-2 text-sm font-medium text-[#1a1a1a] hover:bg-[#f2f2f0]"
                  >
                    No — that&apos;s not it
                  </button>
                </div>
              </div>
            ) : (
              <div className="text-[11px] leading-relaxed text-[#6b7280]">
                <span className="font-semibold text-[#1a1a1a]">Street reference.</span>{' '}
                The same house, from the road. Click to enlarge.
                <button
                  type="button"
                  onClick={() => setStage('street')}
                  className="mt-1.5 block rounded border border-[#dededc] bg-white px-2 py-1 text-[11px] font-medium text-[#1a1a1a] hover:bg-[#f2f2f0]"
                >
                  Not the right house?
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {svState === 'loading' && (
        <div className="mt-3 flex items-center gap-3 rounded-lg border border-[#dededc] bg-[#f8f8f7] p-2.5">
          <div className="h-36 w-56 shrink-0 animate-pulse rounded-md bg-[#e8e8e6]" />
          <p className="text-[11px] text-[#6b7280]">Loading a street-level photo of this address…</p>
        </div>
      )}

      {/* Say why there's no photo. Silence here is what let a disabled Street View
          API go unnoticed, and it leaves the user wondering what they missed. */}
      {(svState === 'no_coverage' || svState === 'unavailable') && (
        <div className="mt-3 rounded-lg border border-[#dededc] bg-[#f8f8f7] px-3 py-2 text-[11px] text-[#6b7280]">
          {svState === 'no_coverage'
            ? 'No street-level photo exists for this address — Google has no coverage on this road. Use the satellite image below.'
            : "Street-level photo isn't available right now. Use the satellite image below."}
        </div>
      )}

      {svZoom && streetView && (
        <div
          role="dialog"
          aria-label="Street view photo"
          onClick={() => setSvZoom(false)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={streetView} alt="Street view of the address, enlarged"
               className="max-h-full max-w-full rounded-lg shadow-2xl" draggable={false} />
          <button
            type="button"
            onClick={() => setSvZoom(false)}
            className="absolute right-4 top-4 rounded-md bg-white px-3 py-1.5 text-sm font-medium text-[#1a1a1a]"
          >
            Close
          </button>
        </div>
      )}

      {stage === 'satellite' && geocodeRejected && (
        <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
          <span className="font-semibold">The address may be off.</span> Since the street photo isn&apos;t
          your house, we haven&apos;t guessed a building — find your roof on the satellite below and tap it.
          Everything downstream measures the roof you tap, so this is the one thing worth getting right.
        </div>
      )}

      <div className={`mt-3 overflow-hidden rounded-lg border border-[#dededc] bg-black ${stage === 'street' ? 'hidden' : ''}`}>
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
          {/* The building we picked out, drawn over the tile. This is what turns
              "find your house among six rooftops" into a yes/no. It is drawn
              under the marker and never intercepts taps. */}
          {outline && outline.length > 2 && (
            <svg
              className="pointer-events-none absolute inset-0 h-full w-full"
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <polygon
                points={outline.map(p => `${p.x * 100},${p.y * 100}`).join(' ')}
                fill="rgba(16,185,129,0.22)"
                stroke="rgb(16,185,129)"
                strokeWidth="0.5"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          )}
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

      {stage === 'satellite' && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            onClick={confirm}
            disabled={saving}
            className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
          >
            {saving ? 'Saving…' : confirmed ? 'Saved ✓ — re-tap to change' : 'Confirm this is my roof'}
          </button>
          <span className="text-[11px] text-[#6b7280]">
            {confirmed
              ? 'Locked in. Now run Auto-detect below.'
              : autoPicked
                ? 'Check the highlight is on your roof, then confirm.'
                : 'Tap the roof, then confirm — takes 2 seconds.'}
          </span>
        </div>
      )}
    </section>
  )
}
