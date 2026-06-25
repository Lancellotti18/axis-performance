'use client'

/**
 * Axis Performance — Manual siding measurement tool.
 *
 * Honest workflow for what a top-down satellite cannot measure. Contractor:
 *   1. Uploads a ground-level elevation photo
 *   2. Marks a known reference object (door/garage door/window) by dragging the
 *      two ends of its known dimension → gives scale (inches per pixel)
 *   3. Traces the siding region as a polygon
 *   4. Picks elevation + material
 *   5. Saves — area = pixel area × scale²
 *
 * The interaction layer matches the roof editor: ZOOM (wheel / buttons),
 * PAN (drag), and DRAGGABLE vertices so a misplaced point is nudged, never
 * restarted. The report always labels these "contractor-entered, not
 * satellite-measured".
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '@/lib/api'

type Pt = [number, number]
type Phase = 'upload' | 'scale' | 'trace' | 'review'
type Drag = { kind: 'scale' | 'trace'; i: number } | null

const REFERENCE_OPTIONS = [
  { key: 'standard_door_80', label: 'Standard door (80″)', inches: 80 },
  { key: 'garage_door_84', label: 'Garage door height (84″)', inches: 84 },
  { key: 'garage_door_w_16', label: 'Double garage width (192″)', inches: 192 },
  { key: 'window_36', label: 'Standard window (36″)', inches: 36 },
  { key: 'custom', label: 'Custom…', inches: 0 },
] as const

const MATERIAL_TYPES = ['vinyl', 'fiber_cement', 'wood', 'brick', 'stone', 'stucco', 'metal', 'other']
const ELEVATIONS = ['front', 'rear', 'left', 'right', 'other'] as const

const MIN_ZOOM = 1
const MAX_ZOOM = 12

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
  const [scaleEndpoints, setScaleEndpoints] = useState<Pt[]>([])
  const [tracePoly, setTracePoly] = useState<Pt[]>([])
  const [elevation, setElevation] = useState<typeof ELEVATIONS[number]>('front')
  const [material, setMaterial] = useState<string>('vinyl')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // View transform (zoom/pan). Markers live INSIDE a scaled group, so the image
  // and overlays zoom together; vertex sizes divide by zoom to stay constant.
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState<Pt>([0, 0])           // in image-pixel units
  const [drag, setDrag] = useState<Drag>(null)
  const [cursor, setCursor] = useState<Pt | null>(null)

  const fileRef = useRef<HTMLInputElement | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const panRef = useRef<{ sx: number; sy: number; px: number; py: number; moved: boolean } | null>(null)

  // ----- derived scale + area -----
  const refInches = useMemo(() => {
    if (refKey === 'custom') return Math.max(1, customInches)
    return REFERENCE_OPTIONS.find(o => o.key === refKey)?.inches ?? 80
  }, [refKey, customInches])

  const scalePixelH = useMemo(() => {
    if (scaleEndpoints.length !== 2) return 0
    const [a, b] = scaleEndpoints
    return Math.hypot(a[0] - b[0], a[1] - b[1])
  }, [scaleEndpoints])

  const scaleInPerPx = useMemo(() => (scalePixelH > 0 ? refInches / scalePixelH : 0), [refInches, scalePixelH])

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
    return Math.round((pixelArea * scaleInPerPx ** 2 / 144) * 10) / 10
  }, [pixelArea, scaleInPerPx])

  // ----- view helpers -----
  const clampPan = useCallback((px: number, py: number, z: number): Pt => {
    const minX = imageDims.w * (1 - z)
    const minY = imageDims.h * (1 - z)
    return [Math.min(0, Math.max(minX, px)), Math.min(0, Math.max(minY, py))]
  }, [imageDims])

  const resetView = useCallback(() => { setZoom(1); setPan([0, 0]) }, [])

  // screen → image-pixel coordinate (inverts the group transform)
  const evToPixel = useCallback((clientX: number, clientY: number): Pt | null => {
    const svg = svgRef.current
    if (!svg || imageDims.w === 0) return null
    const r = svg.getBoundingClientRect()
    const rawX = ((clientX - r.left) / r.width) * imageDims.w
    const rawY = ((clientY - r.top) / r.height) * imageDims.h
    return [(rawX - pan[0]) / zoom, (rawY - pan[1]) / zoom]
  }, [imageDims, pan, zoom])

  const zoomAt = useCallback((clientX: number, clientY: number, factor: number) => {
    const svg = svgRef.current
    if (!svg || imageDims.w === 0) return
    const r = svg.getBoundingClientRect()
    const rawX = ((clientX - r.left) / r.width) * imageDims.w
    const rawY = ((clientY - r.top) / r.height) * imageDims.h
    setZoom(prevZ => {
      const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, prevZ * factor))
      setPan(prevP => {
        const ix = (rawX - prevP[0]) / prevZ
        const iy = (rawY - prevP[1]) / prevZ
        return clampPan(rawX - z * ix, rawY - z * iy, z)
      })
      return z
    })
  }, [imageDims, clampPan])

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.18 : 1 / 1.18)
  }, [zoomAt])

  const zoomCenter = useCallback((factor: number) => {
    const r = svgRef.current?.getBoundingClientRect()
    if (!r) return
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor)
  }, [zoomAt])

  // distance under which a click on the FIRST trace point closes the polygon
  const closeDist = useMemo(() => (Math.max(imageDims.w, imageDims.h) || 1000) * 0.02 / zoom, [imageDims, zoom])
  const nearFirst = useCallback((p: Pt) => {
    if (tracePoly.length < 3) return false
    return Math.hypot(p[0] - tracePoly[0][0], p[1] - tracePoly[0][1]) < closeDist
  }, [tracePoly, closeDist])

  // ----- pointer handling (pan vs click; vertex drag is separate) -----
  const onBgPointerDown = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return
    panRef.current = { sx: e.clientX, sy: e.clientY, px: pan[0], py: pan[1], moved: false }
    svgRef.current?.setPointerCapture(e.pointerId)
  }, [pan])

  const onPointerMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    const p = evToPixel(e.clientX, e.clientY)
    if (p) setCursor(p)

    if (drag && p) {
      if (drag.kind === 'scale') setScaleEndpoints(prev => prev.map((q, i) => i === drag.i ? p : q))
      else setTracePoly(prev => prev.map((q, i) => i === drag.i ? p : q))
      return
    }
    const pr = panRef.current
    if (pr) {
      const dx = e.clientX - pr.sx
      const dy = e.clientY - pr.sy
      if (!pr.moved && Math.hypot(dx, dy) > 4) pr.moved = true
      if (pr.moved) {
        const r = svgRef.current!.getBoundingClientRect()
        const vdx = (dx / r.width) * imageDims.w
        const vdy = (dy / r.height) * imageDims.h
        setPan(clampPan(pr.px + vdx, pr.py + vdy, zoom))
      }
    }
  }, [drag, evToPixel, imageDims, clampPan, zoom])

  const onPointerUp = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (drag) { setDrag(null); return }
    const pr = panRef.current
    panRef.current = null
    if (pr && !pr.moved) {
      // a real click (not a pan) → place a point
      const p = evToPixel(e.clientX, e.clientY)
      if (!p) return
      if (phase === 'scale') {
        setScaleEndpoints(prev => (prev.length >= 2 ? [p] : [...prev, p]))
      } else if (phase === 'trace') {
        if (nearFirst(p)) { setPhase('review'); return }
        setTracePoly(prev => [...prev, p])
      }
    }
  }, [drag, evToPixel, phase, nearFirst])

  const startVertexDrag = useCallback((e: React.PointerEvent, kind: 'scale' | 'trace', i: number) => {
    e.stopPropagation()
    if (e.button !== 0) return
    setDrag({ kind, i })
    svgRef.current?.setPointerCapture(e.pointerId)
  }, [])

  // ----- file -----
  const onFileChange = useCallback((ev: React.ChangeEvent<HTMLInputElement>) => {
    const f = ev.target.files?.[0]
    if (!f) return
    if (!f.type.startsWith('image/')) { setError('Please upload an image (JPG/PNG/HEIC).'); return }
    setImageUrl(URL.createObjectURL(f))
    setScaleEndpoints([]); setTracePoly([]); resetView()
    setPhase('scale'); setError(null)
  }, [resetView])

  const onImageLoad = useCallback((ev: React.SyntheticEvent<HTMLImageElement>) => {
    const img = ev.currentTarget
    setImageDims({ w: img.naturalWidth, h: img.naturalHeight })
  }, [])

  // reset view when changing phase so the user is never lost zoomed-in
  useEffect(() => { resetView() }, [phase, resetView])

  const save = useCallback(async () => {
    if (tracePoly.length < 3) { setError('Trace at least 3 points around the siding region.'); return }
    if (scaleInPerPx <= 0) { setError('Set a reference scale first.'); return }
    setSaving(true); setError(null)
    try {
      const result = await api.roofing.v2.addSidingMeasurement({
        project_id: projectId,
        elevation,
        reference_object: refKey,
        reference_height_in: refInches,
        reference_pixel_h: scalePixelH,
        region_polygon: tracePoly,
        material_type: material,
        notes: notes || undefined,
      })
      onSaved?.(result)
      setPhase('upload'); setImageUrl(null)
      setScaleEndpoints([]); setTracePoly([]); setNotes('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }, [projectId, elevation, refKey, refInches, scalePixelH, tracePoly, material, notes, onSaved, scaleInPerPx])

  // ----- render -----
  const M = Math.max(imageDims.w, imageDims.h) || 1000
  const vr = (M * 0.012) / zoom            // vertex radius — constant on screen
  const hitR = (M * 0.03) / zoom           // generous invisible grab radius
  const sw = (M * 0.004) / zoom            // stroke width
  const transform = `translate(${pan[0]} ${pan[1]}) scale(${zoom})`
  const showClose = phase === 'trace' && cursor != null && nearFirst(cursor)

  return (
    <div className="space-y-4 rounded-lg border border-white/10 bg-slate-900/40 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">Siding measurement</h3>
          <p className="text-xs text-slate-400">
            Trace siding on a ground photo with a known-size reference. Contractor-entered
            (not a satellite measurement) — labeled that way on the report.
          </p>
        </div>
        <span className="shrink-0 rounded border border-amber-400/30 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-300">
          manual
        </span>
      </div>

      <SidingGuide />
      {phase !== 'upload' && <SidingStepHint phase={phase} />}

      {/* Phase pills */}
      <div className="flex flex-wrap gap-2 text-xs">
        {(['upload', 'scale', 'trace', 'review'] as Phase[]).map((p, i) => {
          const locked =
            (p === 'scale' && !imageUrl) ||
            (p === 'trace' && scaleInPerPx <= 0) ||
            (p === 'review' && tracePoly.length < 3)
          return (
            <button
              key={p}
              onClick={() => { if (!locked) setPhase(p) }}
              disabled={locked}
              className={`rounded-full px-3 py-1 capitalize ${
                phase === p ? 'bg-blue-600 text-white'
                  : locked ? 'cursor-not-allowed bg-slate-800/50 text-slate-600'
                  : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
              }`}
            >{i + 1}. {p}</button>
          )
        })}
      </div>

      {/* Upload */}
      {phase === 'upload' && (
        <div className="rounded-lg border-2 border-dashed border-white/15 p-8 text-center">
          <input ref={fileRef} type="file" accept="image/*" onChange={onFileChange} className="hidden" />
          <button
            onClick={() => fileRef.current?.click()}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-500"
          >Upload elevation photo</button>
          <p className="mx-auto mt-3 max-w-md text-xs text-slate-500">
            Stand square-on to the wall in good light. Keep a <strong>door, garage door, or window</strong>
            {' '}fully in frame — you&apos;ll use it to set scale. You can zoom in after to place points precisely.
          </p>
        </div>
      )}

      {/* Phase guidance + controls */}
      {imageUrl && phase !== 'upload' && (
        <>
          {phase === 'scale' && (
            <div className="space-y-2 rounded border border-white/10 bg-slate-800/40 p-3 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-slate-200">1.</span>
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
                    type="number" min={1} step={1} value={customInches}
                    onChange={e => setCustomInches(Number(e.target.value))}
                    className="w-24 rounded bg-slate-800 px-2 py-1 text-slate-100"
                  />
                )}
                {refKey === 'custom' && <span className="text-slate-500">inches</span>}
              </div>
              <p className="text-slate-400">
                <span className="font-semibold text-slate-200">2.</span> Click the two ends of that {refInches}″ dimension on the photo
                (e.g. top &amp; bottom of the door). <strong>Drag either dot to fine-tune.</strong> Zoom in for accuracy.
              </p>
              {scaleEndpoints.length === 2 && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded bg-emerald-500/15 px-2 py-1 text-emerald-300">
                    Scale: {refInches}″ ÷ {scalePixelH.toFixed(0)}px = {scaleInPerPx.toFixed(3)} in/px
                  </span>
                  <button onClick={() => setScaleEndpoints([])} className="rounded bg-slate-700 px-2 py-1 text-slate-200 hover:bg-slate-600">Redo</button>
                  <button onClick={() => setPhase('trace')} className="rounded bg-blue-600 px-3 py-1 text-white hover:bg-blue-500">Next: trace siding →</button>
                </div>
              )}
            </div>
          )}

          {phase === 'trace' && (
            <div className="space-y-2 rounded border border-white/10 bg-slate-800/40 p-3 text-xs">
              <p className="text-slate-400">
                Click around the siding region — each click drops a point. <strong>Drag any point to adjust.</strong>
                {tracePoly.length >= 3 && <> Click the <span className="text-emerald-300">first point</span> to close.</>}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <button onClick={() => setTracePoly(prev => prev.slice(0, -1))} disabled={!tracePoly.length}
                  className="rounded bg-slate-700 px-2 py-1 text-slate-200 hover:bg-slate-600 disabled:opacity-40">Undo</button>
                <button onClick={() => setTracePoly([])} disabled={!tracePoly.length}
                  className="rounded bg-slate-700 px-2 py-1 text-slate-200 hover:bg-slate-600 disabled:opacity-40">Clear</button>
                {tracePoly.length >= 3 && (
                  <>
                    <button onClick={() => setPhase('review')} className="rounded bg-emerald-600 px-3 py-1 text-white hover:bg-emerald-500">Finish ({tracePoly.length}) →</button>
                    <span className="text-emerald-300">Live: <strong>{liveAreaSqft.toLocaleString()} ft²</strong></span>
                  </>
                )}
              </div>
            </div>
          )}

          {phase === 'review' && (
            <div className="space-y-2 rounded border border-emerald-400/30 bg-emerald-500/10 p-3 text-xs">
              <div className="text-emerald-200">
                Siding area: <strong>{liveAreaSqft.toLocaleString()} ft²</strong> @ {scaleInPerPx.toFixed(3)} in/px.
                {' '}<button onClick={() => setPhase('trace')} className="underline hover:text-white">edit shape</button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <label className="text-slate-300">Elevation:</label>
                <select value={elevation} onChange={e => setElevation(e.target.value as typeof ELEVATIONS[number])}
                  className="rounded bg-slate-800 px-2 py-1 capitalize text-slate-100">
                  {ELEVATIONS.map(e => <option key={e} value={e}>{e}</option>)}
                </select>
                <label className="text-slate-300">Material:</label>
                <select value={material} onChange={e => setMaterial(e.target.value)}
                  className="rounded bg-slate-800 px-2 py-1 text-slate-100">
                  {MATERIAL_TYPES.map(m => <option key={m} value={m}>{m.replace('_', ' ')}</option>)}
                </select>
              </div>
              <textarea placeholder="Notes (optional)" value={notes} onChange={e => setNotes(e.target.value)}
                className="h-14 w-full rounded bg-slate-800 px-2 py-1 text-slate-100" />
              <button onClick={save} disabled={saving}
                className="rounded bg-blue-600 px-3 py-1.5 text-white hover:bg-blue-500 disabled:opacity-50">
                {saving ? 'Saving…' : 'Save siding measurement'}
              </button>
            </div>
          )}

          {/* Zoom toolbar */}
          <div className="flex items-center gap-1 text-xs">
            <button onClick={() => zoomCenter(1.18)} className="rounded bg-slate-800 px-2 py-1 text-slate-200 hover:bg-slate-700" title="Zoom in">＋</button>
            <button onClick={() => zoomCenter(1 / 1.18)} className="rounded bg-slate-800 px-2 py-1 text-slate-200 hover:bg-slate-700" title="Zoom out">－</button>
            <button onClick={resetView} className="rounded bg-slate-800 px-2 py-1 text-slate-200 hover:bg-slate-700">Fit</button>
            <span className="ml-1 text-slate-500">{zoom.toFixed(1)}× · wheel to zoom · drag empty area to pan</span>
          </div>

          {/* Canvas */}
          <div className="relative w-full overflow-hidden rounded-lg border border-white/10 bg-black"
            style={{ aspectRatio: `${imageDims.w || 4} / ${imageDims.h || 3}`, maxHeight: '70vh' }}>
            {/* hidden loader for natural dims */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={imageUrl} alt="" className="hidden" onLoad={onImageLoad} />
            <svg
              ref={svgRef}
              viewBox={`0 0 ${imageDims.w || 1} ${imageDims.h || 1}`}
              preserveAspectRatio="xMidYMid meet"
              className="absolute inset-0 h-full w-full touch-none"
              style={{ cursor: drag ? 'grabbing' : phase === 'review' ? 'default' : 'crosshair' }}
              onWheel={onWheel}
              onPointerDown={onBgPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={() => setCursor(null)}
            >
              <g transform={transform}>
                <image href={imageUrl} x={0} y={0} width={imageDims.w} height={imageDims.h} preserveAspectRatio="none" />

                {/* Scale line */}
                {scaleEndpoints.length === 2 && (
                  <line x1={scaleEndpoints[0][0]} y1={scaleEndpoints[0][1]}
                    x2={scaleEndpoints[1][0]} y2={scaleEndpoints[1][1]}
                    stroke="#fbbf24" strokeWidth={sw} strokeLinecap="round" />
                )}
                {phase !== 'review' && scaleEndpoints.map((p, i) => (
                  <g key={`s${i}`}>
                    <circle cx={p[0]} cy={p[1]} r={hitR} fill="transparent"
                      style={{ cursor: 'grab' }}
                      onPointerDown={e => startVertexDrag(e, 'scale', i)} />
                    <circle cx={p[0]} cy={p[1]} r={vr} fill="#fbbf24" stroke="white" strokeWidth={sw / 2} pointerEvents="none" />
                  </g>
                ))}

                {/* Trace polygon */}
                {tracePoly.length > 0 && (
                  <>
                    {tracePoly.length >= 3 ? (
                      <polygon points={tracePoly.map(p => `${p[0]},${p[1]}`).join(' ')}
                        fill="rgba(34,197,94,0.18)" stroke="#22c55e" strokeWidth={sw} />
                    ) : (
                      <polyline points={tracePoly.map(p => `${p[0]},${p[1]}`).join(' ')}
                        fill="none" stroke="#22c55e" strokeWidth={sw} strokeDasharray={`${sw * 2} ${sw * 1.5}`} />
                    )}
                    {/* rubber-band to cursor while tracing */}
                    {phase === 'trace' && cursor && (
                      <line x1={tracePoly[tracePoly.length - 1][0]} y1={tracePoly[tracePoly.length - 1][1]}
                        x2={cursor[0]} y2={cursor[1]} stroke="#22c55e" strokeWidth={sw} strokeDasharray={`${sw} ${sw}`} opacity={0.6} />
                    )}
                    {tracePoly.map((p, i) => (
                      <g key={`t${i}`}>
                        <circle cx={p[0]} cy={p[1]} r={hitR} fill="transparent"
                          style={{ cursor: 'grab' }}
                          onPointerDown={e => startVertexDrag(e, 'trace', i)} />
                        <circle cx={p[0]} cy={p[1]}
                          r={i === 0 && showClose ? vr * 1.7 : vr}
                          fill={i === 0 && showClose ? '#22c55e' : 'white'}
                          stroke="#22c55e" strokeWidth={sw / 2} pointerEvents="none" />
                      </g>
                    ))}
                  </>
                )}
              </g>
            </svg>
          </div>
        </>
      )}

      {error && <p className="text-xs text-rose-400">{error}</p>}
    </div>
  )
}

