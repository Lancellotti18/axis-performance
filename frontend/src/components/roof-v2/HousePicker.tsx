'use client'

/**
 * HousePicker — "Is this the house?", answered from the same Google data Axis
 * measures.
 *
 * The previous picker opened on a Google Street View photo ("click the house in
 * the street photo") and outlined the building from OpenStreetMap. The first
 * founding contractor quit on it (Fortitude, 2026-10-13): his street photo was
 * from February 2008 with the house behind pine trees, the OpenStreetMap servers
 * were down so there was no outline, and nothing on screen said "here is your
 * house — is this right?". His record shows he never confirmed a house.
 *
 * Now:
 *   1. the satellite opens zoomed on the building Google finds at the address,
 *      outlined, with its street address;
 *   2. one question — Is this the house?  [Yes, measure this roof] [No, let me pick];
 *   3. "No" → click any roof: that building is outlined instead, with ITS address;
 *   4. Street View is optional ("See it from the street"), dated, never first.
 * The roof confirmed here is exactly the one auto-measure reads, because both use
 * Google's building centre.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { api, invalidateApiCache } from '@/lib/api'
import { fracToGeo, geoToFrac } from './SolarAssistPanel'

interface Props {
  runId: string
  imageUrl: string
  /** Centre of the satellite tile (the geocoded address). */
  lat?: number
  lng?: number
  /** The job's address, for the pin label when no street address comes back. */
  address?: string
  imageWidthPx?: number
  imageHeightPx?: number
  feetPerPixel?: number
  initialPoint?: { x: number; y: number } | null
  /** Called once the house is confirmed and saved. `addressAcknowledged` is
   *  true when the contractor confirmed a building whose address did NOT match
   *  the job's — so the step does not ask the same question again. */
  onConfirmed?: (p: { x: number; y: number }, info: { addressAcknowledged: boolean; outline: Pt[] | null }) => void
}

type Building = Awaited<ReturnType<typeof api.roofing.v2.buildingAt>>
type Pt = { x: number; y: number }

/** "2008-02" -> "February 2008" and its age in years. */
function photoAge(date?: string | null): { label: string; years: number } | null {
  const m = date?.match(/^(\d{4})-(\d{2})/)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, 1)
  return {
    label: d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
    years: (Date.now() - d.getTime()) / (365.25 * 24 * 3600 * 1000),
  }
}

