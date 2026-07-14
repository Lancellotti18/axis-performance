'use client'

/**
 * ScaleCheckPanel — reference-object scale verification.
 *
 * Satellite scale (metres/pixel from the tile zoom) is usually right, but when
 * it's wrong it's silently wrong — and every measurement inherits the error
 * (a 10% scale error = 21% area error). This tool lets the contractor click the
 * two ends of a KNOWN-size object (a garage door, a car) and compare what the
 * current scale says that distance is against the real length. It surfaces the
 * discrepancy and records the reference-derived scale on the run.
 *
 * It does NOT silently rewrite existing measurements (that re-scale is a careful
 * follow-up) — it tells the contractor whether to trust the numbers or re-fetch
 * imagery, so a bad scale never ships unnoticed.
 */
import { useCallback, useRef, useState } from 'react'
import toast from 'react-hot-toast'

import { api } from '@/lib/api'

interface Props {
  runId: string
  imageUrl: string
  imageWidthPx: number
  imageHeightPx: number
  /** feet-per-pixel the measurement pipeline uses (imagery.feet_per_pixel) */
  feetPerPixel: number
  /** A scale reference saved on a previous visit (shown on project resume). */
  savedScaleDescription?: string | null
}

type Pt = [number, number]   // image fractions

// TOP-DOWN references only — things you can actually see and measure from a
// satellite view (horizontal ground features). Vertical features (door/window
// height) and wall-face items don't read from above, so they're excluded.
const PRESETS: { label: string; feet: number }[] = [
  { label: 'Sedan length (15′)', feet: 15 },
  { label: 'Pickup truck length (19′)', feet: 19 },
  { label: 'Vehicle width (6′)', feet: 6 },
  { label: 'Parking stall width (9′)', feet: 9 },
  { label: 'Double garage door — width (16′)', feet: 16 },
]

function fmtFt(v: number): string {
  const f = Math.floor(v); const inch = Math.round((v - f) * 12)
  return inch === 12 ? `${f + 1}′ 0″` : `${f}′ ${inch}″`
}

