'use client'

/**
 * SolarAssistPanel — Google Solar roof segments as starter facets.
 *
 * The key idea: this does NOT read the (blurry) satellite tile. Google has
 * already run photogrammetry and returns the roof PRE-SEGMENTED into planes
 * with measured pitch + azimuth + area. So even on low-res imagery, the
 * contractor gets a real starting roof — each segment's lat/lng bounding box
 * is converted to an image-fraction rectangle and dropped in as a facet with
 * pitch pre-filled. They then refine the shapes (snap-to-edge) instead of
 * tracing from scratch.
 *
 * Inert until the backend key is set: when unavailable for "key not configured"
 * it renders nothing; for "no coverage" it shows a quiet one-liner.
 */
import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'

import { api } from '@/lib/api'
import type { Facet } from './RoofFacetEditor'

type Solar = Awaited<ReturnType<typeof api.roofing.v2.getSolar>>

interface Props {
  runId: string
  centerLat: number
  centerLng: number
  imageWidthPx: number
  imageHeightPx: number
  feetPerPixel: number
  existingFacetCount: number
  onAddFacets: (facets: Facet[]) => void
}

const FACET_LABELS = ['RF-1', 'RF-2', 'RF-3', 'RF-4', 'RF-5', 'RF-6', 'RF-7', 'RF-8', 'RF-9', 'RF-10', 'RF-11', 'RF-12']
const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

/** Geographic point → image fraction, in the SAME basis the measurement
 *  pipeline uses (tile center + feet_per_pixel × native dims). Exported so the
 *  one-button Auto-analyze pipeline reuses the exact same conversion. */
export function geoToFrac(
  lat: number, lng: number, cLat: number, cLng: number,
  wPx: number, hPx: number, ftPerPx: number,
): [number, number] {
  const mpp = ftPerPx * 0.3048                 // metres per pixel
  const groundWidthM = wPx * mpp
  const groundHeightM = hPx * mpp
  const eastM = (lng - cLng) * 111320 * Math.cos((cLat * Math.PI) / 180)
  const northM = (lat - cLat) * 111320
  const fx = 0.5 + eastM / (groundWidthM || 1)
  const fy = 0.5 - northM / (groundHeightM || 1)   // north (higher lat) = up
  return [clamp01(fx), clamp01(fy)]
}

/** Inverse of geoToFrac: image fraction → geographic point. Used to anchor
 *  building lookups on the contractor's tapped "this is my house" point. */
export function fracToGeo(
  fx: number, fy: number, cLat: number, cLng: number,
  wPx: number, hPx: number, ftPerPx: number,
): { lat: number; lng: number } {
  const mpp = ftPerPx * 0.3048
  const eastM = (fx - 0.5) * (wPx * mpp)
  const northM = (0.5 - fy) * (hPx * mpp)   // image y grows downward
  return {
    lat: cLat + northM / 111320,
    lng: cLng + eastM / (111320 * Math.cos((cLat * Math.PI) / 180)),
  }
}

type Footprint = Awaited<ReturnType<typeof api.roofing.v2.getFootprint>>