export default function HousePicker({
  runId, imageUrl, lat, lng, address, imageWidthPx = 2048, imageHeightPx = 1366, feetPerPixel = 0,
  initialPoint, onConfirmed,
}: Props) {
  const canGeo = lat != null && lng != null && !!feetPerPixel
  const toFrac = useCallback((p: { lat: number; lng: number }): Pt => {
    const [x, y] = geoToFrac(p.lat, p.lng, lat ?? 0, lng ?? 0, imageWidthPx, imageHeightPx, feetPerPixel)
    return { x, y }
  }, [lat, lng, imageWidthPx, imageHeightPx, feetPerPixel])
  const toGeo = useCallback((p: Pt) => fracToGeo(p.x, p.y, lat ?? 0, lng ?? 0, imageWidthPx, imageHeightPx, feetPerPixel),
    [lat, lng, imageWidthPx, imageHeightPx, feetPerPixel])

  // 'finding' Google's building · 'ask' Is this the house? · 'pick' click a roof
  const [phase, setPhase] = useState<'finding' | 'ask' | 'pick'>('finding')
  const [building, setBuilding] = useState<Building | null>(null)
  // Where the house is: Google's building centre, or the contractor's click when
  // Google has no building there.
  const [point, setPoint] = useState<Pt | null>(initialPoint ?? null)
  const [saving, setSaving] = useState(false)
  const [zoom, setZoom] = useState(3)

  const lookUp = useCallback(async (at?: { lat: number; lng: number }, clicked?: Pt) => {
    setPhase('finding')
    try {
      const b = await api.roofing.v2.buildingAt(runId, at)
      setBuilding(b)
      if (b.available && b.center) setPoint(toFrac(b.center))
      else setPoint(clicked ?? null)
      setPhase(b.available || clicked ? 'ask' : 'pick')
    } catch {
      setBuilding(null)
      setPoint(clicked ?? null)
      setPhase(clicked ? 'ask' : 'pick')
    }
  }, [runId, toFrac])

  // On arrival: the building at the address (or at a house already confirmed).
  useEffect(() => {
    if (!canGeo) { setPhase('pick'); return }
    void lookUp(initialPoint ? toGeo(initialPoint) : undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, canGeo])

  const outline = useMemo(
    () => (building?.available && building.outline?.length ? building.outline.map(toFrac) : null),
    [building, toFrac],
  )

  // Frame the house: zoom so the outline fills about half the view.
  useEffect(() => {
    if (!outline || outline.length < 3) return
    const xs = outline.map(p => p.x), ys = outline.map(p => p.y)
    const span = Math.max(Math.max(...xs) - Math.min(...xs), (Math.max(...ys) - Math.min(...ys)) * (imageHeightPx / imageWidthPx))
    setZoom(Math.max(1.5, Math.min(6, 0.45 / Math.max(span, 0.01))))
  }, [outline, imageWidthPx, imageHeightPx])

  const confirm = useCallback(async () => {
    if (!point) return
    setSaving(true)
    try {
      const geo = canGeo ? toGeo(point) : undefined
      // Google's building centre when there is one: the exact point auto-measure reads.
      const at = building?.available && building.center ? building.center : geo
      await api.roofing.v2.setSubjectPoint(runId, point.x, point.y, at?.lat, at?.lng)
      invalidateApiCache('/solar')
      invalidateApiCache('/footprint')
      onConfirmed?.(point, { addressAcknowledged: building?.address_status === 'mismatch', outline })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save the house')
    } finally {
      setSaving(false)
    }
  }, [point, canGeo, toGeo, building, runId, onConfirmed, outline])

  // Clicking the photo — only while picking.
  const imgRef = useRef<HTMLImageElement>(null)
  const onMapClick = (e: React.MouseEvent) => {
    if (phase !== 'pick' || !imgRef.current) return
    const r = imgRef.current.getBoundingClientRect()     // accounts for the zoom transform
    const p = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }
    if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) return
    if (canGeo) void lookUp(toGeo(p), p)
    else { setPoint(p); setPhase('ask') }
  }

  // ── Street view: optional, dated, never first ────────────────────────────
  const [sv, setSv] = useState<{ open: boolean; image?: string; date?: string; reason?: string; loading?: boolean }>({ open: false })
  const openStreet = async () => {
    setSv({ open: true, loading: true })
    const at = building?.center ?? (canGeo ? { lat: lat!, lng: lng! } : null)
    if (!at) { setSv({ open: true, reason: 'No location for this job yet.' }); return }
    try {
      const r = await api.roofing.v2.getStreetView(at.lat, at.lng)
      setSv(r.available && r.image ? { open: true, image: r.image, date: r.date }
        : { open: true, reason: 'There is no street photo for this address.' })
    } catch {
      setSv({ open: true, reason: 'The street photo could not be loaded just now.' })
    }
  }
  const svAge = photoAge(sv.date)

  // ── The question card ────────────────────────────────────────────────────
  const label = building?.address || building?.job_address || address?.split(',')[0] || 'this address'
  const mismatch = building?.address_status === 'mismatch'
  const centre = point ?? { x: 0.5, y: 0.5 }

  return (
    <div className="space-y-3">
      <section className={`rounded-xl border bg-white p-4 shadow-sm ${mismatch ? 'border-amber-300' : 'border-blue-300'}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            {phase === 'finding' && (
              <div className="flex items-center gap-3">
                <span className="h-5 w-5 animate-spin rounded-full border-2 border-blue-200 border-t-blue-600" />
                <div>
                  <h2 className="text-[15px] font-semibold text-[#1a1a1a]">Finding the house…</h2>
                  <p className="text-[13px] text-[#4b5563]">Looking up the building at {address?.split(',')[0] || 'this address'}.</p>
                </div>
              </div>
            )}
            {phase === 'ask' && (
              <>
                <h2 className="text-[15px] font-semibold text-[#1a1a1a]">Is this the house?</h2>
                {building?.available ? (
                  <p className="mt-1 text-[13px] leading-relaxed text-[#4b5563]">
                    The roof outlined on the map
                    {building.address ? <> is <strong className="text-[#1a1a1a]">{building.address}</strong></> : ' is the building at this address'}.
                    {' '}If it&apos;s the right house, Axis measures it next.
                  </p>
                ) : (
                  <p className="mt-1 text-[13px] leading-relaxed text-[#4b5563]">
                    You picked the spot marked on the map. If it&apos;s on the right roof, Axis measures it next.
                  </p>
                )}
                {mismatch && building?.job_address && (
                  <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-950">
                    This building looks like <strong>{building.address}</strong>, but this job is for{' '}
                    <strong>{building.job_address}</strong>. If it&apos;s the wrong house, click <strong>No, let me pick</strong>.
                  </p>
                )}
                {building?.address_status === 'match' && (
                  <p className="mt-1 text-xs text-emerald-700">✓ Matches this job&apos;s address</p>
                )}
              </>
            )}
            {phase === 'pick' && (
              <>
                <h2 className="text-[15px] font-semibold text-[#1a1a1a]">Click the roof of the house</h2>
                <p className="mt-1 text-[13px] leading-relaxed text-[#4b5563]">
                  {building && !building.available && !point
                    ? 'We couldn’t pick the building out automatically here. '
                    : ''}
                  Click anywhere on the right roof and Axis outlines it for you.
                </p>
              </>
            )}
          </div>
          <div className="flex shrink-0 flex-col items-stretch gap-2 sm:items-end">
            {phase === 'ask' && (
              <>
                <button onClick={() => { void confirm() }} disabled={saving || !point}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-500 disabled:opacity-50">
                  {saving ? 'Saving…' : 'Yes, measure this roof'}
                </button>
                <button onClick={() => { setPhase('pick'); setZoom(z => Math.max(1.5, z * 0.6)) }}
                  className="rounded-lg border border-[#dededc] bg-white px-4 py-2 text-sm font-medium text-[#1a1a1a] hover:bg-[#f8f8f7]">
                  No, let me pick
                </button>
              </>
            )}
            {phase === 'pick' && building?.available && (
              <button onClick={() => setPhase('ask')}
                className="rounded-lg border border-[#dededc] bg-white px-4 py-2 text-sm font-medium text-[#1a1a1a] hover:bg-[#f8f8f7]">
                Back
              </button>
            )}
          </div>
        </div>
        <div className="mt-3 flex items-center justify-end">
          <button onClick={() => { void openStreet() }} disabled={!canGeo}
            className="text-xs font-medium text-[#0068d6] underline underline-offset-2 hover:text-[#01498f] disabled:opacity-40">
            See it from the street
          </button>
        </div>
      </section>

      {/* The map — zoomed on the house; click to pick while picking. */}
      <div className="relative h-[480px] overflow-hidden rounded-xl border border-[#dededc] bg-[#f8f8f7]"
        onClick={onMapClick} style={{ cursor: phase === 'pick' ? 'crosshair' : 'default' }}>
        <div className="absolute left-1/2 top-1/2 w-full"
          style={{
            aspectRatio: `${imageWidthPx} / ${imageHeightPx}`,
            transform: `translate(-50%, -50%) scale(${zoom}) translate(${(0.5 - centre.x) * 100}%, ${(0.5 - centre.y) * 100}%)`,
            transformOrigin: 'center',
            transition: 'transform 300ms ease',
          }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img ref={imgRef} src={imageUrl} alt="Satellite view of the property" draggable={false}
            className="absolute inset-0 h-full w-full select-none" />
          <svg viewBox="0 0 1 1" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 h-full w-full">
            {outline && phase !== 'finding' && (
              <polygon points={outline.map(p => `${p.x},${p.y}`).join(' ')}
                fill="rgba(34,211,238,0.18)" stroke="#22d3ee" strokeWidth={2.5 / zoom} vectorEffect="non-scaling-stroke" />
            )}
          </svg>
          {point && phase !== 'finding' && (
            <div className="pointer-events-none absolute" style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}>
              <div style={{ transform: `translate(-50%, -100%) scale(${1 / zoom})`, transformOrigin: 'bottom center' }}
                className="flex flex-col items-center">
                <span className="mb-1 whitespace-nowrap rounded-md bg-[#1a1a1a]/90 px-2 py-1 text-xs font-semibold text-white shadow">
                  {label}
                </span>
                <span className="h-3 w-3 rounded-full border-2 border-white bg-[#0068d6] shadow" />
              </div>
            </div>
          )}
        </div>

        <div className="absolute bottom-2 right-2 flex items-center gap-1 rounded-md border border-[#dededc] bg-white/95 p-1 text-xs shadow"
          onClick={e => e.stopPropagation()}>
          <button onClick={() => setZoom(z => Math.max(1, z / 1.4))} className="rounded px-2 py-1 hover:bg-[#eeeeed]" title="Zoom out">−</button>
          <button onClick={() => setZoom(z => Math.min(8, z * 1.4))} className="rounded px-2 py-1 hover:bg-[#eeeeed]" title="Zoom in">+</button>
        </div>
        {phase === 'pick' && (
          <div className="pointer-events-none absolute left-2 top-2 rounded-md bg-[#1a1a1a]/85 px-2.5 py-1.5 text-xs font-medium text-white">
            Click the roof of the house
          </div>
        )}
      </div>

      {sv.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setSv({ open: false })}
          role="dialog" aria-modal="true">
          <div className="w-full max-w-2xl rounded-2xl bg-white p-4 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-[#1a1a1a]">From the street</h3>
              <button onClick={() => setSv({ open: false })} className="rounded p-1 text-[#6b7280] hover:bg-[#eeeeed]" aria-label="Close">✕</button>
            </div>
            {sv.loading && <p className="py-10 text-center text-sm text-[#6b7280]">Loading the street photo…</p>}
            {sv.reason && <p className="py-10 text-center text-sm text-[#6b7280]">{sv.reason}</p>}
            {sv.image && (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={sv.image} alt="Street-level photo near the property" className="w-full rounded-lg" />
                <p className={`mt-2 text-xs ${svAge && svAge.years > 5 ? 'text-amber-800' : 'text-[#6b7280]'}`}>
                  {svAge ? `Photo from ${svAge.label}` : 'Photo date unknown'}
                  {svAge && svAge.years > 5 ? ' — this is an old photo; the house may look different today.' : '.'}
                  {' '}The outline on the map is what Axis measures.
                </p>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
