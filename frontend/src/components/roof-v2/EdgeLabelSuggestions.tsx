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
 * each individually or hits "Accept all high-confidence" to batch-apply.
 */
import { useCallback, useMemo, useState } from 'react'
import { api } from '@/lib/api'
import type { Facet, LabeledEdge, EdgeType } from './RoofFacetEditor'
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
  runId, facets, edges, imageUrl, imageWidthPx = 2048, imageHeightPx = 1366, onAcceptEdges,
}: Props) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reviewing, setReviewing] = useState(false)

  const unlabeledEdges = useMemo(
    () => edges.filter(e => e.edgeType === 'unlabeled'),
    [edges],
  )

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
          <h3 className="text-sm font-semibold text-slate-100">Auto-label edges</h3>
          <p className="text-xs text-slate-400">
            AI proposes a type (eave / rake / ridge / hip / valley) for each unlabeled edge.
            Shared edges use deterministic geometry; unshared edges use Gemini Vision.
            <strong> Accept each suggestion individually</strong> or batch-accept high-confidence ones.
          </p>
        </div>
        <button
          onClick={runSuggest}
          disabled={loading || unlabeledEdges.length === 0}
          title={
            edges.length === 0 ? 'Accept or draw a facet first (step ②) — edges are created from facets.'
              : unlabeledEdges.length === 0 ? 'Every edge already has a label.'
              : `Suggest a type for ${unlabeledEdges.length} unlabeled edge(s).`
          }
          className="rounded bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-500 disabled:opacity-50"
        >
          {loading ? 'Analyzing…'
            : suggestions.length > 0 ? 'Re-analyze'
            : unlabeledEdges.length === 0 ? 'All labeled'
            : `Auto-label (${unlabeledEdges.length} unlabeled)`}
        </button>
      </div>

      {error && <p className="mt-2 text-xs text-rose-400">{error}</p>}
      {message && !error && <p className="mt-2 text-xs text-slate-400">{message}</p>}

      {/* Explain a disabled button instead of looking broken. */}
      {!loading && unlabeledEdges.length === 0 && (
        <p className="mt-2 text-xs text-slate-500">
          {edges.length === 0
            ? 'No edges to label yet — accept or draw a facet first (step ②). Edges are created automatically from each facet.'
            : 'All edges are labeled ✓ — nothing to auto-label. Move on to flashing.'}
        </p>
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
              {highConfidenceCount > 0 && (
                <button
                  onClick={() => acceptAllHighConfidence(0.7)}
                  className="rounded bg-emerald-700 px-2 py-1 text-xs text-white hover:bg-emerald-600"
                >Accept all ≥ 70% ({highConfidenceCount})</button>
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
          suggestions={suggestions}
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
