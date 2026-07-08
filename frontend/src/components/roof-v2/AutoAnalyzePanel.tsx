'use client'

/**
 * AutoAnalyzePanel — ⚡ the whole detection pipeline in one shot, so the
 * contractor VERIFIES a drawn roof instead of tracing one:
 *
 *   1. Roof planes — best available source wins:
 *        a. Google Solar × building outline: each Solar plane (measured
 *           pitch) is CLIPPED to the OSM footprint (offset outward ~1.5 ft
 *           for roof overhang), so outer facet edges land on the real roof
 *           edge instead of floating rectangles.
 *        b. Solar bboxes alone (no footprint coverage).
 *        c. Footprint outline alone (no Solar coverage).
 *        d. AI vision detection on the satellite tile.
 *   2. Edge labels — the geometric auto-labeler runs on the result.
 *
 * With `autoStart`, it runs ITSELF the first time the editor opens on an
 * untraced roof (once per run) — zero clicks before "review what AI found".
 * Everything it adds is a normal editable facet/suggestion.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'

import { api } from '@/lib/api'
import { clipPolygonToRect, offsetPolygon, polygonArea, weldPolygons, type Pt } from '@/lib/polyclip'
import type { Facet } from './RoofFacetEditor'
import { geoToFrac } from './SolarAssistPanel'

type StepStatus = 'idle' | 'running' | 'done' | 'skipped' | 'failed'
interface StepState { id: string; label: string; status: StepStatus; detail?: string }

interface Props {
  runId: string
  centerLat?: number | null
  centerLng?: number | null
  imageWidthPx: number
  imageHeightPx: number
  feetPerPixel: number
  facetCount: number
  /** Add facets into the editor (same path the Solar/AI panels use). */
  onAddFacets: (facets: Facet[]) => void | Promise<void>
  /** Kick the edge auto-labeler (bumps the trigger + scrolls to the panel). */
  onAutoLabel: () => void
  /** Run automatically (once per run) when the roof is untraced. */
  autoStart?: boolean
  /** Bump to force a re-run (e.g. after the contractor taps their house —
   *  the lookup anchor changed, so the sources must be re-queried). */
  trigger?: number
  /** House not confirmed yet — hold auto-analysis and say why. Drawing the
   *  neighbor's roof is worse than waiting one tap. */
  awaitingHouse?: boolean
}

const LABELS = ['RF-1', 'RF-2', 'RF-3', 'RF-4', 'RF-5', 'RF-6', 'RF-7', 'RF-8', 'RF-9', 'RF-10', 'RF-11', 'RF-12']
const OVERHANG_FT = 1.5           // typical eave overhang past the wall line
const MIN_FACET_AREA_FRAC = 0.0002   // ≈ 90 ft² on a standard tile — rejects clip slivers
// Wrong-building guard: geocodes drift onto streets/neighbors, and Solar/OSM
// return whichever building is nearest that drifted point. The subject house
// sits at (near) the tile center after auto-centering, so geometry whose
// centroid lands farther than this is treated as the WRONG building and the
// source is skipped rather than drawn.
const MAX_OFF_CENTER_FT = 90

