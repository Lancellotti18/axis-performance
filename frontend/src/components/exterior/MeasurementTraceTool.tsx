'use client'

/**
 * Axis Performance — Exterior measurement trace tool.
 *
 * Contractor selects a photo, picks what they are measuring (wall / window /
 * door / trim / corner), sets a scale anchor (door height in pixels), and
 * traces the geometry on the photo. The backend computes area / length /
 * width × height from the trace × scale.
 *
 * Workflow per measurement:
 *   1. Pick photo (from the job's photo list)
 *   2. Pick measurement type — wall (polygon), window/door (rectangle),
 *      trim (polyline), corner (single point)
 *   3. Set scale anchor (click TOP then BOTTOM of a reference object — door,
 *      garage door, window, or custom inches)
 *   4. Trace geometry (clicks add vertices)
 *   5. Save → backend stores trace + computes the right derived metric
 *
 * Every measurement is tagged contractor_entered=true so the report never
 * presents AI-derived numbers as if they were measured.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '@/lib/api'

type Pt = [number, number]
type MeasurementType = 'wall' | 'window' | 'door' | 'trim' | 'corner_inside' | 'corner_outside'
type Phase = 'scale' | 'trace' | 'review'

interface Photo {
  id: string
  photo_url: string
  classified_elevation?: string
  width_px?: number
  height_px?: number
  vision_observations?: Record<string, unknown>
}

interface Props {
  jobId: string
  photos: Photo[]
  defaultElevation?: 'front' | 'right' | 'rear' | 'left' | 'other'
  onSaved: () => void
}

const REFERENCE_OPTIONS = [
  { key: 'standard_door_80', label: 'Standard door (80")', inches: 80 },
  { key: 'garage_door_84', label: 'Garage door (84")', inches: 84 },
  { key: 'window_36', label: 'Standard window (36")', inches: 36 },
  { key: 'custom', label: 'Custom', inches: 0 },
] as const

const MATERIAL_TYPES = [
  'vinyl', 'fiber_cement', 'wood', 'brick', 'stone', 'stucco', 'metal', 'other',
]

const MEASUREMENT_TYPE_OPTIONS: Array<{ key: MeasurementType; label: string; geo: 'polygon' | 'rect' | 'polyline' | 'point' }> = [
  { key: 'wall',           label: 'Wall / facade region', geo: 'polygon' },
  { key: 'window',         label: 'Window',               geo: 'rect' },
  { key: 'door',           label: 'Door',                 geo: 'rect' },
  { key: 'trim',           label: 'Trim run',             geo: 'polyline' },
  { key: 'corner_outside', label: 'Outside corner',       geo: 'point' },
  { key: 'corner_inside',  label: 'Inside corner',        geo: 'point' },
]

export function MeasurementTraceTool({ jobId, photos, defaultElevation = 'front', onSaved }: Props) {
  const [selectedPhotoId, setSelectedPhotoId] = useState<string | null>(photos[0]?.id ?? null)
  const [type, setType] = useState<MeasurementType>('wall')
  const [phase, setPhase] = useState<Phase>('scale')
  const [refKey, setRefKey] = useState<typeof REFERENCE_OPTIONS[number]['key']>('standard_door_80')
  const [customInches, setCustomInches] = useState(80)
  const [scaleEndpoints, setScaleEndpoints] = useState<Pt[]>([])
  const [tracePoints, setTracePoints] = useState<Pt[]>([])
  const [elevation, setElevation] = useState(defaultElevation)
  const [material, setMaterial] = useState<string>('vinyl')
  const [facadeId, setFacadeId] = useState<string>('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [imageDims, setImageDims] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const svgRef = useRef<SVGSVGElement | null>(null)

  const selectedPhoto = useMemo(
    () => photos.find(p => p.id === selectedPhotoId) || null,
    [photos, selectedPhotoId],
  )

  useEffect(() => {
    setScaleEndpoints([])
    setTracePoints([])
    setPhase('scale')
  }, [selectedPhotoId, type])

  // ---- Derived ----
  const refInches = refKey === 'custom' ? Math.max(1, customInches)
    : REFERENCE_OPTIONS.find(o => o.key === refKey)?.inches ?? 80

  const scalePixelH = useMemo(() => {
    if (scaleEndpoints.length !== 2) return 0
    const [a, b] = scaleEndpoints
    return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2)
  }, [scaleEndpoints])

  const scaleInPerPx = scalePixelH > 0 ? refInches / scalePixelH : 0

  const geometry = MEASUREMENT_TYPE_OPTIONS.find(o => o.key === type)?.geo || 'polygon'

  // Live derived for review pane
  const live = useMemo(() => {
    if (scaleInPerPx <= 0 || tracePoints.length === 0) return null
    if (geometry === 'polygon' && tracePoints.length >= 3) {
      let s = 0
      for (let i = 0; i < tracePoints.length; i++) {
        const [x1, y1] = tracePoints[i]
        const [x2, y2] = tracePoints[(i + 1) % tracePoints.length]
        s += x1 * y2 - x2 * y1
      }
      const px = Math.abs(s) / 2
      return { area_sqft: round((px * scaleInPerPx ** 2) / 144, 1) }
    }
    if (geometry === 'rect' && tracePoints.length === 2) {
      const [a, b] = tracePoints
      const w_px = Math.abs(b[0] - a[0])
      const h_px = Math.abs(b[1] - a[1])
      const w_in = w_px * scaleInPerPx
      const h_in = h_px * scaleInPerPx
      return {
        width_in: round(w_in, 1),
        height_in: round(h_in, 1),
        united_inches: round(w_in + h_in, 1),
        area_sqft: round((w_in * h_in) / 144, 2),
      }
    }
    if (geometry === 'polyline' && tracePoints.length >= 2) {
      let total = 0
      for (let i = 0; i < tracePoints.length - 1; i++) {
        const dx = tracePoints[i + 1][0] - tracePoints[i][0]
        const dy = tracePoints[i + 1][1] - tracePoints[i][1]
        total += Math.sqrt(dx * dx + dy * dy)
      }
      return { length_ft: round((total * scaleInPerPx) / 12, 2) }
    }
    if (geometry === 'point' && tracePoints.length === 1) {
      return { marked: true }
    }
    return null
  }, [geometry, tracePoints, scaleInPerPx])

  // ---- Event handlers ----
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
      if (scaleEndpoints.length >= 2) setScaleEndpoints([pt])
      else setScaleEndpoints(prev => [...prev, pt])
      return
    }
    if (phase === 'trace') {
      if (geometry === 'point') {
        setTracePoints([pt])
      } else if (geometry === 'rect' && tracePoints.length >= 2) {
        setTracePoints([pt])
      } else {
        setTracePoints(prev => [...prev, pt])
      }
    }
  }, [phase, scaleEndpoints.length, geometry, tracePoints.length, evToPixel])

  const advance = useCallback(() => {
    if (phase === 'scale' && scaleEndpoints.length === 2) {
      setPhase('trace')
      return
    }
    if (phase === 'trace') {
      const ok =
        (geometry === 'polygon' && tracePoints.length >= 3) ||
        (geometry === 'rect' && tracePoints.length === 2) ||
        (geometry === 'polyline' && tracePoints.length >= 2) ||
        (geometry === 'point' && tracePoints.length === 1)
      if (ok) setPhase('review')
    }
  }, [phase, scaleEndpoints.length, geometry, tracePoints.length])

  const save = useCallback(async () => {
    if (!selectedPhoto) { setError('Pick a photo first.'); return }
    if (scaleInPerPx <= 0 && type !== 'corner_inside' && type !== 'corner_outside') {
      setError('Set a scale reference first.'); return
    }
    setSaving(true)
    setError(null)
    try {
      const payload: Parameters<typeof api.exterior.createMeasurement>[0] = {
        job_id: jobId,
        photo_id: selectedPhoto.id,
        measurement_type: type,
        elevation,
        facade_id: facadeId || undefined,
        material_type: (type === 'wall' ? material : undefined),
        reference_object: refKey,
        reference_height_in: refKey === 'custom' ? customInches : refInches,
        reference_pixel_h: scalePixelH || undefined,
        notes: notes || undefined,
      }
      if (geometry === 'polygon' || geometry === 'polyline') {
        payload.region_polygon = tracePoints
      } else if (geometry === 'rect') {
        payload.region_polygon = tracePoints
        if (live && 'width_in' in live) {
          payload.width_in = live.width_in
          payload.height_in = live.height_in
        }
      } else if (geometry === 'point') {
        payload.region_polygon = tracePoints
      }
      await api.exterior.createMeasurement(payload)
      // Reset
      setTracePoints([])
      setPhase('scale')
      setScaleEndpoints([])
      setNotes('')
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }, [selectedPhoto, jobId, type, elevation, facadeId, material, refKey, refInches, customInches,
      scalePixelH, scaleInPerPx, tracePoints, live, geometry, notes, onSaved])

  // ---- Render ----
  if (!selectedPhoto) {
    return (
      <div className="rounded border border-amber-400/30 bg-amber-500/10 p-4 text-sm text-amber-100">
        Upload at least one photo before tracing measurements.
      </div>
    )
  }

  return (
    <div className="space-y-3 rounded-lg border border-white/10 bg-slate-900/40 p-4">
      {/* Photo + type picker */}
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <select
          value={selectedPhotoId ?? ''}
          onChange={e => setSelectedPhotoId(e.target.value)}
          className="rounded bg-slate-800 px-2 py-1 text-slate-100"
        >
          {photos.map(p => (
            <option key={p.id} value={p.id}>
              {p.classified_elevation ?? 'unknown'} — {(p as any).original_filename || p.id.slice(0, 6)}
            </option>
          ))}
        </select>
        <select
          value={type}
          onChange={e => setType(e.target.value as MeasurementType)}
          className="rounded bg-slate-800 px-2 py-1 text-slate-100"
        >
          {MEASUREMENT_TYPE_OPTIONS.map(o => (
            <option key={o.key} value={o.key}>{o.label}</option>
          ))}
        </select>
        <select
          value={elevation}
          onChange={e => setElevation(e.target.value as typeof elevation)}
          className="rounded bg-slate-800 px-2 py-1 text-slate-100"
        >
          {['front', 'right', 'rear', 'left', 'other'].map(e => (
            <option key={e} value={e}>{e}</option>
          ))}
        </select>
        {type === 'wall' && (
          <select
            value={material}
            onChange={e => setMaterial(e.target.value)}
            className="rounded bg-slate-800 px-2 py-1 text-slate-100"
          >
            {MATERIAL_TYPES.map(m => <option key={m} value={m}>{m.replace('_', ' ')}</option>)}
          </select>
        )}
        <input
          placeholder="Facade ID (SI-1, W-103, D-1…)"
          value={facadeId}
          onChange={e => setFacadeId(e.target.value)}
          className="w-44 rounded bg-slate-800 px-2 py-1 text-slate-100"
        />
      </div>

      {/* Phase pills */}
      <div className="flex flex-wrap gap-2 text-xs">
        {(['scale', 'trace', 'review'] as Phase[]).map((p, i) => (
          <button
            key={p}
            onClick={() => {
              if (p === 'trace' && scaleInPerPx <= 0 && !(type === 'corner_inside' || type === 'corner_outside')) return
              if (p === 'review' && tracePoints.length < 1) return
              setPhase(p)
            }}
            className={`rounded-full px-3 py-1 ${
              phase === p ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
            }`}
          >{i + 1}. {p}</button>
        ))}
      </div>

      {/* Scale controls */}
      {phase === 'scale' && (
        <div className="space-y-2 rounded border border-white/10 bg-slate-800/40 p-3 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-slate-400">Reference:</label>
            <select
              value={refKey}
              onChange={e => setRefKey(e.target.value as typeof REFERENCE_OPTIONS[number]['key'])}
              className="rounded bg-slate-800 px-2 py-1 text-slate-100"
            >
              {REFERENCE_OPTIONS.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
            {refKey === 'custom' && (
              <input
                type="number" min={1} step={1}
                value={customInches}
                onChange={e => setCustomInches(Number(e.target.value))}
                className="w-24 rounded bg-slate-800 px-2 py-1 text-slate-100"
              />
            )}
            <span className="text-slate-500">Click TOP then BOTTOM of the reference object.</span>
          </div>
          {scaleEndpoints.length === 2 && (
            <div className="rounded bg-emerald-500/15 px-2 py-1 text-emerald-300">
              Scale: {refInches}" over {scalePixelH.toFixed(0)} px = {scaleInPerPx.toFixed(3)} in/px
            </div>
          )}
          {scaleEndpoints.length === 2 && (
            <button
              onClick={advance}
              className="rounded bg-blue-600 px-3 py-1.5 text-white hover:bg-blue-500"
            >Next: trace {geometry} →</button>
          )}
        </div>
      )}

      {/* Trace controls */}
      {phase === 'trace' && (
        <div className="space-y-2 rounded border border-white/10 bg-slate-800/40 p-3 text-xs">
          <div className="text-slate-400">
            {geometry === 'polygon' && 'Click points around the region. At least 3.'}
            {geometry === 'rect' && 'Click the top-left then bottom-right corners.'}
            {geometry === 'polyline' && 'Click along the trim run. At least 2 points.'}
            {geometry === 'point' && 'Click once to mark the corner location.'}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setTracePoints(prev => prev.slice(0, -1))}
              disabled={tracePoints.length === 0}
              className="rounded bg-slate-700 px-2 py-1 text-slate-200 hover:bg-slate-600 disabled:opacity-50"
            >Undo</button>
            <button
              onClick={() => setTracePoints([])}
              disabled={tracePoints.length === 0}
              className="rounded bg-slate-700 px-2 py-1 text-slate-200 hover:bg-slate-600 disabled:opacity-50"
            >Clear</button>
            <button
              onClick={advance}
              className="rounded bg-emerald-600 px-3 py-1 text-white hover:bg-emerald-500"
            >Finish ({tracePoints.length} pts) →</button>
          </div>
          {live && (
            <div className="text-emerald-300">
              Live: {Object.entries(live).map(([k, v]) => `${k}=${v}`).join(' · ')}
            </div>
          )}
        </div>
      )}

      {/* Review + save */}
      {phase === 'review' && (
        <div className="space-y-2 rounded border border-emerald-400/30 bg-emerald-500/10 p-3 text-xs">
          {live && (
            <div className="text-emerald-200">
              {Object.entries(live).map(([k, v]) => (
                <div key={k}><strong>{k.replace('_', ' ')}:</strong> {String(v)}</div>
              ))}
            </div>
          )}
          <textarea
            placeholder="Notes (optional)"
            value={notes}
            onChange={e => setNotes(e.target.value)}
            className="h-14 w-full rounded bg-slate-800 px-2 py-1 text-slate-100"
          />
          <button
            onClick={save}
            disabled={saving}
            className="rounded bg-blue-600 px-3 py-1.5 text-white hover:bg-blue-500 disabled:opacity-50"
          >{saving ? 'Saving…' : 'Save measurement'}</button>
        </div>
      )}

      {/* Photo canvas */}
      <div className="relative max-h-[600px] overflow-hidden rounded-lg border border-white/10 bg-black">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={selectedPhoto.photo_url}
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
          {scaleEndpoints.length >= 1 && (
            <>
              {scaleEndpoints.length === 2 && (
                <line
                  x1={scaleEndpoints[0][0]} y1={scaleEndpoints[0][1]}
                  x2={scaleEndpoints[1][0]} y2={scaleEndpoints[1][1]}
                  stroke="#fbbf24" strokeWidth={4} strokeLinecap="round"
                />
              )}
              {scaleEndpoints.map((p, i) => (
                <circle key={i} cx={p[0]} cy={p[1]} r={8} fill="#fbbf24" stroke="white" strokeWidth={2} />
              ))}
            </>
          )}

          {/* Trace */}
          {tracePoints.length > 0 && (
            <g>
              {geometry === 'polygon' && tracePoints.length >= 3 && (
                <polygon
                  points={tracePoints.map(p => `${p[0]},${p[1]}`).join(' ')}
                  fill="rgba(34,197,94,0.18)"
                  stroke="#22c55e"
                  strokeWidth={3}
                />
              )}
              {geometry === 'polygon' && tracePoints.length >= 2 && tracePoints.length < 3 && (
                <polyline
                  points={tracePoints.map(p => `${p[0]},${p[1]}`).join(' ')}
                  fill="none" stroke="#22c55e" strokeWidth={3} strokeDasharray="6 4"
                />
              )}
              {geometry === 'rect' && tracePoints.length === 2 && (
                <rect
                  x={Math.min(tracePoints[0][0], tracePoints[1][0])}
                  y={Math.min(tracePoints[0][1], tracePoints[1][1])}
                  width={Math.abs(tracePoints[1][0] - tracePoints[0][0])}
                  height={Math.abs(tracePoints[1][1] - tracePoints[0][1])}
                  fill="rgba(99,102,241,0.18)" stroke="#6366f1" strokeWidth={3}
                />
              )}
              {geometry === 'polyline' && tracePoints.length >= 2 && (
                <polyline
                  points={tracePoints.map(p => `${p[0]},${p[1]}`).join(' ')}
                  fill="none" stroke="#22c55e" strokeWidth={4}
                />
              )}
              {tracePoints.map((p, i) => (
                <circle
                  key={i} cx={p[0]} cy={p[1]} r={6} fill="white"
                  stroke={geometry === 'rect' ? '#6366f1' : '#22c55e'} strokeWidth={2}
                />
              ))}
            </g>
          )}
        </svg>
      </div>

      {error && <p className="text-xs text-rose-400">{error}</p>}
    </div>
  )
}

function round(v: number, dec: number): number {
  const f = 10 ** dec
  return Math.round(v * f) / f
}

export default MeasurementTraceTool
