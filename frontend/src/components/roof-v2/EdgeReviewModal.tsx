'use client'

/**
 * EdgeReviewModal — visual, one-edge-at-a-time review of AI edge-label
 * suggestions.
 *
 * The old list view told the contractor "facet RF-2 edge 1 is a ridge (84%)"
 * with no way to see WHICH edge that is. This modal shows a zoomed crop of the
 * satellite tile centered on the specific edge, with the edge highlighted, the
 * AI's classification + confidence + reasoning, and one-tap accept / reclassify
 * / skip. Stepping through all suggestions takes seconds.
 *
 * Every confirmed (accepted or reclassified) edge is written back through
 * onApply → the run's edges are persisted with user_confirmed=true, which fires
 * the roof_edges Postgres trigger that captures it into training_examples. So
 * each review action seeds the future custom edge-classifier.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Facet, LabeledEdge, EdgeType } from './RoofFacetEditor'

export interface EdgeSuggestion {
  facet_label: string
  vertex_index_start: number
  suggested_edge_type: EdgeType
  confidence: number
  reason: string
  shared_with_facet_label?: string | null
}

interface Props {
  imageUrl: string
  imageWidthPx: number
  imageHeightPx: number
  facets: Facet[]
  edges: LabeledEdge[]
  suggestions: EdgeSuggestion[]
  onApply: (updatedEdges: LabeledEdge[]) => void
  onClose: () => void
}

const REVIEW_TYPES: { type: EdgeType; label: string; color: string; hint: string }[] = [
  { type: 'ridge',  label: 'Ridge',  color: '#a78bfa', hint: 'Top horizontal line where two slopes meet' },
  { type: 'hip',    label: 'Hip',    color: '#34d399', hint: 'Diagonal line, outward-sloping corner' },
  { type: 'valley', label: 'Valley', color: '#f87171', hint: 'Diagonal line, inward gutter where slopes meet' },
  { type: 'eave',   label: 'Eave',   color: '#fb923c', hint: 'Bottom horizontal edge — gutter line' },
  { type: 'rake',   label: 'Rake',   color: '#60a5fa', hint: 'Sloped gable-end edge' },
  { type: 'gable_end', label: 'Gable', color: '#fde68a', hint: 'Triangular wall end under the roof' },
  { type: 'wall_intersection', label: 'Wall', color: '#9ca3af', hint: 'Roof meets a vertical wall' },
]

function colorFor(t: EdgeType): string {
  return REVIEW_TYPES.find(r => r.type === t)?.color ?? '#ffffff'
}

export default function EdgeReviewModal({
  imageUrl, imageWidthPx, imageHeightPx, facets, edges, suggestions, onApply, onClose,
}: Props) {
  const [idx, setIdx] = useState(0)
  // Working copy of edges we mutate as the contractor confirms.
  const [draft, setDraft] = useState<LabeledEdge[]>(edges)
  // Per-suggestion chosen type (defaults to the AI suggestion); lets the
  // contractor reclassify before accepting.
  const [choice, setChoice] = useState<Record<number, EdgeType>>({})
  // Track which suggestions have been actioned (accepted/skipped) for progress.
  const [done, setDone] = useState<Record<number, 'accepted' | 'skipped'>>({})

  const total = suggestions.length
  const current = suggestions[idx]

  const facetByLabel = useMemo(() => {
    const m = new Map<string, Facet>()
    facets.forEach(f => m.set(f.label, f))
    return m
  }, [facets])

  // Endpoints of the current edge in image-fraction coords.
  const endpoints = useMemo(() => {
    if (!current) return null
    const f = facetByLabel.get(current.facet_label)
    if (!f || f.polygon.length < 2) return null
    const a = f.polygon[current.vertex_index_start]
    const b = f.polygon[(current.vertex_index_start + 1) % f.polygon.length]
    if (!a || !b) return null
    return { a, b, facet: f }
  }, [current, facetByLabel])

  // Crop box (in image px) around the edge, with padding, clamped to image.
  const crop = useMemo(() => {
    if (!endpoints) return null
    const { a, b } = endpoints
    const ax = a[0] * imageWidthPx, ay = a[1] * imageHeightPx
    const bx = b[0] * imageWidthPx, by = b[1] * imageHeightPx
    const midX = (ax + bx) / 2, midY = (ay + by) / 2
    const len = Math.hypot(bx - ax, by - ay)
    const half = Math.max(len * 1.1, 90)   // padding around the edge
    let x = midX - half, y = midY - half
    let w = half * 2, h = half * 2
    // clamp
    if (x < 0) x = 0
    if (y < 0) y = 0
    if (x + w > imageWidthPx) w = imageWidthPx - x
    if (y + h > imageHeightPx) h = imageHeightPx - y
    return { x, y, w, h, ax, ay, bx, by }
  }, [endpoints, imageWidthPx, imageHeightPx])

  const chosenType: EdgeType = choice[idx] ?? current?.suggested_edge_type ?? 'unlabeled'

  const applyTypeToDraft = useCallback((type: EdgeType) => {
    if (!current) return
    setDraft(prev => prev.map(e =>
      (e.facetLabel === current.facet_label && e.vertexIndexStart === current.vertex_index_start)
        ? { ...e, edgeType: type, userConfirmed: true }
        : e,
    ))
  }, [current])

  const goNext = useCallback(() => setIdx(i => Math.min(total - 1, i + 1)), [total])
  const goPrev = useCallback(() => setIdx(i => Math.max(0, i - 1)), [])

  const accept = useCallback(() => {
    applyTypeToDraft(chosenType)
    setDone(d => ({ ...d, [idx]: 'accepted' }))
    if (idx < total - 1) goNext()
  }, [applyTypeToDraft, chosenType, idx, total, goNext])

  const skip = useCallback(() => {
    setDone(d => ({ ...d, [idx]: 'skipped' }))
    if (idx < total - 1) goNext()
  }, [idx, total, goNext])

  const finish = useCallback(() => {
    onApply(draft)
    onClose()
  }, [draft, onApply, onClose])

  // Keyboard: ←/→ navigate, Enter accept, S skip, 1-7 reclassify, Esc close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.key === 'Escape') { onClose(); return }
      if (e.key === 'ArrowRight') { goNext(); return }
      if (e.key === 'ArrowLeft') { goPrev(); return }
      if (e.key === 'Enter') { accept(); return }
      if (e.key.toLowerCase() === 's') { skip(); return }
      const n = parseInt(e.key, 10)
      if (n >= 1 && n <= REVIEW_TYPES.length) {
        setChoice(c => ({ ...c, [idx]: REVIEW_TYPES[n - 1].type }))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [goNext, goPrev, accept, skip, onClose, idx])

  const acceptedCount = Object.values(done).filter(v => v === 'accepted').length

  if (!current || !crop || !endpoints) {
    return (
      <Backdrop onClose={onClose}>
        <div className="rounded-lg bg-slate-900 p-6 text-center text-sm text-slate-300">
          No reviewable edges. <button onClick={onClose} className="ml-2 underline">Close</button>
        </div>
      </Backdrop>
    )
  }

  return (
    <Backdrop onClose={onClose}>
      <div
        className="w-[min(720px,94vw)] overflow-hidden rounded-xl border border-white/10 bg-slate-900 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <div className="text-sm font-semibold text-white">
            Review edge {idx + 1} of {total}
            <span className="ml-2 text-xs font-normal text-slate-400">{acceptedCount} confirmed</span>
          </div>
          <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white">✕</button>
        </div>

        {/* Progress dots */}
        <div className="flex flex-wrap gap-1 px-4 pt-3">
          {suggestions.map((_, i) => (
            <button
              key={i}
              onClick={() => setIdx(i)}
              title={`Edge ${i + 1}`}
              className={`h-1.5 w-5 rounded-full transition ${
                done[i] === 'accepted' ? 'bg-emerald-500'
                : done[i] === 'skipped' ? 'bg-slate-600'
                : i === idx ? 'bg-blue-400' : 'bg-slate-700'
              }`}
            />
          ))}
        </div>

        <div className="grid gap-4 p-4 sm:grid-cols-2">
          {/* Zoomed inset with the edge highlighted */}
          <div className="overflow-hidden rounded-lg border border-white/10 bg-black">
            <svg
              viewBox={`${crop.x} ${crop.y} ${crop.w} ${crop.h}`}
              className="block aspect-square w-full"
            >
              <image href={imageUrl} x={0} y={0} width={imageWidthPx} height={imageHeightPx} preserveAspectRatio="none" />
              {/* dim outside? keep simple: just highlight the edge */}
              <line
                x1={crop.ax} y1={crop.ay} x2={crop.bx} y2={crop.by}
                stroke={colorFor(chosenType)} strokeWidth={crop.w * 0.018}
                strokeLinecap="round" opacity={0.95}
              >
                <animate attributeName="opacity" values="0.55;1;0.55" dur="1.4s" repeatCount="indefinite" />
              </line>
              {/* endpoint dots */}
              <circle cx={crop.ax} cy={crop.ay} r={crop.w * 0.012} fill="#fff" />
              <circle cx={crop.bx} cy={crop.by} r={crop.w * 0.012} fill="#fff" />
            </svg>
          </div>

          {/* AI verdict + reclassify */}
          <div className="flex flex-col">
            <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-400">AI classification</div>
            <div className="flex items-center gap-2">
              <span
                className="inline-block h-3 w-3 rounded-full"
                style={{ background: colorFor(current.suggested_edge_type) }}
              />
              <span className="text-lg font-bold capitalize text-white">
                {current.suggested_edge_type.replace('_', ' ')}
              </span>
              <ConfidencePill v={current.confidence} />
            </div>
            {current.reason && (
              <div className="mt-1 text-xs text-slate-400">{current.reason}</div>
            )}
            {current.shared_with_facet_label && (
              <div className="mt-1 text-[10px] text-slate-500">
                Shared with facet {current.shared_with_facet_label}
              </div>
            )}

            <div className="mt-3 text-[10px] uppercase tracking-wide text-slate-400">
              Correct? Pick the right type (1-7):
            </div>
            <div className="mt-1 grid grid-cols-2 gap-1">
              {REVIEW_TYPES.map((t, i) => {
                const selected = chosenType === t.type
                return (
                  <button
                    key={t.type}
                    onClick={() => setChoice(c => ({ ...c, [idx]: t.type }))}
                    title={`${i + 1} · ${t.hint}`}
                    className={`flex items-center gap-1.5 rounded px-2 py-1.5 text-left text-xs transition ${
                      selected ? 'ring-2' : 'hover:bg-slate-800'
                    }`}
                    style={selected
                      ? { background: `${t.color}22`, color: '#fff', boxShadow: `0 0 0 2px ${t.color}` }
                      : { color: '#cbd5e1' }}
                  >
                    <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: t.color }} />
                    {t.label}
                  </button>
                )
              })}
            </div>
          </div>
        </div>

        {/* Footer actions */}
        <div className="flex items-center justify-between gap-2 border-t border-white/10 px-4 py-3">
          <div className="flex gap-2">
            <button onClick={goPrev} disabled={idx === 0}
              className="rounded bg-slate-800 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-30">← Prev</button>
            <button onClick={skip}
              className="rounded bg-slate-800 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-700">Skip (S)</button>
          </div>
          <div className="flex gap-2">
            <button onClick={accept}
              className="rounded bg-emerald-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500">
              {chosenType === current.suggested_edge_type ? 'Accept' : 'Save correction'} (⏎)
            </button>
            <button onClick={finish}
              className="rounded bg-blue-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-blue-500">
              Apply {acceptedCount > 0 ? `${acceptedCount} ` : ''}&amp; close
            </button>
          </div>
        </div>
      </div>
    </Backdrop>
  )
}

function Backdrop({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      {children}
    </div>
  )
}

function ConfidencePill({ v }: { v: number }) {
  const tone = v >= 0.75 ? 'bg-emerald-900/50 text-emerald-300'
    : v >= 0.5 ? 'bg-amber-900/50 text-amber-300'
    : 'bg-rose-900/50 text-rose-300'
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${tone}`}>{Math.round(v * 100)}%</span>
}