export default function ScaleCheckPanel({ runId, imageUrl, imageWidthPx, imageHeightPx, feetPerPixel, savedScaleDescription }: Props) {
  const [a, setA] = useState<Pt | null>(null)
  const [b, setB] = useState<Pt | null>(null)
  const [realFeet, setRealFeet] = useState<number>(16)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  const onClick = useCallback((e: React.MouseEvent) => {
    const r = boxRef.current?.getBoundingClientRect()
    if (!r) return
    const fx = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
    const fy = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height))
    if (!a || (a && b)) { setA([fx, fy]); setB(null); setSaved(false) }
    else { setB([fx, fy]) }
  }, [a, b])

  // Pixel distance in the SAME native-pixel basis the pipeline uses.
  const pixelDist = a && b
    ? Math.hypot((b[0] - a[0]) * imageWidthPx, (b[1] - a[1]) * imageHeightPx)
    : 0
  const currentFt = pixelDist * feetPerPixel
  const refPpf = pixelDist > 0 && realFeet > 0 ? pixelDist / realFeet : 0
  const discrepancyPct = realFeet > 0 && currentFt > 0 ? (currentFt - realFeet) / realFeet * 100 : 0
  const areaErrPct = (Math.pow(1 + discrepancyPct / 100, 2) - 1) * 100

  const verdict = Math.abs(discrepancyPct) < 3 ? 'good' : Math.abs(discrepancyPct) < 8 ? 'minor' : 'significant'
  const verdictTone = verdict === 'good' ? 'text-emerald-300' : verdict === 'minor' ? 'text-amber-300' : 'text-rose-300'

  const saveReference = useCallback(async () => {
    if (refPpf <= 0) return
    setSaving(true)
    try {
      await api.roofing.v2.patchRun(runId, {
        pixels_per_foot: Number(refPpf.toFixed(4)),
        scale_method: 'reference_object',
        scale_confidence: 'high',
        scale_reference_description: `${fmtFt(realFeet)} reference (${realFeet} ft) measured on tile`,
      })
      setSaved(true)
      toast.success('Reference scale recorded')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save scale')
    } finally {
      setSaving(false)
    }
  }, [refPpf, realFeet, runId])

  return (
    <section className="rounded-lg border border-white/10 bg-slate-900/40 p-4 text-sm">
      <h3 className="text-sm font-semibold text-slate-100">Scale check</h3>
      {savedScaleDescription && !saved && (
        <div className="mt-2 flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
          <span>✓</span>
          <span>Scale on file from your last visit: <strong>{savedScaleDescription}</strong>. Re-measure below only if the tile changed.</span>
        </div>
      )}
      <p className="mt-2 text-xs text-slate-400">
        Click the two ends of a <strong>standard-size</strong> object on the tile (a parked car is best —
        you can see it clearly from above; avoid driveways/sidewalks, which have no standard size),
        then pick its real size. Confirms whether the imagery scale — and every measurement — is accurate.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_220px]">
        {/* Clickable tile */}
        <div
          ref={boxRef}
          onClick={onClick}
          className="relative w-full cursor-crosshair overflow-hidden rounded border border-white/10 bg-black"
          style={{ aspectRatio: `${imageWidthPx} / ${imageHeightPx}` }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imageUrl} alt="tile" className="absolute inset-0 h-full w-full object-fill" draggable={false} />
          <svg viewBox="0 0 1 1" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
            {a && b && (
              <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="#22d3ee" strokeWidth={0.004} />
            )}
            {a && <circle cx={a[0]} cy={a[1]} r={0.008} fill="#22d3ee" />}
            {b && <circle cx={b[0]} cy={b[1]} r={0.008} fill="#22d3ee" />}
          </svg>
          {!a && (
            <div className="pointer-events-none absolute bottom-1 left-1 rounded bg-black/70 px-2 py-0.5 text-[10px] text-white">
              Click the first end of a known object
            </div>
          )}
          {a && !b && (
            <div className="pointer-events-none absolute bottom-1 left-1 rounded bg-black/70 px-2 py-0.5 text-[10px] text-white">
              Now click the other end
            </div>
          )}
        </div>

        {/* Controls + result */}
        <div className="space-y-2">
          <div className="text-[10px] uppercase tracking-wide text-slate-400">Real-world size</div>
          <div className="flex flex-wrap gap-1">
            {PRESETS.map(p => (
              <button
                key={p.label}
                onClick={() => setRealFeet(p.feet)}
                className={`rounded px-2 py-1 text-[10px] ${realFeet === p.feet ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
              >{p.label}</button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-xs text-slate-300">
            Custom:
            <input
              type="number" min={1} step={0.5} value={realFeet}
              onChange={e => setRealFeet(Number(e.target.value) || 0)}
              className="w-20 rounded border border-slate-700 bg-slate-800 px-2 py-1 text-white"
            /> ft
          </label>

          {a && b ? (
            <div className="rounded-md border border-white/10 bg-slate-900/60 p-2 text-xs">
              <div className="text-slate-400">Current scale says: <span className="font-semibold text-slate-100">{fmtFt(currentFt)}</span></div>
              <div className="text-slate-400">You entered: <span className="font-semibold text-slate-100">{fmtFt(realFeet)}</span></div>
              <div className={`mt-1 font-semibold ${verdictTone}`}>
                {verdict === 'good' && '✓ Scale looks accurate'}
                {verdict === 'minor' && `⚠ Off by ${Math.abs(discrepancyPct).toFixed(0)}%`}
                {verdict === 'significant' && `✕ Off by ${Math.abs(discrepancyPct).toFixed(0)}% — areas ~${Math.abs(areaErrPct).toFixed(0)}% wrong`}
              </div>
              {verdict !== 'good' && (
                <div className="mt-1 text-[10px] text-slate-500">
                  Measurements read {discrepancyPct > 0 ? 'too large' : 'too small'}. Re-fetch imagery (re-center on the house) for a tighter zoom, or proceed knowing this.
                </div>
              )}
              <button
                onClick={saveReference}
                disabled={saving || saved || refPpf <= 0}
                className="mt-2 w-full rounded bg-slate-700 py-1 text-[11px] text-white hover:bg-slate-600 disabled:opacity-40"
              >{saved ? 'Recorded ✓' : saving ? 'Saving…' : 'Record reference scale'}</button>
            </div>
          ) : (
            <div className="rounded-md border border-dashed border-white/10 p-2 text-[11px] text-slate-500">
              Drop two points on the tile to compare.
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
