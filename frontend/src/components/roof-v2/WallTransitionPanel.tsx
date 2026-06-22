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

interface Transition {
  p0: [number, number]
  p1: [number, number]
  kind: 'wall' | 'dormer'
  confidence: number
  reason: string
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

// Match tolerances (image fractions / cosine).
const MAX_MIDPOINT_DIST = 0.06
const MIN_DIR_SIMILARITY = 0.66

function mid(a: [number, number], b: [number, number]): [number, number] {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
}
function unit(a: [number, number], b: [number, number]): [number, number] {
  const dx = b[0] - a[0], dy = b[1] - a[1]
  const n = Math.hypot(dx, dy) || 1
  return [dx / n, dy / n]
}

/** Find the facet edge that best matches a detected transition segment. */
function matchEdge(t: Transition, facets: Facet[], edges: LabeledEdge[]): EdgeKey | null {
  const segMid = mid(t.p0, t.p1)
  const segDir = unit(t.p0, t.p1)
  let best: EdgeKey | null = null
  let bestScore = Infinity
  for (const e of edges) {
    const f = facets.find(x => x.label === e.facetLabel)
    if (!f || f.polygon.length < 2) continue
    const a = f.polygon[e.vertexIndexStart]
    const b = f.polygon[e.vertexIndexEnd]
    if (!a || !b) continue
    const eMid = mid(a as [number, number], b as [number, number])
    const eDir = unit(a as [number, number], b as [number, number])
    const dist = Math.hypot(segMid[0] - eMid[0], segMid[1] - eMid[1])
    const dirSim = Math.abs(segDir[0] * eDir[0] + segDir[1] * eDir[1])
    if (dist <= MAX_MIDPOINT_DIST && dirSim >= MIN_DIR_SIMILARITY) {
      const score = dist + (1 - dirSim) * 0.1
      if (score < bestScore) { bestScore = score; best = edgeKey(e.facetLabel, e.vertexIndexStart) }
    }
  }
  return best
}

export default function WallTransitionPanel({
  runId, facets, edges, imageUrl, imageWidthPx = 2048, imageHeightPx = 1366, onApplyEdges,
}: Props) {
  const [transitions, setTransitions] = useState<Transition[]>([])
  const [message, setMessage] = useState<string | null>(null)
  const [reason, setReason] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ran, setRan] = useState(false)
  const [applied, setApplied] = useState(false)
  const [ground, setGround] = useState<Awaited<ReturnType<typeof api.roofing.v2.getGroundFindings>>['findings'] | null>(null)
  const [showCandidates, setShowCandidates] = useState(false)
  const [labeledKeys, setLabeledKeys] = useState<Set<EdgeKey>>(new Set())

  // Pull the ground-photo findings so we can corroborate / prompt with what the
  // photos actually saw (a roof-to-wall abutment, dormers).
  useEffect(() => {
    let cancelled = false
    api.roofing.v2.getGroundFindings(runId)
      .then(r => { if (!cancelled) setGround(r.findings) })
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

  // Precompute the edge match for each transition.
  const matches = useMemo(
    () => transitions.map(t => matchEdge(t, facets, edges)),
    [transitions, facets, edges],
  )
  const matchableCount = matches.filter(Boolean).length

  const detect = useCallback(async () => {
    setLoading(true); setError(null); setApplied(false)
    try {
      const res = await api.roofing.v2.detectWallTransitions(runId)
      setTransitions(res.transitions)
      setMessage(res.message)
      setReason(res.reason || null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Detection failed')
    } finally {
      setLoading(false); setRan(true)
    }
  }, [runId])

  const applyAll = useCallback(() => {
    const keys = new Set(matches.filter(Boolean) as EdgeKey[])
    if (keys.size === 0) return
    const updated = edges.map(e =>
      keys.has(edgeKey(e.facetLabel, e.vertexIndexStart))
        ? { ...e, edgeType: 'wall_intersection' as const, userConfirmed: true }
        : e,
    )
    onApplyEdges(updated)
    setApplied(true)
  }, [matches, edges, onApplyEdges])

  return (
    <section className="rounded-lg border border-white/10 bg-slate-900/40 p-4 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">Roof-to-wall transitions</h3>
          <p className="text-xs text-slate-400">
            AI finds where the roof meets a wall or dormer. Accepting labels the matching edge as
            <strong> wall_intersection</strong> — flashing is then derived automatically.
          </p>
        </div>
        <button
          onClick={detect}
          disabled={loading}
          className="rounded bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-500 disabled:opacity-50"
        >{loading ? 'Detecting…' : ran ? 'Re-detect' : 'Detect transitions'}</button>
      </div>

      {error && <p className="mt-2 text-xs text-rose-400">{error}</p>}
      {message && !error && <p className="mt-2 text-xs text-slate-400">{message}</p>}

      {/* Bridge: ground photo detected a condition → highlight the likely roof
          edges so the contractor confirms with one tap (no flaky satellite). */}
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

      {transitions.length > 0 && (
        <>
          <div className="mt-3 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wide text-amber-300">
              {transitions.length} found · {matchableCount} match a traced edge
            </span>
            <button
              onClick={applyAll}
              disabled={matchableCount === 0 || applied}
              className="rounded bg-emerald-700 px-2 py-1 text-xs text-white hover:bg-emerald-600 disabled:opacity-40"
            >{applied ? 'Applied ✓' : `Label ${matchableCount} edge${matchableCount === 1 ? '' : 's'}`}</button>
          </div>
          <ul className="mt-2 space-y-1.5">
            {transitions.map((t, i) => {
              const matched = matches[i]
              return (
                <li key={i} className="flex items-center gap-3 rounded-md border border-white/10 p-2">
                  {imageUrl ? (
                    <TransitionThumb
                      imageUrl={imageUrl} imgW={imageWidthPx} imgH={imageHeightPx}
                      p0={t.p0} p1={t.p1}
                      color={t.kind === 'dormer' ? '#a855f7' : '#f59e0b'}
                    />
                  ) : (
                    <span
                      className="inline-block h-3 w-3 shrink-0 rounded-full"
                      style={{ background: t.kind === 'dormer' ? '#a855f7' : '#f59e0b' }}
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium capitalize text-slate-100">{t.kind}</span>
                      <span className="text-[10px] text-slate-400">{Math.round(t.confidence * 100)}%</span>
                      {matched ? (
                        <span className="rounded bg-emerald-900/40 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-300">
                          → {matched.split(':')[0]}
                        </span>
                      ) : (
                        <span className="rounded bg-slate-700 px-1.5 py-0.5 text-[9px] text-slate-300" title="No traced edge nearby — draw/adjust the facet edge then re-detect">
                          no edge match
                        </span>
                      )}
                    </div>
                    <div className="truncate text-[11px] text-slate-400">{t.reason}</div>
                  </div>
                </li>
              )
            })}
          </ul>
          {matchableCount === 0 && (
            <p className="mt-2 text-[11px] text-slate-500">
              None of the detected transitions line up with a traced facet edge yet. Make sure the
              facet whose edge abuts the wall/dormer is drawn, then re-detect.
            </p>
          )}
        </>
      )}

      {ran && !loading && transitions.length === 0 && !error && (
        <p className="mt-3 text-xs text-slate-500">
          {reason || 'No roof-to-wall transitions detected. If the roof has dormers or meets a taller wall, label those edges manually as wall_intersection.'}
        </p>
      )}
    </section>
  )
}
