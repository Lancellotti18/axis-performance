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

interface SvMeta {
  aimedAt?: 'building' | 'nearest building' | 'address'
  date?: string
  distanceM?: number
  far?: boolean
  panoUrl?: string
}

/** "2019-05" -> "May 2019", plus how many years old that is. */
function photoAge(date?: string): { label: string; years: number } | null {
  const m = date?.match(/^(\d{4})-(\d{2})/)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, 1)
  const years = (Date.now() - d.getTime()) / (365.25 * 24 * 3600 * 1000)
  return { label: d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }), years }
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
  // How far to trust the photo. A street photo is a claim about which house is
  // at this address, and a wrong one sends a roofer to the neighbour's door.
  const [svMeta, setSvMeta] = useState<SvMeta>({})
  // The camera behind the photo. Turning it asks for a new image from the same
  // panorama, and a click on the photo becomes a compass bearing from it.
  const [svCam, setSvCam] = useState<{ pano: string; lat: number; lng: number; heading: number; fov: number } | null>(null)
  const [svTurning, setSvTurning] = useState(false)
  // Where they clicked on the street photo, as fractions of the image.
  const [svClick, setSvClick] = useState<{ x: number; y: number } | null>(null)
  const [svPick, setSvPick] = useState<'idle' | 'locating' | 'miss' | 'failed' | 'off_tile'>('idle')
  // Set once the building came from a street-view click. From then on the
  // address lookup must never overwrite it: the user has told us which house.
  const pickedFromStreet = useRef(false)
  const [streetPicked, setStreetPicked] = useState(false)

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
  // Why there is (or isn't) a highlighted building. Silence here is precisely
  // what made a missing highlight look like a mis-placed one.
  const [fpState, setFpState] = useState<'off' | 'loading' | 'found' | 'guess' | 'none' | 'error'>('loading')
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
        if (r.available && r.image) {
          setStreetView(r.image)
          setSvMeta({ aimedAt: r.aimed_at, date: r.date, distanceM: r.distance_m, far: r.far, panoUrl: r.pano_url })
          if (r.pano_id && r.camera && r.heading != null) {
            setSvCam({ pano: r.pano_id, lat: r.camera.lat, lng: r.camera.lng, heading: r.heading, fov: r.fov ?? 75 })
          }
          setSvState('ok'); return
        }
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
    if (lat == null || lng == null || !imageWidthPx || !imageHeightPx || !feetPerPixel) {
      setFpState('off'); return
    }
    let cancelled = false
    setFpState('loading')
    api.roofing.v2.getFootprint(runId)
      .then(fp => {
        if (cancelled || pickedFromStreet.current) return
        if (!fp.available || !fp.ring?.length) { setFpState('none'); return }
        const pts = fp.ring.map(p => {
          const [x, y] = geoToFrac(p.lat, p.lng, lat, lng, imageWidthPx, imageHeightPx, feetPerPixel)
          return { x, y }
        })
        setOutline(pts)
        // A 'nearest' match means the address landed outside every building, so
        // this is the closest neighbour rather than a known answer. Show it, but
        // never let it masquerade as a confident pick.
        setFpState(fp.confident ? 'found' : 'guess')
      })
      .catch(() => { if (!cancelled && !pickedFromStreet.current) setFpState('error') })
    return () => { cancelled = true }
  }, [runId, lat, lng, imageWidthPx, imageHeightPx, feetPerPixel])

  // Look around from the same camera: a turn or a zoom is a new image from the
  // same panorama, so the click-to-bearing maths keeps working.
  const look = useCallback(async (dHeading: number, fovScale: number) => {
    if (!svCam || svTurning) return
    const heading = (svCam.heading + dHeading + 360) % 360
    const fov = Math.max(25, Math.min(100, svCam.fov * fovScale))
    setSvTurning(true)
    try {
      const r = await api.roofing.v2.getStreetViewLook(svCam.pano, heading, fov)
      if (r.available && r.image) {
        setStreetView(r.image)
        setSvCam({ ...svCam, heading, fov })
        setSvClick(null); setSvPick('idle')
      } else {
        toast.error('Couldn\u2019t turn the camera, try again')
      }
    } catch {
      toast.error('Couldn\u2019t turn the camera, try again')
    } finally {
      setSvTurning(false)
    }
  }, [svCam, svTurning])

  // They clicked the house in the street photo. The click's horizontal position
  // gives the bearing from the camera (a rectilinear photo: offset = atan of the
  // position times tan of half the field of view), and the house is the first
  // building outline that bearing runs into. That outline is then highlighted on
  // the satellite, so the house recognised from the road is the roof measured.
  const pickFromStreet = useCallback(async (clientX: number, clientY: number, el: HTMLImageElement) => {
    if (!svCam || svPick === 'locating') return
    const r = el.getBoundingClientRect()
    const fx = Math.max(0, Math.min(1, (clientX - r.left) / r.width))
    const fy = Math.max(0, Math.min(1, (clientY - r.top) / r.height))
    setSvClick({ x: fx, y: fy })
    const half = (svCam.fov * Math.PI) / 360
    const offset = (Math.atan((fx - 0.5) * 2 * Math.tan(half)) * 180) / Math.PI
    const bearing = (svCam.heading + offset + 360) % 360
    setSvPick('locating')
    try {
      const res = await api.roofing.v2.locateFromStreetView(svCam.lat, svCam.lng, bearing)
      if (!res.found || !res.ring?.length || !res.centroid) {
        setSvPick(res.reason === 'lookup_failed' ? 'failed' : 'miss'); return
      }
      if (lat == null || lng == null || !imageWidthPx || !imageHeightPx || !feetPerPixel) {
        setSvPick('failed'); return
      }
      const [cx, cy] = geoToFrac(res.centroid.lat, res.centroid.lng, lat, lng, imageWidthPx, imageHeightPx, feetPerPixel)
      // geoToFrac clamps to the tile, so a centroid pinned to an edge means the
      // house is outside this satellite image. Highlighting a clamped outline
      // would point at the wrong roof.
      if (cx <= 0.001 || cx >= 0.999 || cy <= 0.001 || cy >= 0.999) { setSvPick('off_tile'); return }
      pickedFromStreet.current = true
      setStreetPicked(true)
      setOutline(res.ring.map(p => {
        const [x, y] = geoToFrac(p.lat, p.lng, lat, lng, imageWidthPx, imageHeightPx, feetPerPixel)
        return { x, y }
      }))
      setFpState('found')
      setGeocodeRejected(false)
      setPoint({ x: cx, y: cy })
      setAutoPicked(true)
      setConfirmed(false)
      setSvPick('idle')
      setStage('satellite')
    } catch {
      setSvPick('failed')
    }
  }, [svCam, svPick, lat, lng, imageWidthPx, imageHeightPx, feetPerPixel])

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

  // The marker means something only when we picked a building out or the user
  // tapped. At (0.5, 0.5) with neither, it is a default, not a selection.
  const userTapped = point.x !== 0.5 || point.y !== 0.5
  const placed = autoPicked || confirmed || userTapped

  const age = photoAge(svMeta.date)
  // Turn by most of the current view, so a zoomed-in photo can't turn straight
  // past the house and a wide one doesn't take six clicks to look behind you.
  const turnStep = svCam ? Math.round(svCam.fov * 0.75) : 45
  // Each of these is a concrete reason the photo may show the wrong house.
  const svDoubts: string[] = []
  if (svMeta.far) svDoubts.push(`It was taken ${svMeta.distanceM} m away, which usually means a different street or an alley, so it may show another house.`)
  if (svMeta.aimedAt === 'nearest building') svDoubts.push('The address didn\u2019t land on a mapped building, so the camera is pointed at the closest one.')
  if (svMeta.aimedAt === 'address') svDoubts.push('No building outline is mapped here, so the camera is aimed at the raw address point.')
  if (age && age.years >= 5) svDoubts.push(`The photo is from ${age.label}. The house may have changed since.`)

  if (!imageUrl) return null

  return (
    <section className="rounded-lg border border-emerald-400/30 bg-emerald-500/[0.07] p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-emerald-900">
            {stage === 'street' ? (svCam ? '🏠 Click the house in the street photo' : '🏠 Is this the house?') : '📍 Confirm the roof'}
          </h3>
          <p className="text-xs text-[#6b7280]">
            {stage === 'street'
              ? 'Houses are far easier to recognise from the road than from above. Find the house in the photo, turning the camera if you need to, and click it. We\u2019ll highlight that same building on the satellite.'
              : autoPicked
                ? streetPicked
                  ? 'This is the building you clicked in the street photo. Check the outline sits on YOUR roof, then confirm. Tap elsewhere if it\u2019s wrong.'
                  : (fpState === 'guess'
                    ? 'This is our best guess at the building \u2014 check the outline is on YOUR roof before confirming.'
                    : 'We found this building at the address and highlighted it. Check the outline sits on YOUR roof \u2014 tap elsewhere if it\u2019s wrong.')
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
      {/* Once they've said the photo is NOT their house, it must not linger as a
          "reference" — that is how the wrong house ends up in someone's head. */}
      {streetView && !(stage === 'satellite' && geocodeRejected) && (
        <div className="mt-3 rounded-lg border border-[#dededc] bg-[#f8f8f7] p-2.5">
          <div className={stage === 'street' ? '' : 'flex gap-3'}>
            <div className={stage === 'street' ? 'relative' : 'relative shrink-0'}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={streetView}
                alt="Street view of the address"
                onClick={e => {
                  // In the street stage a click picks the house. Without camera
                  // details (an older cached photo) it can only be enlarged.
                  if (stage === 'street' && svCam) pickFromStreet(e.clientX, e.clientY, e.currentTarget)
                  else setSvZoom(true)
                }}
                className={stage === 'street'
                  ? `w-full rounded-md border border-[#dededc] object-cover transition ${svCam ? 'cursor-crosshair' : 'cursor-zoom-in hover:brightness-95'} ${svTurning ? 'opacity-60' : ''}`
                  : 'h-28 w-44 cursor-zoom-in rounded-md border border-[#dededc] object-cover transition hover:brightness-95'}
                draggable={false}
              />
              {svClick && (
                <span
                  className="pointer-events-none absolute block h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-emerald-500 shadow-lg ring-4 ring-emerald-400/40"
                  style={{ left: `${svClick.x * 100}%`, top: `${svClick.y * 100}%` }}
                />
              )}
              {stage === 'street' && svPick === 'locating' && (
                <div className="pointer-events-none absolute inset-x-0 bottom-2 mx-auto w-fit rounded-full bg-black/70 px-3 py-1 text-[11px] font-medium text-white">
                  Finding that building…
                </div>
              )}
            </div>
            {stage === 'street' ? (
              <div className="mt-2.5">
                {svCam && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button type="button" onClick={() => look(-turnStep, 1)} disabled={svTurning}
                      className="rounded-md border border-[#dededc] bg-white px-2.5 py-1.5 text-[12px] font-medium text-[#1a1a1a] hover:bg-[#f2f2f0] disabled:opacity-50">
                      ◀ Look left
                    </button>
                    <button type="button" onClick={() => look(turnStep, 1)} disabled={svTurning}
                      className="rounded-md border border-[#dededc] bg-white px-2.5 py-1.5 text-[12px] font-medium text-[#1a1a1a] hover:bg-[#f2f2f0] disabled:opacity-50">
                      Look right ▶
                    </button>
                    <button type="button" onClick={() => look(0, 0.6)} disabled={svTurning || svCam.fov <= 26}
                      className="rounded-md border border-[#dededc] bg-white px-2.5 py-1.5 text-[12px] font-medium text-[#1a1a1a] hover:bg-[#f2f2f0] disabled:opacity-50">
                      ＋ Zoom in
                    </button>
                    <button type="button" onClick={() => look(0, 1 / 0.6)} disabled={svTurning || svCam.fov >= 99}
                      className="rounded-md border border-[#dededc] bg-white px-2.5 py-1.5 text-[12px] font-medium text-[#1a1a1a] hover:bg-[#f2f2f0] disabled:opacity-50">
                      − Zoom out
                    </button>
                    <button type="button" onClick={() => setSvZoom(true)}
                      className="ml-auto text-[11px] text-[#6b7280] underline decoration-dotted hover:text-[#1a1a1a]">
                      Enlarge
                    </button>
                  </div>
                )}
                {svPick === 'miss' && (
                  <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-900">
                    No mapped building lies in that direction. Click the middle of the house itself,
                    not the yard or the sky above it, or find the roof on the satellite instead.
                  </div>
                )}
                {svPick === 'off_tile' && (
                  <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-900">
                    That building is outside this satellite image, so it isn&apos;t the address on this
                    project. If it really is the house, the project&apos;s address needs correcting.
                  </div>
                )}
                {svPick === 'failed' && (
                  <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-900">
                    We couldn&apos;t look up the buildings here just now. Try clicking again, or find
                    the roof on the satellite instead.
                  </div>
                )}
                <p className="mt-2 text-[11px] leading-relaxed text-[#6b7280]">
                  Google&apos;s street photo closest to{' '}
                  <span className="font-medium text-[#1a1a1a]">{address || 'the address'}</span>
                  {age && <> · taken {age.label}</>}
                  {svMeta.distanceM != null && <> · ~{svMeta.distanceM} m from the house</>}.
                  Check the house number or a feature you know before you click.
                </p>
                {svDoubts.length > 0 && (
                  <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-900">
                    <span className="font-semibold">Look closely at this one.</span>
                    <ul className="mt-0.5 list-disc pl-4">
                      {svDoubts.map(d => <li key={d}>{d}</li>)}
                    </ul>
                  </div>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
                  {!svCam && (
                    // No camera details (a photo cached before click-to-pick
                    // shipped), so the photo can't be clicked: keep the old yes.
                    <button
                      type="button"
                      onClick={() => setStage('satellite')}
                      className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500"
                    >
                      Yes, that&apos;s the house
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      // Not visible from this camera means the address point is
                      // suspect, so the footprint at that same point is too. Drop it
                      // rather than highlight a building we can't vouch for.
                      setGeocodeRejected(true)
                      setOutline(null)
                      setAutoPicked(false)
                      setFpState('none')
                      setStage('satellite')
                    }}
                    className="text-[12px] font-medium text-[#1a1a1a] underline decoration-dotted hover:text-emerald-800"
                  >
                    I can&apos;t find it from the street, use the satellite
                  </button>
                  {svMeta.panoUrl && (
                    <a href={svMeta.panoUrl} target="_blank" rel="noreferrer"
                       className="text-[11px] text-[#6b7280] underline decoration-dotted hover:text-[#1a1a1a]">
                      Open in Google Street View ↗
                    </a>
                  )}
                </div>
              </div>
            ) : (
              <div className="text-[11px] leading-relaxed text-[#6b7280]">
                <span className="font-semibold text-[#1a1a1a]">Street reference.</span>{' '}
                {streetPicked ? 'The house you clicked from the street' : 'The street photo'}
                {age ? `, from ${age.label}` : ''}. Click to enlarge.
                <button
                  type="button"
                  onClick={() => setStage('street')}
                  className="mt-1.5 block rounded border border-[#dededc] bg-white px-2 py-1 text-[11px] font-medium text-[#1a1a1a] hover:bg-[#f2f2f0]"
                >
                  {streetPicked ? 'Pick a different house from the street' : 'Pick the house from the street'}
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

      {stage === 'satellite' && !geocodeRejected && fpState !== 'loading' && !placed && (
        <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
          <span className="font-semibold">We couldn&apos;t pick the building out for you.</span>{' '}
          {fpState === 'none'
            ? 'No building outline is mapped at this address.'
            : fpState === 'off'
              ? 'This tile has no scale information, so the outline can\u2019t be placed on it.'
              : 'The building lookup didn\u2019t answer.'}{' '}
          Tap your roof on the image below — the marker is sitting at the middle of the
          tile, which is <em>not</em> a selection.
        </div>
      )}

      {stage === 'satellite' && fpState === 'guess' && !confirmed && (
        <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
          <span className="font-semibold">Check this one carefully.</span> The address didn&apos;t land
          inside any mapped building, so this is the <em>closest</em> one rather than a confirmed match.
          If the outline isn&apos;t on your roof, tap the right one.
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
                fill={fpState === 'guess' ? 'rgba(245,158,11,0.20)' : 'rgba(16,185,129,0.22)'}
                stroke={fpState === 'guess' ? 'rgb(245,158,11)' : 'rgb(16,185,129)'}
                strokeWidth="0.5"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          )}
          {/* Pulsing marker at the chosen point */}
          {/* Green ONLY when the marker means something — a building we picked
              out, or a spot the user chose. Otherwise it is just sitting at the
              middle of the tile, and dressing that up as a selection is what
              made a missing highlight look like a wrong one. */}
          <div
            className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
          >
            {placed ? (
              <>
                <span className="absolute inset-0 -m-3 block animate-ping rounded-full bg-emerald-400/40" style={{ width: 24, height: 24 }} />
                <span className="relative block h-4 w-4 rounded-full border-2 border-white bg-emerald-500 shadow-lg ring-4 ring-emerald-400/30" />
              </>
            ) : (
              <span className="relative block h-4 w-4 rounded-full border-2 border-dashed border-white/90 bg-amber-400/60 shadow-lg" />
            )}
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
