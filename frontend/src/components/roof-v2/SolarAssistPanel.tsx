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
type Segment = NonNullable<Solar['segments']>[number]

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
 *  pipeline uses (tile center + feet_per_pixel × native dims). */
function geoToFrac(
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

export default function SolarAssistPanel({
  runId, centerLat, centerLng, imageWidthPx, imageHeightPx, feetPerPixel, existingFacetCount, onAddFacets,
}: Props) {
  const [data, setData] = useState<Solar | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    api.roofing.v2.getSolar(runId)
      .then(d => { if (!cancelled) setData(d) })
      .catch(() => { if (!cancelled) setData({ available: false, reason: 'lookup failed' }) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [runId])

  const addAll = useCallback((segments: Segment[]) => {
    const facets: Facet[] = segments.map((s, i) => {
      const { sw, ne } = s.bbox
      const nw = geoToFrac(ne.lat, sw.lng, centerLat, centerLng, imageWidthPx, imageHeightPx, feetPerPixel)
      const neF = geoToFrac(ne.lat, ne.lng, centerLat, centerLng, imageWidthPx, imageHeightPx, feetPerPixel)
      const seF = geoToFrac(sw.lat, ne.lng, centerLat, centerLng, imageWidthPx, imageHeightPx, feetPerPixel)
      const swF = geoToFrac(sw.lat, sw.lng, centerLat, centerLng, imageWidthPx, imageHeightPx, feetPerPixel)
      return {
        label: FACET_LABELS[existingFacetCount + i] || `F${existingFacetCount + i + 1}`,
        polygon: [nw, neF, seF, swF],
        pitch: s.pitch || '6/12',
        confidence: 0.7,
        userConfirmed: false,
      }
    })
    onAddFacets(facets)
    toast.success(`Added ${facets.length} roof plane${facets.length === 1 ? '' : 's'} — refine the shapes, pitch is pre-filled`)
  }, [centerLat, centerLng, imageWidthPx, imageHeightPx, feetPerPixel, existingFacetCount, onAddFacets])

  if (loading) {
    return (
      <section className="rounded-lg border border-white/10 bg-slate-900/40 p-3 text-xs text-slate-400">
        Checking Google Solar coverage…
      </section>
    )
  }
  if (!data) return null

  // Truly inert (no key) → render nothing so it doesn't clutter the editor.
  if (!data.available && (data.reason || '').toLowerCase().includes('key not configured')) {
    return null
  }
  if (!data.available) {
    return (
      <section className="rounded-lg border border-white/10 bg-slate-900/40 p-3 text-xs text-slate-500">
        <span className="font-semibold text-slate-300">Google Solar:</span> {data.reason || 'not available for this address.'} — trace facets manually or use auto-detect.
      </section>
    )
  }

  const segs = data.segments || []
  return (
    <section className="rounded-lg border border-emerald-400/30 bg-emerald-500/5 p-4 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-emerald-200">Google Solar roof data</h3>
          <p className="text-xs text-slate-400">
            Google pre-segmented this roof into <strong>{data.segment_count}</strong> plane{data.segment_count === 1 ? '' : 's'}
            {data.whole_roof_area_sqft ? <> · ~{Math.round(data.whole_roof_area_sqft).toLocaleString()} ft² total</> : null}
            {data.imagery_quality ? <> · {data.imagery_quality.toLowerCase()} quality</> : null}.
            Pitch is <strong>measured</strong>, not guessed.
          </p>
        </div>
        {segs.length > 0 && (
          <button
            onClick={() => addAll(segs)}
            className="shrink-0 rounded bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-600"
          >Add {segs.length} as facets</button>
        )}
      </div>

      {segs.length > 0 && (
        <ul className="mt-2 grid grid-cols-2 gap-1 text-[11px] md:grid-cols-3">
          {segs.map((s, i) => (
            <li key={i} className="rounded bg-slate-900/60 px-2 py-1 text-slate-300">
              <span className="font-medium text-slate-100">Plane {i + 1}</span> · {s.pitch} · {s.slope_direction} · {Math.round(s.area_sqft)} ft²
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 text-[10px] text-slate-500">
        Added planes are rectangles from Google&apos;s bounding boxes — drag the vertices to match the exact roof shape. Pitch + direction are already correct.
      </div>
    </section>
  )
}
