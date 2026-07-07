'use client'

/**
 * AutoAnalyzePanel — ⚡ one button runs the whole detection pipeline and lands
 * the contractor at a REVIEW screen instead of a build screen:
 *
 *   1. Roof planes — Google Solar (measured pitch) → OSM footprint →
 *      AI vision detection, first source that returns wins.
 *   2. Edge labels — the geometric auto-labeler runs on the result.
 *
 * Everything it adds is a normal editable facet/edge suggestion — the
 * contractor refines vertices and accepts labels exactly as if they'd drawn
 * it, so "review what AI found" replaces "operate five tools in order".
 */
import { useCallback, useState } from 'react'
import toast from 'react-hot-toast'

import { api } from '@/lib/api'
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
}

const LABELS = ['RF-1', 'RF-2', 'RF-3', 'RF-4', 'RF-5', 'RF-6', 'RF-7', 'RF-8', 'RF-9', 'RF-10', 'RF-11', 'RF-12']

export default function AutoAnalyzePanel({
  runId, centerLat, centerLng, imageWidthPx, imageHeightPx, feetPerPixel,
  facetCount, onAddFacets, onAutoLabel,
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
        // 1a. Google Solar — pre-segmented planes with MEASURED pitch.
        if (centerLat != null && centerLng != null && feetPerPixel > 0) {
          try {
            const solar = await api.roofing.v2.getSolar(runId)
            const segs = solar.available ? (solar.segments || []) : []
            if (segs.length > 0) {
              const facets: Facet[] = segs.slice(0, LABELS.length).map((s, i) => {
                const { sw, ne } = s.bbox
                const conv = (la: number, ln: number) =>
                  geoToFrac(la, ln, centerLat, centerLng, imageWidthPx, imageHeightPx, feetPerPixel)
                return {
                  label: LABELS[i],
                  polygon: [conv(ne.lat, sw.lng), conv(ne.lat, ne.lng), conv(sw.lat, ne.lng), conv(sw.lat, sw.lng)],
                  pitch: s.pitch || '6/12',
                  confidence: 0.75,
                  userConfirmed: false,
                }
              })
              await onAddFacets(facets)
              added = facets.length
              source = `Google Solar — ${added} plane(s), measured pitch`
            }
          } catch { /* fall through */ }

          // 1b. OSM building footprint (free, nationwide).
          if (added === 0) {
            try {
              const fp = await api.roofing.v2.getFootprint(runId)
              if (fp.available && fp.ring && fp.ring.length >= 3) {
                const poly = fp.ring.map(p =>
                  geoToFrac(p.lat, p.lng, centerLat, centerLng, imageWidthPx, imageHeightPx, feetPerPixel))
                await onAddFacets([{ label: LABELS[0], polygon: poly, pitch: '6/12', confidence: 0.6, userConfirmed: false }])
                added = 1
                source = 'Building outline (OpenStreetMap) — split it into planes'
              }
            } catch { /* fall through */ }
          }
        }

        // 1c. AI vision detection on the satellite tile.
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
            setStep('facets', { status: 'failed', detail: res.reason || 'Nothing detected — trace the roof manually (it takes ~a minute)' })
            setStep('labels', { status: 'skipped', detail: 'Needs facets first' })
            setRunning(false)
            return
          }
        }
        setStep('facets', { status: 'done', detail: source })
      }

      // ---- Step 2: edge labels ----------------------------------------------
      setStep('labels', { status: 'running' })
      // Small delay so the facet state + persistence settles before labeling.
      await new Promise(r => setTimeout(r, 600))
      onAutoLabel()
      setStep('labels', { status: 'done', detail: 'Suggestions ready below — review & accept' })
      toast.success('Auto-analysis complete — review the results, refine anything, accept the labels.')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Auto-analysis failed')
    } finally {
      setRunning(false)
    }
  }, [running, facetCount, centerLat, centerLng, imageWidthPx, imageHeightPx, feetPerPixel, runId, onAddFacets, onAutoLabel, setStep])

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
            One click: detect the roof planes (Google Solar → building outline → AI vision) and
            label every edge — then you just <strong>review</strong> instead of building from scratch.
          </p>
        </div>
        <button
          onClick={run}
          disabled={running}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-[0_0_16px_rgba(59,130,246,0.4)] transition hover:bg-blue-500 disabled:opacity-50"
        >{running ? 'Analyzing…' : facetCount > 0 ? '⚡ Re-run analysis' : '⚡ Auto-analyze'}</button>
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
