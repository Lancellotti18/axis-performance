'use client'

/**
 * WallTransitionPanel — Phase 2 of flashing intelligence.
 *
 * Calls /detect-wall-transitions, which has Gemini find the line segments where
 * the roof meets a wall or dormer cheek. Each detected segment is matched to the
 * NEAREST traced facet edge (by midpoint distance + direction similarity);
 * accepting a transition re-labels that edge as 'wall_intersection', which the
 * deterministic flashing engine immediately turns into step/counter/apron/
 * kickout flashing.
 *
 * This removes the one manual step the flashing engine depended on: the
 * contractor no longer has to know which edges are roof-to-wall transitions.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '@/lib/api'
import type { Facet, LabeledEdge } from './RoofFacetEditor'

interface EdgeCandidate {
  facetLabel: string
  vertexIndexStart: number
  vertexIndexEnd: number
  p0: [number, number]
  p1: [number, number]
  reason: string
}

function ptsClose(a: [number, number], b: [number, number], eps = 0.012): boolean {
  return Math.hypot(a[0] - b[0], a[1] - b[1]) <= eps
}

/** Geometric candidates for roof-to-wall edges, from the traced shape alone:
 *  a NON-shared edge (not a ridge/hip/valley between two facets) that ISN'T the
 *  facet's lowest edge (the eave) — i.e. a horizontal-ish edge that likely dies
 *  into a wall. More reliable than the satellite vision because it uses the
 *  actual geometry; the contractor still confirms with one tap. */
function wallEdgeCandidates(facets: Facet[], edges: LabeledEdge[]): EdgeCandidate[] {
  const segs = facets.flatMap(f =>
    f.polygon.map((_, i) => ({
      label: f.label, i,
      a: f.polygon[i] as [number, number],
      b: f.polygon[(i + 1) % f.polygon.length] as [number, number],
    })),
  )
  const isShared = (s: (typeof segs)[number]) => segs.some(o =>
    o.label !== s.label &&
    ((ptsClose(o.a, s.a) && ptsClose(o.b, s.b)) || (ptsClose(o.a, s.b) && ptsClose(o.b, s.a))),
  )
  const out: (EdgeCandidate & { score: number })[] = []
  for (const f of facets) {
    const n = f.polygon.length
    if (n < 3) continue
    let eaveI = -1, maxY = -Infinity
    for (let i = 0; i < n; i++) {
      const a = f.polygon[i], b = f.polygon[(i + 1) % n]
      const my = (a[1] + b[1]) / 2
      if (my > maxY) { maxY = my; eaveI = i }
    }
    for (let i = 0; i < n; i++) {
      if (i === eaveI) continue
      const a = f.polygon[i] as [number, number]
      const b = f.polygon[(i + 1) % n] as [number, number]
      if (isShared({ label: f.label, i, a, b })) continue
      const e = edges.find(x => x.facetLabel === f.label && x.vertexIndexStart === i)
      if (e && e.edgeType !== 'unlabeled' && e.edgeType !== 'eave' && e.edgeType !== 'rake') continue
      const dx = Math.abs(b[0] - a[0]), dy = Math.abs(b[1] - a[1])
      const horizontal = dx >= dy
      const len = Math.hypot(b[0] - a[0], b[1] - a[1])
      const score = (horizontal ? 1 : 0.2) + (1 - Math.min(len, 0.5) / 0.5) * 0.5
      out.push({
        facetLabel: f.label, vertexIndexStart: i, vertexIndexEnd: (i + 1) % n,
        p0: a, p1: b, score,
        reason: horizontal ? 'Non-eave horizontal edge — likely meets a wall' : 'Interior/sloped edge — possible abutment',
      })
    }
  }
  return out.sort((x, y) => y.score - x.score).slice(0, 6)
}

interface Props {
  runId: string
  facets: Facet[]
  edges: LabeledEdge[]
  imageUrl?: string
  imageWidthPx?: number
  imageHeightPx?: number
  onApplyEdges: (updated: LabeledEdge[]) => void
}

/** Cropped tile thumbnail with the detected transition segment highlighted. */
function TransitionThumb({
  imageUrl, imgW, imgH, p0, p1, color,
}: {
  imageUrl: string; imgW: number; imgH: number
  p0: [number, number]; p1: [number, number]; color: string
}) {
  const ax = p0[0] * imgW, ay = p0[1] * imgH
  const bx = p1[0] * imgW, by = p1[1] * imgH
  const midX = (ax + bx) / 2, midY = (ay + by) / 2
  const half = Math.max(Math.hypot(bx - ax, by - ay) * 1.2, 70)
  let x = midX - half, y = midY - half
  let w = half * 2, h = half * 2
  if (x < 0) x = 0
  if (y < 0) y = 0
  if (x + w > imgW) w = imgW - x
  if (y + h > imgH) h = imgH - y
  return (
    <svg viewBox={`${x} ${y} ${w} ${h}`} className="h-14 w-14 shrink-0 rounded border border-white/10 bg-black">
      <image href={imageUrl} x={0} y={0} width={imgW} height={imgH} preserveAspectRatio="none" />
      <line x1={ax} y1={ay} x2={bx} y2={by} stroke={color} strokeWidth={w * 0.04} strokeLinecap="round" opacity={0.95} />
    </svg>
  )
}

