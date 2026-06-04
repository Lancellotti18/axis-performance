'use client'

/**
 * Axis Performance — Manual siding measurement tool.
 *
 * Honest workflow for Category-C features that cannot be measured from
 * top-down satellite imagery. Contractor:
 *   1. Uploads a ground-level elevation photo
 *   2. Picks a known reference object visible in the photo (standard door,
 *      garage door, window) and drags two endpoints to mark its height
 *      in pixels — gives us a scale factor (inches per pixel)
 *   3. Traces the siding region as a polygon
 *   4. Selects elevation (front/rear/left/right) and material
 *   5. Hits Save — backend computes area in sqft from pixel area × scale²
 *
 * The report always labels these as "contractor-entered, not satellite-
 * measured" — we never claim to have measured walls from above.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '@/lib/api'

type Pt = [number, number]
type Phase = 'upload' | 'scale' | 'trace' | 'review'

const REFERENCE_OPTIONS = [
  { key: 'standard_door_80', label: 'Standard door (80")', inches: 80 },
  { key: 'garage_door_84', label: 'Garage door (84")', inches: 84 },
  { key: 'window_36', label: 'Standard window (36")', inches: 36 },
  { key: 'custom', label: 'Custom (enter inches)', inches: 0 },
] as const

const MATERIAL_TYPES = [
  'vinyl', 'fiber_cement', 'wood', 'brick', 'stone', 'stucco', 'metal', 'other',
]

const ELEVATIONS = ['front', 'rear', 'left', 'right', 'other'] as const

interface Props {
  projectId: string
  onSaved?: (row: Record<string, unknown>) => void
}

export function SidingMeasurementTool({ projectId, onSaved }: Props) {
  const [phase, setPhase] = useState<Phase>('upload')
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [imageDims, setImageDims] = useState({ w: 0, h: 0 })
  const [refKey, setRefKey] = useState<typeof REFERENCE_OPTIONS[number]['key']>('standard_door_80')
  const [customInches, setCustomInches] = useState<number>(80)
  const [scaleEndpoints, setScaleEndpoints] = useState<Pt[]>([])     // 2 points in image pixels
  const [tracePoly, setTracePoly] = useState<Pt[]>([])                // pixels
  const [elevation, setElevation] = useState<typeof ELEVATIONS[number]>('front')
  const [material, setMaterial] = useState<string>('vinyl')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)

  const refInches = useMemo(() => {
    if (refKey === 'custom') return Math.max(1, customInches)
    return REFERENCE_OPTIONS.find(o => o.key === refKey)?.inches ?? 80
  }, [refKey, customInches])

  const scalePixelH = useMemo(() => {
    if (scaleEndpoints.length !== 2) return 0
    const [a, b] = scaleEndpoints
    return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2)
  }, [scaleEndpoints])

  const scaleInPerPx = useMemo(() => (scalePixelH > 0 ? refInches / scalePixelH : 0), [refInches, scalePixelH])

  // Shoelace area in pixels²
  const pixelArea = useMemo(() => {
    const n = tracePoly.length
    if (n < 3) return 0
    let s = 0
    for (let i = 0; i < n; i++) {
      const [x1, y1] = tracePoly[i]
      const [x2, y2] = tracePoly[(i + 1) % n]
      s += x1 * y2 - x2 * y1
    }
    return Math.abs(s) / 2
  }, [tracePoly])

  const liveAreaSqft = useMemo(() => {
    if (scaleInPerPx <= 0 || pixelArea <= 0) return 0
    const areaSqIn = pixelArea * scaleInPerPx ** 2
    return Math.round((areaSqIn / 144) * 10) / 10
  }, [pixelArea, scaleInPerPx])

  // ----- Handlers -----
  const onFileChange = useCallback((ev: React.ChangeEvent<HTMLInputElement>) => {
    const f = ev.target.files?.[0]
    if (!f) return
    if (!f.type.startsWith('image/')) {
      setError('Please upload an image file (JPG or PNG).')
      return
    }
    const url = URL.createObjectURL(f)
    setImageUrl(url)
    setPhase('scale')
    setError(null)
  }, [])

  const onImageLoad = useCallback((ev: React.SyntheticEvent<HTMLImageElement>) => {
    const img = ev.currentTarget
    setImageDims({ w: img.naturalWidth, h: img.naturalHeight })
  }, [])

  const evToPixel = useCallback((ev: React.PointerEvent): Pt | null => {
    const svg = svgRef.current
    if (!svg || imageDims.w === 0) return null
    const r = svg.getBoundingClientRect()
    const x = ((ev.clientX - r.left) / r.width) * imageDims.w
    const y = ((ev.clientY - r.top) / r.height) * imageDims.h
    return [Math.round(x), Math.round(y)]
  }, [imageDims])

  const onSvgClick = useCallback((ev: React.PointerEvent<SVGSVGElement>) => {
    const pt = evToPixel(ev)
    if (!pt) return
    if (phase === 'scale') {
      if (scaleEndpoints.length >= 2) {
        setScaleEndpoints([pt])
      } else {
        setScaleEndpoints(prev => [...prev, pt])
      }
    } else if (phase === 'trace') {
      setTracePoly(prev => [...prev, pt])
    }
  }, [phase, scaleEndpoints, evToPixel])

  const save = useCallback(async () => {
    if (tracePoly.length < 3) {
      setError('Trace at least 3 points around the siding region.')
      return
    }
    if (scaleInPerPx <= 0) {
      setError('Set a reference scale first.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const result = await api.roofing.v2.addSidingMeasurement({
        project_id: projectId,
        elevation,
        photo_url: imageUrl ?? undefined,
        reference_object: refKey,
        reference_height_in: refInches,
        reference_pixel_h: scalePixelH,
        region_polygon: tracePoly,
        material_type: material,
        notes: notes || undefined,
      })
      onSaved?.(result)
      // Reset
      setPhase('upload')
      setImageUrl(null)
      setScaleEndpoints([])
      setTracePoly([])
      setNotes('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }, [projectId, elevation, imageUrl, refKey, refInches, scalePixelH, tracePoly, material, notes, onSaved, scaleInPerPx])

  // ----- Render -----
  return (
    <div className="space-y-4 rounded-lg border border-white/10 bg-slate-900/40 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">Manual Siding Measurement</h3>
          <p className="text-xs text-slate-400">
            Trace siding regions on a ground-level photo with a known scale reference.
            This is <strong>not</strong> a satellite measurement — it's contractor-entered data.
          </p>
        </div>
        <span className="rounded border border-amber-400/30 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-300">
          Phase 1 — manual workflow
        </span>
      </div>

      {/* Phase pills */}
      <div className="flex flex-wrap gap-2 text-xs">
        {(['upload', 'scale', 'trace', 'review'] as Phase[]).map((p, i) => (
          <button
            key={p}
            onClick={() => {
              if (p === 'upload') return
              if (p === 'scale' && !imageUrl) return
              if (p === 'trace' && scaleInPerPx <= 0) return
              if (p === 'review' && tracePoly.length < 3) return
              setPhase(p)
            }}
            className={`rounded-full px-3 py-1 ${
              phase === p
                ? 'bg-blue-600 text-white'
                : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
            }`}
          >{i + 1}. {p}</button>
        ))}
      </div>

      {/* Upload */}
      {phase === 'upload' && (
        <div className="rounded-lg border-2 border-dashed border-white/15 p-8 text-center">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            onChange={onFileChange}
            className="hidden"
          />
          <button
            onClick={() => fileRef.current?.click()}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-500"
          >Upload elevation photo</button>
          <p className="mt-3 text-xs text-slate-500">
            Stand directly in front of the wall. Make sure a door, garage door, or window is fully visible — we'll use it for scale.
          </p>
        </div>
      )}

      {/* Image + interaction */}
      {imageUrl && phase !== 'upload' && (
        <>
          {/* Scale controls */}
          {phase === 'scale' && (
            <div className="space-y-2 rounded border border-white/10 bg-slate-800/40 p-3 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <label className="text-slate-400">Reference object:</label>
                <select
                  value={refKey}
                  onChange={e => setRefKey(e.target.value as typeof REFERENCE_OPTIONS[number]['key'])}
                  className="rounded bg-slate-800 px-2 py-1 text-slate-100"
                >
                  {REFERENCE_OPTIONS.map(o => (
                    <option key={o.key} value={o.key}>{o.label}</option>
                  ))}
                </select>
                {refKey === 'custom' && (
                  <input
                    type="number" min={1} step={1}
                    value={customInches}
                    onChange={e => setCustomInches(Number(e.target.value))}
                    className="w-24 rounded bg-slate-800 px-2 py-1 text-slate-100"
                  />
                )}
                <span className="text-slate-500">
                  Click TWO points on the reference object's TOP and BOTTOM to set scale.
                </span>
              </div>
              {scaleEndpoints.length === 2 && (
                <div className="rounded bg-emerald-500/15 px-2 py-1 text-emerald-300">
                  Scale set: {refInches}" over {scalePixelH.toFixed(0)} px = {(scaleInPerPx * 100 / 100).toFixed(3)} in/px
                </div>
              )}
              {scaleEndpoints.length === 2 && (
                <button
                  onClick={() => setPhase('trace')}
                  className="rounded bg-blue-600 px-3 py-1.5 text-white hover:bg-blue-500"
                >Next: trace siding →</button>
              )}
            </div>
          )}

          {/* Trace controls */}
          {phase === 'trace' && (
            <div className="space-y-2 rounded border border-white/10 bg-slate-800/40 p-3 text-xs">
              <div className="text-slate-400">
                Click around the siding region. Each click adds a vertex. Click <strong>Finish</strong> when done.
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => setTracePoly(prev => prev.slice(0, -1))}
                  className="rounded bg-slate-700 px-2 py-1 text-slate-200 hover:bg-slate-600"
                  disabled={tracePoly.length === 0}
                >Undo last</button>
                <button
                  onClick={() => setTracePoly([])}
                  className="rounded bg-slate-700 px-2 py-1 text-slate-200 hover:bg-slate-600"
                  disabled={tracePoly.length === 0}
                >Clear</button>
                {tracePoly.length >= 3 && (
                  <button
                    onClick={() => setPhase('review')}
                    className="rounded bg-emerald-600 px-3 py-1 text-white hover:bg-emerald-500"
                  >Finish ({tracePoly.length} pts) →</button>
                )}
              </div>
              {tracePoly.length >= 3 && (
                <div className="text-emerald-300">
                  Live area: <strong>{liveAreaSqft.toLocaleString()} sq ft</strong>
                </div>
              )}
            </div>
          )}

          {/* Review + save */}
          {phase === 'review' && (
            <div className="space-y-2 rounded border border-emerald-400/30 bg-emerald-500/10 p-3 text-xs">
              <div className="text-emerald-200">
                Computed siding area: <strong>{liveAreaSqft.toLocaleString()} sq ft</strong> @ {scaleInPerPx.toFixed(3)} in/px scale.
              </div>
              <div className="flex flex-wrap gap-2">
                <label className="text-slate-300">Elevation:</label>
                <select
                  value={elevation}
                  onChange={e => setElevation(e.target.value as typeof ELEVATIONS[number])}
                  className="rounded bg-slate-800 px-2 py-1 text-slate-100"
                >
                  {ELEVATIONS.map(e => <option key={e} value={e}>{e}</option>)}
                </select>
                <label className="text-slate-300">Material:</label>
                <select
                  value={material}
                  onChange={e => setMaterial(e.target.value)}
                  className="rounded bg-slate-800 px-2 py-1 text-slate-100"
                >
                  {MATERIAL_TYPES.map(m => <option key={m} value={m}>{m.replace('_', ' ')}</option>)}
                </select>
              </div>
              <textarea
                placeholder="Notes (optional)"
                value={notes}
                onChange={e => setNotes(e.target.value)}
                className="h-16 w-full rounded bg-slate-800 px-2 py-1 text-slate-100"
              />
              <button
                onClick={save}
                disabled={saving}
                className="rounded bg-blue-600 px-3 py-1.5 text-white hover:bg-blue-500 disabled:opacity-50"
              >{saving ? 'Saving…' : 'Save siding measurement'}</button>
            </div>
          )}

          {/* Image canvas */}
          <div className="relative max-h-[600px] overflow-hidden rounded-lg border border-white/10 bg-black">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imageUrl}
              alt="elevation"
              className="block max-h-[600px] w-full object-contain"
              onLoad={onImageLoad}
              draggable={false}
            />
            <svg
              ref={svgRef}
              viewBox={`0 0 ${imageDims.w || 1} ${imageDims.h || 1}`}
              preserveAspectRatio="xMidYMid meet"
              className="absolute inset-0 h-full w-full"
              style={{ cursor: 'crosshair' }}
              onPointerDown={onSvgClick}
            >
              {/* Scale line */}
              {scaleEndpoints.length === 2 && (
                <g>
                  <line
                    x1={scaleEndpoints[0][0]} y1={scaleEndpoints[0][1]}
                    x2={scaleEndpoints[1][0]} y2={scaleEndpoints[1][1]}
                    stroke="#fbbf24" strokeWidth={4} strokeLinecap="round"
                  />
                  {scaleEndpoints.map((p, i) => (
                    <circle key={i} cx={p[0]} cy={p[1]} r={8} fill="#fbbf24" stroke="white" strokeWidth={2} />
                  ))}
                </g>
              )}
              {scaleEndpoints.length === 1 && (
                <circle cx={scaleEndpoints[0][0]} cy={scaleEndpoints[0][1]} r={8} fill="#fbbf24" stroke="white" strokeWidth={2} />
              )}

              {/* Trace polygon */}
              {tracePoly.length > 0 && (
                <g>
                  {tracePoly.length >= 3 ? (
                    <polygon
                      points={tracePoly.map(p => `${p[0]},${p[1]}`).join(' ')}
                      fill="rgba(34,197,94,0.18)"
                      stroke="#22c55e"
                      strokeWidth={3}
                    />
                  ) : (
                    <polyline
                      points={tracePoly.map(p => `${p[0]},${p[1]}`).join(' ')}
                      fill="none"
                      stroke="#22c55e"
                      strokeWidth={3}
                      strokeDasharray="6 4"
                    />
                  )}
                  {tracePoly.map((p, i) => (
                    <circle key={i} cx={p[0]} cy={p[1]} r={6} fill="white" stroke="#22c55e" strokeWidth={2} />
                  ))}
                </g>
              )}
            </svg>
          </div>
        </>
      )}

      {error && <p className="text-xs text-rose-400">{error}</p>}
    </div>
  )
}

export default SidingMeasurementTool
