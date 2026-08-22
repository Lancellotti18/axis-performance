'use client'

/**
 * Axis Performance — AI edge label suggestions.
 *
 * Calls /api/v1/roofing/v2/runs/{id}/edges/suggest-labels with the current
 * facets + unlabeled edges. The backend uses a hybrid approach:
 *   - Geometric deterministic for shared edges (ridge / hip / valley)
 *   - Gemini Vision for unshared edges (eave / rake / gable_end / wall)
 *
 * Each suggestion has a confidence score and short reason ("gutter visible
 * below", "shared with facet B, matching pitch", etc.). Contractor accepts
 * each individually, or steps through them zoomed-in via Review visually.
 * There is deliberately no batch-accept: see the note on acceptAllHighConfidence.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '@/lib/api'
import type { Facet, LabeledEdge, EdgeType } from './RoofFacetEditor'
import { distinctLines, edgeReviewCounts } from './edgeGeometry'
import EdgeReviewModal from './EdgeReviewModal'

interface Suggestion {
  facet_label: string
  vertex_index_start: number
  suggested_edge_type: EdgeType
  confidence: number
  reason: string
  shared_with_facet_label?: string | null
}

interface Props {
  runId: string
  facets: Facet[]
  edges: LabeledEdge[]
  imageUrl?: string
  imageWidthPx?: number
  imageHeightPx?: number
  onAcceptEdges: (updatedEdges: LabeledEdge[]) => void
  // Bump to auto-run the suggestion (e.g. from the editor's toolbar button).
  trigger?: number
}

const EDGE_COLORS: Record<EdgeType, string> = {
  eave: '#fb923c',
  rake: '#60a5fa',
  ridge: '#a78bfa',
  hip: '#34d399',
  valley: '#f87171',
  gable_end: '#fde68a',
  wall_intersection: '#9ca3af',
  unlabeled: 'rgba(255,255,255,0.55)',
}

export function EdgeLabelSuggestions({
  runId, facets, edges, imageUrl, imageWidthPx = 2048, imageHeightPx = 1366, onAcceptEdges, trigger,
}: Props) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reviewing, setReviewing] = useState(false)

  // First-use "how this works" bubble — shown once, reopenable via the ? button.
  const [showHowTo, setShowHowTo] = useState(false)
  useEffect(() => {
    try {
      if (!localStorage.getItem('axis_edge_autolabel_coach_v1')) setShowHowTo(true)
    } catch { /* ignore */ }
  }, [])
  const dismissHowTo = useCallback(() => {
    setShowHowTo(false)
    try { localStorage.setItem('axis_edge_autolabel_coach_v1', '1') } catch { /* ignore */ }
  }, [])

  const unlabeledEdges = useMemo(
    () => edges.filter(e => e.edgeType === 'unlabeled'),
    [edges],
  )

  // Counted in distinct roof lines so these numbers agree with the measurements
  // panel — a shared line is stored once per facet and must not read as two.
  const counts = useMemo(() => edgeReviewCounts(facets, edges), [facets, edges])

  // Edges that DO have a type but nobody signed off on. The suggester ignores
  // them (it only proposes types), so without an explicit action here they were
  // uncleaable: the panel counted them as outstanding while this card said
  // "all edges are labeled ✓" and offered nothing to do about it.
  const unconfirmedLabeled = useMemo(
    () => edges.filter(e => e.edgeType !== 'unlabeled' && !e.userConfirmed),
    [edges],
  )

  const confirmAllLabeled = useCallback(() => {
    onAcceptEdges(edges.map(e => (
      e.edgeType !== 'unlabeled' && !e.userConfirmed ? { ...e, userConfirmed: true } : e
    )))
  }, [edges, onAcceptEdges])

  /**
   * What the visual reviewer steps through: fresh AI proposals when there are
   * any, otherwise the existing labels nobody has signed off on. Deduped to one
   * entry per roof line so a shared edge isn't reviewed twice.
   */
  const reviewSuggestions = useMemo<Suggestion[]>(() => {
    if (suggestions.length > 0) return suggestions
    const pending = new Set(unconfirmedLabeled)
    return distinctLines(facets, edges)
      .filter(e => pending.has(e))
      .map(e => ({
        facet_label: e.facetLabel,
        vertex_index_start: e.vertexIndexStart,
        suggested_edge_type: e.edgeType,
        confidence: 0,
        reason: 'Applied automatically — confirm it, or tap the correct type.',
        shared_with_facet_label: e.sharedWithFacetLabel ?? null,
        existing: true,
      }))
  }, [suggestions, unconfirmedLabeled, facets, edges])

  const runSuggest = useCallback(async () => {
    if (unlabeledEdges.length === 0) {
      setMessage('All edges are already labeled.')
      return
    }
    setLoading(true)
    setError(null)
    setMessage(null)
    try {
      const res = await api.roofing.v2.suggestEdgeLabels(runId, {
        facets: facets.map(f => ({
          label: f.label,
          polygon: f.polygon,
          pitch_degrees: undefined,
        })),
        unlabeled_edges: unlabeledEdges.map(e => ({
          facet_label: e.facetLabel,
          vertex_index_start: e.vertexIndexStart,
          vertex_index_end: e.vertexIndexEnd,
        })),
      })
      setSuggestions(res.suggestions || [])
      setMessage(res.message || null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Edge label suggestion failed')
    } finally {
      setLoading(false)
    }
  }, [runId, facets, unlabeledEdges])

  // Auto-run when the editor's "Auto-label edges" button bumps `trigger`.
  const firstTrigger = useRef(true)
  useEffect(() => {
    if (firstTrigger.current) { firstTrigger.current = false; return }
    void runSuggest()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger])

  const acceptOne = useCallback((s: Suggestion) => {
    const updated = edges.map(e => {
      if (e.facetLabel !== s.facet_label || e.vertexIndexStart !== s.vertex_index_start) {
        return e
      }
      return {
        ...e,
        edgeType: s.suggested_edge_type,
        sharedWithFacetLabel: s.shared_with_facet_label ?? undefined,
        userConfirmed: true,
      }
    })
    onAcceptEdges(updated)
    setSuggestions(prev => prev.filter(
      x => !(x.facet_label === s.facet_label && x.vertex_index_start === s.vertex_index_start),
    ))
  }, [edges, onAcceptEdges])

  const skipOne = useCallback((s: Suggestion) => {
    setSuggestions(prev => prev.filter(
      x => !(x.facet_label === s.facet_label && x.vertex_index_start === s.vertex_index_start),
    ))
  }, [])

  // Retained but intentionally not surfaced. A one-click "accept everything
  // above 70%" makes the contractor the author of every label without them
  // having looked at any — and a mislabeled eave silently inflates by the
  // slope multiplier and walks onto the material order. Per-edge accept keeps
  // the decision where the liability is.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const acceptAllHighConfidence = useCallback((threshold = 0.7) => {
    const accepts = suggestions.filter(s => s.confidence >= threshold)
    if (accepts.length === 0) return
    const updated = edges.map(e => {
      const match = accepts.find(s =>
        s.facet_label === e.facetLabel && s.vertex_index_start === e.vertexIndexStart,
      )
      if (!match) return e
      return {
        ...e,
        edgeType: match.suggested_edge_type,
        sharedWithFacetLabel: match.shared_with_facet_label ?? undefined,
        userConfirmed: true,
      }
    })
    onAcceptEdges(updated)
    setSuggestions(prev => prev.filter(s => s.confidence < threshold))
  }, [suggestions, edges, onAcceptEdges])

  // Group suggestions by facet for readability
  const byFacet = useMemo(() => {
    const m: Record<string, Suggestion[]> = {}
    for (const s of suggestions) {
      ;(m[s.facet_label] = m[s.facet_label] || []).push(s)
    }
    for (const fl of Object.keys(m)) {
      m[fl].sort((a, b) => a.vertex_index_start - b.vertex_index_start)
    }
    return m
  }, [suggestions])

  const highConfidenceCount = suggestions.filter(s => s.confidence >= 0.7).length

  return (
    <section className="rounded-lg border border-white/10 bg-slate-900/40 p-4 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-100">
            ✨ Auto-label edges
            <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-emerald-300">recommended</span>
            <button
              onClick={() => setShowHowTo(v => !v)}
              className="flex h-4 w-4 items-center justify-center rounded-full border border-white/20 text-[10px] text-slate-400 hover:bg-slate-800 hover:text-white"
              title="How does auto-labeling work?"
            >?</button>
          </h3>
          <p className="text-xs text-slate-400">
            One click names every edge — <strong>eave, rake, ridge, hip, valley</strong> — from the
            roof&apos;s geometry. You review and accept; label by hand only where you disagree.
          </p>
        </div>
        {/* Primary call to action only. Once results exist this becomes noise at
            the top of the panel, and Re-analyze lives under the list instead. */}
        {suggestions.length === 0 && (
        <button
          onClick={runSuggest}
          disabled={loading || unlabeledEdges.length === 0}
          title={
            edges.length === 0 ? 'Accept or draw a facet first (step ②) — edges are created from facets.'
              : unlabeledEdges.length === 0 ? 'Every edge already has a label.'
              : `Suggest a type for ${unlabeledEdges.length} unlabeled edge(s).`
          }
          className="rounded bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {loading ? 'Analyzing…'
            : suggestions.length > 0 ? 'Re-analyze'
            : unlabeledEdges.length === 0 ? 'All labeled ✓'
            : `✨ Auto-label ${unlabeledEdges.length} edge${unlabeledEdges.length === 1 ? '' : 's'}`}
        </button>
        )}
      </div>

      {/* How-it-works bubble — first visit + reopenable. */}
      {showHowTo && (
        <div className="mt-3 rounded-lg border border-emerald-400/30 bg-emerald-500/5 p-3 text-xs">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-semibold text-emerald-200">How auto-labeling works</span>
            <button onClick={dismissHowTo} className="rounded p-0.5 text-slate-400 hover:bg-slate-800 hover:text-white" aria-label="Dismiss">✕</button>
          </div>
          <ol className="space-y-1.5 text-slate-300">
            <li className="flex gap-2">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-[10px] font-bold text-white">1</span>
              <span><strong className="text-white">Map out the whole house first.</strong> Trace every roof plane in the editor (or add them with Google Solar / AI auto-detect). The labeler reads how the planes fit together — so the more complete the outline, the smarter the labels.</span>
            </li>
            <li className="flex gap-2">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-[10px] font-bold text-white">2</span>
              <span><strong className="text-white">Click ✨ Auto-label.</strong> Where two planes meet it knows ridge vs hip vs valley from the geometry; outline edges are read as eaves (gutter lines) or rakes (gable sides). Every call shows a confidence % and a plain-English reason.</span>
            </li>
            <li className="flex gap-2">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-[10px] font-bold text-white">3</span>
              <span><strong className="text-white">Review &amp; accept.</strong> Take the edges one at a time, or 🔍 <strong>Review visually</strong> to step through each one zoomed-in. Disagree with one? Fix just that edge in the editor&apos;s <strong>Label by hand</strong> mode.</span>
            </li>
          </ol>
          <p className="mt-2 text-[11px] text-slate-500">
            Labels drive the material order — ridge cap, valley metal, drip edge, flashing — so a quick review here keeps the order right.
          </p>
          <button onClick={dismissHowTo} className="mt-2 w-full rounded bg-emerald-700 py-1.5 text-[11px] font-semibold text-white hover:bg-emerald-600">Got it</button>
        </div>
      )}

      {error && <p className="mt-2 text-xs text-rose-400">{error}</p>}
      {message && !error && <p className="mt-2 text-xs text-slate-400">{message}</p>}

      {/* Explain a disabled button instead of looking broken. */}
      {!loading && unlabeledEdges.length === 0 && (
        edges.length === 0 ? (
          <p className="mt-2 text-xs text-slate-500">
            No edges to label yet — accept or draw a facet first (step ②). Edges are created automatically from each facet.
          </p>
        ) : unconfirmedLabeled.length > 0 ? (
          // Every edge has a type, but some are still the machine's opinion.
          // This is the one place that can clear them, so it says so plainly.
          <div className="mt-2 rounded-lg border border-amber-400/30 bg-amber-500/5 p-3">
            <p className="text-xs text-amber-100/90">
              Every edge has a label, but <strong>{counts.needsConfirm} roof line{counts.needsConfirm === 1 ? '' : 's'}</strong>{' '}
              {counts.needsConfirm === 1 ? 'is' : 'are'} still unconfirmed — labels applied automatically that nobody has
              signed off on. The measurements stay provisional until you do.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                onClick={confirmAllLabeled}
                className="rounded bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-500"
                title="Mark every existing label as reviewed"
              >✓ Confirm all labels</button>
              {imageUrl && (
                <button
                  onClick={() => setReviewing(true)}
                  className="rounded bg-blue-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-blue-500"
                  title="Step through each edge with a zoomed view before confirming"
                >🔍 Review one by one</button>
              )}
            </div>
          </div>
        ) : (
          <p className="mt-2 text-xs text-slate-500">
            All {counts.totalLines} roof line{counts.totalLines === 1 ? '' : 's'} labeled and confirmed ✓ — move on to flashing.
          </p>
        )
      )}

      {suggestions.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-[10px] uppercase tracking-wide text-amber-300">
              {suggestions.length} label{suggestions.length === 1 ? '' : 's'} suggested
            </span>
            <div className="flex gap-2">
              {imageUrl && (
                <button
                  onClick={() => setReviewing(true)}
                  className="rounded bg-blue-600 px-2 py-1 text-xs font-semibold text-white hover:bg-blue-500"
                  title="Step through each edge with a zoomed view of the roof"
                >🔍 Review visually</button>
              )}
            </div>
          </div>
          <ul className="space-y-3">
            {Object.entries(byFacet).map(([facetLabel, sugList]) => (
              <li key={facetLabel}>
                <div className="mb-1 text-xs font-semibold text-slate-300">
                  Facet {facetLabel}
                </div>
                <ul className="space-y-1">
                  {sugList.map((s) => {
                    const confColor =
                      s.confidence >= 0.7 ? 'text-emerald-300'
                      : s.confidence >= 0.5 ? 'text-amber-300'
                      : 'text-rose-300'
                    const color = EDGE_COLORS[s.suggested_edge_type] || EDGE_COLORS.unlabeled
                    return (
                      <li
                        key={`${facetLabel}-${s.vertex_index_start}`}
                        className="flex items-center justify-between gap-2 rounded border border-white/5 bg-slate-800/40 px-2 py-1.5 text-xs"
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className="inline-block h-2 w-4 rounded"
                            style={{ background: color }}
                          />
                          <span className="text-slate-400">
                            edge {s.vertex_index_start}→
                          </span>
                          <strong className="text-slate-100 uppercase">
                            {s.suggested_edge_type.replace('_', ' ')}
                          </strong>
                          <span className={`text-[10px] ${confColor}`}>
                            {(s.confidence * 100).toFixed(0)}%
                          </span>
                          {s.shared_with_facet_label && (
                            <span className="rounded bg-slate-700 px-1 text-[10px] text-slate-300">
                              ↔{s.shared_with_facet_label}
                            </span>
                          )}
                          <span className="text-[10px] text-slate-500">
                            — {s.reason}
                          </span>
                        </div>
                        <div className="flex shrink-0 gap-1">
                          <button
                            onClick={() => acceptOne(s)}
                            className="rounded bg-emerald-600 px-2 py-0.5 text-[10px] text-white hover:bg-emerald-500"
                          >Accept</button>
                          <button
                            onClick={() => skipOne(s)}
                            className="rounded bg-slate-700 px-2 py-0.5 text-[10px] text-slate-200 hover:bg-slate-600"
                          >Skip</button>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </li>
            ))}
          </ul>

          {/* Re-analyze belongs after the results, not above them: by the time
              you want it you have read to the bottom of the list and decided
              the suggestions are wrong. Up top it competed with the labels
              themselves for a first-time user's attention. */}
          <div className="mt-3 flex justify-end border-t border-white/5 pt-3">
            <button
              onClick={runSuggest}
              disabled={loading || unlabeledEdges.length === 0}
              title="Run the labeler again over the edges that are still unlabeled"
              className="rounded border border-white/10 px-2.5 py-1 text-[11px] text-slate-300 hover:bg-white/5 disabled:opacity-40"
            >{loading ? 'Analyzing…' : '↻ Re-analyze'}</button>
          </div>
        </div>
      )}

      {!suggestions.length && !loading && !error && unlabeledEdges.length > 0 && (
        <p className="mt-3 text-xs text-slate-500">
          {unlabeledEdges.length} edge{unlabeledEdges.length === 1 ? '' : 's'} need labels.
          Click <strong>Auto-label</strong> to have AI suggest them all at once.
        </p>
      )}

      {reviewing && imageUrl && (
        <EdgeReviewModal
          imageUrl={imageUrl}
          imageWidthPx={imageWidthPx}
          imageHeightPx={imageHeightPx}
          facets={facets}
          edges={edges}
          suggestions={reviewSuggestions}
          onApply={(updated) => {
            onAcceptEdges(updated)
            // Clear suggestions that are now confirmed in the applied edges.
            const confirmedKeys = new Set(
              updated.filter(e => e.userConfirmed).map(e => `${e.facetLabel}:${e.vertexIndexStart}`),
            )
            setSuggestions(prev => prev.filter(
              s => !confirmedKeys.has(`${s.facet_label}:${s.vertex_index_start}`),
            ))
          }}
          onClose={() => setReviewing(false)}
        />
      )}
    </section>
  )
}

export default EdgeLabelSuggestions