export default function SolarAssistPanel({
  runId, centerLat, centerLng, imageWidthPx, imageHeightPx, feetPerPixel, existingFacetCount, onAddFacets,
}: Props) {
  const [data, setData] = useState<Solar | null>(null)
  const [footprint, setFootprint] = useState<Footprint | null>(null)
  const [loading, setLoading] = useState(true)
  // Why Solar did or didn't measure each traced facet. Until now this existed
  // only in a server log: a run could show "6/12 default" on three of four
  // facets with nothing in the product explaining it.
  const [diag, setDiag] = useState<Awaited<ReturnType<typeof api.roofing.v2.getSolarDiagnostic>> | null>(null)
  const [diagOpen, setDiagOpen] = useState(false)
  const [diagBusy, setDiagBusy] = useState(false)

  const loadDiag = async () => {
    setDiagBusy(true); setDiagOpen(true)
    try { setDiag(await api.roofing.v2.getSolarDiagnostic(runId)) }
    catch { setDiag(null) }
    finally { setDiagBusy(false) }
  }

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      let solar: Solar
      try {
        solar = await api.roofing.v2.getSolar(runId)
      } catch {
        solar = { available: false, reason: 'lookup failed' }
      }
      if (cancelled) return
      setData(solar)
      // Fall back to the free OSM building outline when Solar can't help here.
      if (!solar.available) {
        try {
          const fp = await api.roofing.v2.getFootprint(runId)
          if (!cancelled) setFootprint(fp)
        } catch { /* footprint is best-effort */ }
      }
      if (!cancelled) setLoading(false)
    })()
    return () => { cancelled = true }
  }, [runId])

  const addFootprint = useCallback((ring: { lat: number; lng: number }[]) => {
    const poly = ring.map(p =>
      geoToFrac(p.lat, p.lng, centerLat, centerLng, imageWidthPx, imageHeightPx, feetPerPixel),
    )
    if (poly.length < 3) return
    onAddFacets([{
      label: FACET_LABELS[existingFacetCount] || `F${existingFacetCount + 1}`,
      polygon: poly,
      pitch: '6/12',
      confidence: 0.6,
      userConfirmed: false,
      aiSuggested: true,   // OSM/auto origin → ai_corrected once confirmed
    }])
    toast.success('Added the building outline — split it into roof planes and set pitch (a gable photo gives pitch)')
  }, [centerLat, centerLng, imageWidthPx, imageHeightPx, feetPerPixel, existingFacetCount, onAddFacets])

  if (loading) {
    return (
      <section className="rounded-lg border border-[#dededc] bg-[#f8f8f7] p-3 text-xs text-[#6b7280]">
        Checking auto-draw coverage…
      </section>
    )
  }
  if (!data) return null

  // Solar unavailable — offer the free OSM building outline if we found one.
  if (!data.available) {
    if (footprint?.available && footprint.ring && footprint.ring.length >= 3) {
      return (
        <section className="rounded-lg border border-blue-400/30 bg-blue-500/5 p-4 text-sm">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-blue-900">Auto-draw: building outline</h3>
              <p className="text-xs text-[#6b7280]">
                No Google Solar data here, but we found this building&apos;s outline (OpenStreetMap).
                Drop it on the tile, then split it into roof planes and set pitch.
              </p>
            </div>
            <button
              onClick={() => addFootprint(footprint.ring!)}
              className="shrink-0 rounded bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-500"
            >Add outline</button>
          </div>
        </section>
      )
    }
    // No Solar key AND no footprint → stay invisible so the editor isn't cluttered.
    if ((data.reason || '').toLowerCase().includes('key not configured')) return null
    return (
      <section className="rounded-lg border border-[#dededc] bg-[#f8f8f7] p-3 text-xs text-[#6b7280]">
        No auto-draw data for this address — trace facets manually (snap-to-edge helps) or try auto-detect below.
      </section>
    )
  }

  const segs = data.segments || []
  return (
    <section className="rounded-lg border border-emerald-400/30 bg-emerald-500/5 p-4 text-sm">
      <div>
        <h3 className="text-sm font-semibold text-emerald-900">Google Solar roof data ✓</h3>
        <p className="text-xs text-[#6b7280]">
          Google pre-segmented this roof into <strong>{data.segment_count}</strong> plane{data.segment_count === 1 ? '' : 's'}
          {data.whole_roof_area_sqft ? <> · ~{Math.round(data.whole_roof_area_sqft).toLocaleString()} ft² total</> : null}
          {data.imagery_quality ? <> · {data.imagery_quality.toLowerCase()} quality</> : null}.
          Pitch is <strong>measured</strong>, not guessed — these planes are folded in automatically when you click <strong>Auto-detect roof</strong> below.
        </p>
      </div>

      {/* The measured-vs-assumed breakdown. "Pitch is measured, not guessed"
          above is only true for the facets Solar actually matched — this says
          which, and why the rest missed. */}
      <div className="mt-2">
        <button
          type="button"
          onClick={() => (diagOpen ? setDiagOpen(false) : loadDiag())}
          className="rounded border border-[#dededc] bg-white px-2 py-1 text-[11px] font-medium text-[#1a1a1a] hover:bg-[#f2f2f0]"
        >
          {diagOpen ? 'Hide' : 'Which of my facets did Solar measure?'}
        </button>
      </div>

      {diagOpen && (
        <div className="mt-2 rounded-lg border border-[#dededc] bg-white p-2.5 text-[11px] text-[#2d2d2d]">
          {diagBusy && <p className="text-[#6b7280]">Checking each traced facet…</p>}
          {!diagBusy && !diag && <p className="text-[#6b7280]">Couldn&apos;t load the breakdown.</p>}
          {!diagBusy && diag && (
            <>
              <p className="font-medium text-[#1a1a1a]">{diag.verdict}</p>
              {diag.lookup?.zoom_mismatch && (
                <p className="mt-1 rounded bg-amber-50 px-2 py-1 text-amber-900">
                  Zoom mismatch (tile {diag.lookup.zoom_mismatch.run}, request{' '}
                  {diag.lookup.zoom_mismatch.client}) — Solar planes are projected at the
                  wrong scale, so overlaps will read low across the board.
                </p>
              )}
              <ul className="mt-1.5 space-y-1">
                {diag.facets.map((f, i) => {
                  const measured = f.current_source === 'solar_measured'
                  const pct = f.best_overlap == null ? null : Math.round(f.best_overlap * 100)
                  return (
                    <li key={i} className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium">{f.label || `Facet ${i + 1}`}</span>
                      <span>· {f.current_pitch}</span>
                      <span className={measured ? 'text-emerald-700' : 'text-amber-700'}>
                        {measured ? 'measured by Solar' : `assumed (${f.current_source || 'default'})`}
                      </span>
                      {!measured && pct != null && (
                        <span className="text-[#6b7280]">
                          — best overlap {pct}%, needs 50%
                          {f.solar_would_give ? ` (Solar had ${f.solar_would_give})` : ''}
                        </span>
                      )}
                    </li>
                  )
                })}
              </ul>
              <p className="mt-1.5 text-[#6b7280]">
                An assumed pitch still drives the area calculation. If a facet is really
                steeper than the assumption, its area is under-measured.
              </p>
            </>
          )}
        </div>
      )}

      {segs.length > 0 && (
        <ul className="mt-2 grid grid-cols-2 gap-1 text-[11px] md:grid-cols-3">
          {segs.map((s, i) => (
            <li key={i} className="rounded bg-[#f8f8f7] px-2 py-1 text-[#2d2d2d]">
              <span className="font-medium text-[#1a1a1a]">Plane {i + 1}</span> · {s.pitch} · {s.slope_direction} · {Math.round(s.area_sqft)} ft²
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