/** Upfront playbook so the tool isn't a mystery — what it does, the 4 steps,
 *  how many photos, and how to shoot them. Mirrors the roof photo playbook. */
function SidingGuide() {
  const [open, setOpen] = useState(true)
  return (
    <div className="rounded-md border border-blue-400/20 bg-blue-500/5">
      <button onClick={() => setOpen(o => !o)} className="flex w-full items-center justify-between px-3 py-2 text-left text-xs">
        <span className="font-semibold text-blue-200">📐 How siding measurement works — read first</span>
        <span className="text-slate-400">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className="space-y-2.5 border-t border-blue-400/10 px-3 py-2.5 text-[11px] text-slate-300">
          <p className="text-slate-400">
            A satellite tile can&apos;t measure walls, so siding is measured from a <strong>straight-on
            ground photo</strong> of each wall. You give it scale with a known-size object, trace the wall,
            and it computes the square footage. <strong>Do one wall at a time</strong> and repeat for each side.
          </p>
          <ol className="space-y-1.5">
            <li><strong className="text-white">1 · Upload</strong> a square-on photo of one wall (front, back, left, or right). Keep a <strong>door, garage door, or window fully in frame</strong> — that&apos;s your scale reference.</li>
            <li><strong className="text-white">2 · Scale</strong> — pick what the reference is (e.g. standard door = 80″), then click its two ends on the photo (top &amp; bottom of the door). This tells the tool how big a pixel is.</li>
            <li><strong className="text-white">3 · Trace</strong> the siding area — click around the wall; trace <strong>around big windows/garage doors</strong> to leave them out. Drag any point to adjust.</li>
            <li><strong className="text-white">4 · Review &amp; save</strong> — set the elevation + material, check the ft², and save. Then upload the next wall.</li>
          </ol>
          <div className="rounded border border-amber-400/20 bg-amber-500/5 p-2 text-amber-200/90">
            <strong>For the best accuracy:</strong> stand back and square-on (not at an angle), shoot in daylight,
            and pick the <em>biggest</em> reference object in frame (a garage door beats a window) — bigger reference = less scale error.
          </div>
          <p className="text-slate-500">A typical house = <strong>4 walls = 4 photos</strong>. One-story ranch may only need the visible faces; skip walls with no siding.</p>
        </div>
      )}
    </div>
  )
}

/** A one-line "you are here" banner for the current phase. */
function SidingStepHint({ phase }: { phase: Phase }) {
  const hint =
    phase === 'scale' ? 'Step 2 of 4 — set the scale: choose your reference object, then click its two ends on the photo.'
      : phase === 'trace' ? 'Step 3 of 4 — trace the wall: click around the siding; trace around windows/garage to exclude them.'
      : phase === 'review' ? 'Step 4 of 4 — review & save: set elevation + material, then save and move to the next wall.'
      : ''
  if (!hint) return null
  return (
    <div className="rounded-md border border-blue-400/20 bg-blue-500/5 px-3 py-1.5 text-[11px] font-medium text-blue-200">
      {hint}
    </div>
  )
}

export default SidingMeasurementTool