export default function AutoAnalyzePanel({
  runId, centerLat, centerLng, imageWidthPx, imageHeightPx, feetPerPixel,
  facetCount, onAddFacets, onAutoLabel, autoStart = false, trigger, awaitingHouse = false,
}: Props) {
  const [running, setRunning] = useState(false)
  const [steps, setSteps] = useState<StepState[]>([])

  const setStep = useCallback((id: string, patch: Partial<StepState>) => {
    setSteps(prev => prev.map(s => (s.id === id ? { ...s, ...patch } : s)))
  }, [])

  const run = useCallback(async () => {
    if (running) return
    setRunning(true)
    setSteps([
      { id: 'facets', label: 'Detect roof planes', status: 'running' },
      { id: 'labels', label: 'Label every edge', status: 'idle' },
    ])

    try {
      // ---- Step 1: facets --------------------------------------------------
      let added = 0
      if (facetCount > 0) {
        setStep('facets', { status: 'skipped', detail: `${facetCount} facet(s) already traced — keeping yours` })
      } else {
        let source = ''
        let rejectedNote = ''
        const geoReady = centerLat != null && centerLng != null && feetPerPixel > 0
        const toFrac = (la: number, ln: number): Pt =>
          geoToFrac(la, ln, centerLat as number, centerLng as number, imageWidthPx, imageHeightPx, feetPerPixel)
        const offCenterFt = (pts: Pt[]): number => {
          let cx = 0, cy = 0
          for (const [x, y] of pts) { cx += x; cy += y }
          cx /= pts.length; cy /= pts.length
          return Math.hypot((cx - 0.5) * imageWidthPx * feetPerPixel, (cy - 0.5) * imageHeightPx * feetPerPixel)
        }

        if (geoReady) {
          // Fetch BOTH sources in parallel (each cached server-side).
          const [solarRes, fpRes] = await Promise.allSettled([
            api.roofing.v2.getSolar(runId),
            api.roofing.v2.getFootprint(runId),
          ])
          const solar = solarRes.status === 'fulfilled' && solarRes.value.available ? solarRes.value : null
          const fp = fpRes.status === 'fulfilled' && fpRes.value.available ? fpRes.value : null
          const segs = solar?.segments || []

          // Footprint ring → image fractions, expanded for roof overhang.
          // Offset happens in PIXEL space (fractions are anisotropic).
          let fpFrac: Pt[] = []
          if (fp?.ring && fp.ring.length >= 3) {
            const px: Pt[] = fp.ring.map(p => {
              const [fx, fy] = toFrac(p.lat, p.lng)
              return [fx * imageWidthPx, fy * imageHeightPx]
            })
            const grown = offsetPolygon(px, OVERHANG_FT / feetPerPixel)
            fpFrac = grown.map(([x, y]) => [
              Math.max(0, Math.min(1, x / imageWidthPx)),
              Math.max(0, Math.min(1, y / imageHeightPx)),
            ])
            // Wrong-building guard: outline centered somewhere else → not ours.
            const off = offCenterFt(fpFrac)
            if (off > MAX_OFF_CENTER_FT) {
              fpFrac = []
              rejectedNote = `outline found ${Math.round(off)} ft off-center (likely a neighbor) — skipped; `
                + 'tap YOUR house in the House Picker below, then re-run'
            }
          }

          // Same guard for Solar: findClosest can return the neighbor.
          let solarSegs = segs
          if (solarSegs.length > 0) {
            const corners: Pt[] = solarSegs.flatMap(s => [
              toFrac(s.bbox.ne.lat, s.bbox.sw.lng), toFrac(s.bbox.sw.lat, s.bbox.ne.lng),
            ])
            const off = offCenterFt(corners)
            if (off > MAX_OFF_CENTER_FT) {
              solarSegs = []
              rejectedNote += `${rejectedNote ? ' · ' : ''}Solar returned a building ${Math.round(off)} ft off-center (likely a neighbor) — skipped; `
                + 'tap YOUR house in the House Picker below, then re-run'
            }
          }

          // 1a. BEST: Solar planes clipped to the building outline — outer
          //     edges land on the real roof edge, pitch stays measured.
          if (solarSegs.length > 0 && fpFrac.length >= 3) {
            const facets: Facet[] = []
            for (const s of solarSegs.slice(0, LABELS.length)) {
              const { sw, ne } = s.bbox
              const c1 = toFrac(ne.lat, sw.lng), c2 = toFrac(ne.lat, ne.lng)
              const c3 = toFrac(sw.lat, ne.lng), c4 = toFrac(sw.lat, sw.lng)
              const xs = [c1[0], c2[0], c3[0], c4[0]], ys = [c1[1], c2[1], c3[1], c4[1]]
              const clipped = clipPolygonToRect(fpFrac, Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys))
              const poly: Pt[] = clipped.length >= 3 && polygonArea(clipped) >= MIN_FACET_AREA_FRAC
                ? clipped
                : [c1, c2, c3, c4]          // degenerate clip → keep the bbox
              facets.push({
                label: LABELS[facets.length],
                polygon: poly,
                pitch: s.pitch || '6/12',
                confidence: 0.75,
                userConfirmed: false,
              })
            }
            if (facets.length > 0) {
              // Weld near-coincident seam vertices (±3.5 ft) so adjacent
              // planes truly SHARE edges — the edge auto-labeler's shared-edge
              // and corner-angle logic depends on exact coincidence, and
              // sloppy seams were the source of hip↔eave / ridge↔rake slips.
              const tolX = 3.5 / feetPerPixel / imageWidthPx
              const tolY = 3.5 / feetPerPixel / imageHeightPx
              const welded = weldPolygons(facets.map(f => f.polygon as Pt[]), tolX, tolY)
              const cleaned = facets
                .map((f, i) => ({ ...f, polygon: welded[i] }))
                .filter(f => f.polygon.length >= 3)
              await onAddFacets(cleaned)
              added = cleaned.length
              source = `Google Solar × building outline — ${added} plane(s), measured pitch, snapped to the roof edge`
            }
          }

          // 1b. Solar only (no footprint coverage) → bbox rectangles.
          if (added === 0 && solarSegs.length > 0) {
            const facets: Facet[] = solarSegs.slice(0, LABELS.length).map((s, i) => {
              const { sw, ne } = s.bbox
              return {
                label: LABELS[i],
                polygon: [toFrac(ne.lat, sw.lng), toFrac(ne.lat, ne.lng), toFrac(sw.lat, ne.lng), toFrac(sw.lat, sw.lng)],
                pitch: s.pitch || '6/12',
                confidence: 0.7,
                userConfirmed: false,
              }
            })
            await onAddFacets(facets)
            added = facets.length
            source = `Google Solar — ${added} plane(s), measured pitch (no outline data here)`
          }

          // 1c. Footprint only (no Solar coverage) → whole-roof outline.
          if (added === 0 && fpFrac.length >= 3) {
            await onAddFacets([{ label: LABELS[0], polygon: fpFrac, pitch: '6/12', confidence: 0.6, userConfirmed: false }])
            added = 1
            source = 'Building outline (overhang-adjusted) — split it into planes'
          }
        }

        // 1d. AI vision detection on the satellite tile.
        if (added === 0) {
          const res = await api.roofing.v2.suggestFacets(runId)
          const polys = (res.facets || []).filter(f => (f.polygon || []).length >= 3)
          if (polys.length > 0) {
            const facets: Facet[] = polys.slice(0, LABELS.length).map((f, i) => ({
              label: LABELS[i],
              polygon: f.polygon,
              pitch: f.predicted_pitch || '6/12',
              confidence: f.confidence ?? 0.5,
              userConfirmed: false,
            }))
            await onAddFacets(facets)
            added = facets.length
            source = `AI vision — ${added} plane(s) detected`
          } else {
            setStep('facets', { status: 'failed', detail: [rejectedNote, res.reason].filter(Boolean).join(' · ') || 'Nothing detected — trace the roof manually (it takes ~a minute)' })
            setStep('labels', { status: 'skipped', detail: 'Needs facets first' })
            setRunning(false)
            return
          }
        }
        setStep('facets', { status: 'done', detail: rejectedNote ? `${source} · (${rejectedNote})` : source })
      }

      // ---- Step 2: edge labels ----------------------------------------------
      setStep('labels', { status: 'running' })
      // Small delay so the facet state + persistence settles before labeling.
      await new Promise(r => setTimeout(r, 600))
      onAutoLabel()
      setStep('labels', { status: 'done', detail: 'Suggestions ready below — review & accept' })
      toast.success('Auto-analysis complete — verify the planes, drag any vertex that needs it, accept the labels.')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Auto-analysis failed')
    } finally {
      setRunning(false)
    }
  }, [running, facetCount, centerLat, centerLng, imageWidthPx, imageHeightPx, feetPerPixel, runId, onAddFacets, onAutoLabel, setStep])

  // ---- Zero-click start: run once per run when the roof is untraced --------
  const runRef = useRef(run)
  useEffect(() => { runRef.current = run }, [run])
  useEffect(() => {
    if (!autoStart || facetCount > 0) return
    const key = `axis_autoanalyzed_${runId}`
    try {
      if (sessionStorage.getItem(key)) return
      sessionStorage.setItem(key, '1')
    } catch { /* private mode: still run, just without the guard */ }
    const t = setTimeout(() => { void runRef.current() }, 800)
    return () => clearTimeout(t)
  }, [autoStart, facetCount, runId])

  // Forced re-run (house tapped → anchor changed → re-query the sources).
  const firstTrigger = useRef(true)
  useEffect(() => {
    if (firstTrigger.current) { firstTrigger.current = false; return }
    void runRef.current()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger])

  const icon = (s: StepStatus) =>
    s === 'done' ? '✓' : s === 'running' ? '…' : s === 'failed' ? '✕' : s === 'skipped' ? '↷' : '·'
  const tone = (s: StepStatus) =>
    s === 'done' ? 'text-emerald-300' : s === 'running' ? 'text-blue-300'
      : s === 'failed' ? 'text-rose-300' : s === 'skipped' ? 'text-slate-400' : 'text-slate-600'

  return (
    <section className={`rounded-lg border p-4 text-sm ${
      facetCount === 0 ? 'border-blue-400/40 bg-blue-500/10' : 'border-white/10 bg-slate-900/40'
    }`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">⚡ Auto-analyze this roof</h3>
          <p className="text-xs text-slate-400">
            {awaitingHouse
              ? <>⬆ <strong className="text-blue-200">Confirm your house above first.</strong> Analysis starts automatically the moment you lock it in — that tap is what guarantees we measure YOUR roof, not the neighbor&apos;s.</>
              : running
                ? 'Drawing the roof for you — planes snapped to the building edge, pitch from solar data…'
                : 'AI draws the roof (Solar planes clipped to the real building outline) and labels every edge — you just verify and nudge.'}
          </p>
        </div>
        <button
          onClick={run}
          disabled={running || awaitingHouse}
          title={awaitingHouse ? 'Confirm your house in the picker above first' : undefined}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-[0_0_16px_rgba(59,130,246,0.4)] transition hover:bg-blue-500 disabled:opacity-50"
        >{running ? 'Analyzing…' : awaitingHouse ? 'Waiting for house…' : facetCount > 0 ? '⚡ Re-run analysis' : '⚡ Auto-analyze'}</button>
      </div>

      {steps.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs">
          {steps.map(s => (
            <li key={s.id} className="flex items-center gap-2">
              <span className={`w-4 text-center font-bold ${tone(s.status)}`}>{icon(s.status)}</span>
              <span className={s.status === 'running' ? 'text-blue-200' : 'text-slate-300'}>{s.label}</span>
              {s.detail && <span className="text-slate-500">— {s.detail}</span>}
              {s.status === 'running' && <span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-blue-400 border-t-transparent" />}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