type EdgeKey = string   // `${facetLabel}:${vertexIndexStart}`
const edgeKey = (facetLabel: string, vstart: number): EdgeKey => `${facetLabel}:${vstart}`

export default function WallTransitionPanel({
  runId, facets, edges, imageUrl, imageWidthPx = 2048, imageHeightPx = 1366, onApplyEdges,
}: Props) {
  const [ground, setGround] = useState<Awaited<ReturnType<typeof api.roofing.v2.getGroundFindings>>['findings'] | null>(null)
  const [showCandidates, setShowCandidates] = useState(false)
  const [labeledKeys, setLabeledKeys] = useState<Set<EdgeKey>>(new Set())

  // Pull the ground-photo findings so we can corroborate / prompt with what the
  // photos actually saw (a roof-to-wall abutment, dormers).
  useEffect(() => {
    let cancelled = false
    api.roofing.v2.getGroundFindings(runId)
      .then(r => {
        if (cancelled) return
        setGround(r.findings)
        if (r.findings?.wall_abutment?.present || (r.findings?.dormers ?? 0) > 0) {
          setShowCandidates(true)
        }
      })
      .catch(() => { /* best-effort */ })
    return () => { cancelled = true }
  }, [runId])

  const candidates = useMemo(() => wallEdgeCandidates(facets, edges), [facets, edges])
  const photoWall = !!ground?.wall_abutment?.present
  const photoDormers = ground?.dormers ?? 0
  const expectedEdges = (photoWall ? 1 : 0) + photoDormers * 2

  const labelOneEdge = useCallback((c: EdgeCandidate) => {
    const updated = edges.map(e =>
      e.facetLabel === c.facetLabel && e.vertexIndexStart === c.vertexIndexStart
        ? { ...e, edgeType: 'wall_intersection' as const, userConfirmed: true }
        : e)
    onApplyEdges(updated)
    setLabeledKeys(prev => new Set(prev).add(edgeKey(c.facetLabel, c.vertexIndexStart)))
  }, [edges, onApplyEdges])

  return (
    <section id="roof-to-wall-panel" className="rounded-lg border border-white/10 bg-slate-900/40 p-4 text-sm scroll-mt-16">
      <div>
        <h3 className="text-sm font-semibold text-slate-100">Roof-to-wall transitions</h3>
        <p className="text-xs text-slate-400">
          Where the roof meets a wall or dormer (step flashing). Driven by your <strong>ground photos</strong> —
          they detect the condition, then you confirm the matching roof edge with one tap.
        </p>
      </div>

      {/* Ground photo detected a condition → highlight the likely roof edges so
          the contractor confirms with one tap. */}
      {(photoWall || photoDormers > 0) && (
        <div className="mt-3 rounded-md border border-emerald-400/30 bg-emerald-500/5 p-2.5 text-[11px]">
          <div className="text-emerald-200">
            📷 Your ground photo detected{' '}
            {photoWall && <strong>a roof-to-wall abutment</strong>}
            {photoWall && photoDormers > 0 && ' and '}
            {photoDormers > 0 && <strong>{photoDormers} dormer(s)</strong>}
            {' '}→ needs step flashing (~{expectedEdges} edge{expectedEdges === 1 ? '' : 's'} to label).
          </div>
          <button
            onClick={() => setShowCandidates(s => !s)}
            disabled={candidates.length === 0}
            className="mt-1.5 rounded bg-emerald-700 px-2 py-1 text-[11px] font-semibold text-white hover:bg-emerald-600 disabled:opacity-40"
          >{showCandidates ? 'Hide likely edges' : `Show ${candidates.length} likely wall edge${candidates.length === 1 ? '' : 's'}`}</button>
          {candidates.length === 0 && (
            <span className="ml-2 text-slate-500">Trace the facet that meets the wall first, then this lights up.</span>
          )}
        </div>
      )}

      {showCandidates && candidates.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {candidates.map((c, i) => {
            const done = labeledKeys.has(edgeKey(c.facetLabel, c.vertexIndexStart))
            return (
              <li key={i} className="flex items-center gap-3 rounded-md border border-white/10 p-2">
                {imageUrl && (
                  <TransitionThumb
                    imageUrl={imageUrl} imgW={imageWidthPx} imgH={imageHeightPx}
                    p0={c.p0} p1={c.p1} color="#10b981"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-slate-100">Facet {c.facetLabel}</span>
                    <span className="text-[10px] text-slate-400">edge {c.vertexIndexStart}</span>
                  </div>
                  <div className="truncate text-[11px] text-slate-400">{c.reason}</div>
                </div>
                <button
                  onClick={() => labelOneEdge(c)}
                  disabled={done}
                  className="shrink-0 rounded bg-emerald-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
                >{done ? 'Labeled ✓' : 'Label as wall'}</button>
              </li>
            )
          })}
        </ul>
      )}

    </section>
  )
}
