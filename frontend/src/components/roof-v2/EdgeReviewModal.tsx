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
import { labelLine } from './edgeGeometry'

export interface EdgeSuggestion {
  facet_label: string
  vertex_index_start: number
  suggested_edge_type: EdgeType
  confidence: number
  reason: string
  shared_with_facet_label?: string | null
  /** An existing label being re-reviewed rather than a fresh AI proposal —
   *  there's no meaningful confidence to show for one, so the pill is hidden. */
  existing?: boolean
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
  const [done, setDone] = useState<Record<number, 'accepted'>>({})

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


  const goNext = useCallback(() => setIdx(i => Math.min(total - 1, i + 1)), [total])
  const goPrev = useCallback(() => setIdx(i => Math.max(0, i - 1)), [])

  // No skipping: every line gets a decision, and the step cannot be finished
  // until each one has one (Ryan, 2026-10-18). Accepting the last open line
  // saves and closes by itself.
  const accept = useCallback(() => {
    if (!current) return
    const nextDraft = labelLine(
      facets, draft,
      { facetLabel: current.facet_label, vertexIndexStart: current.vertex_index_start },
      chosenType,
    )
    setDraft(nextDraft)
    const nextDone = { ...done, [idx]: 'accepted' as const }
    setDone(nextDone)
    const open = suggestions.findIndex((_, i) => nextDone[i] !== 'accepted')
    if (open === -1) { onApply(nextDraft); onClose(); return }
    // Move to the next line still needing a decision, after this one if any.
    const after = suggestions.findIndex((_, i) => i > idx && nextDone[i] !== 'accepted')
    setIdx(after !== -1 ? after : open)
  }, [current, facets, draft, chosenType, done, idx, suggestions, onApply, onClose])

  // Closing never throws away decisions already made: whatever was accepted is
  // saved, and the status card shows what is left.
  const close = useCallback(() => {
    if (Object.values(done).some(v => v === 'accepted')) onApply(draft)
    onClose()
  }, [done, draft, onApply, onClose])

  // Keyboard: ←/→ navigate, Enter accept, 1-7 reclassify, Esc save & close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.key === 'Escape') { close(); return }
      if (e.key === 'ArrowRight') { goNext(); return }
      if (e.key === 'ArrowLeft') { goPrev(); return }
      if (e.key === 'Enter') { accept(); return }
      const n = parseInt(e.key, 10)
      if (n >= 1 && n <= REVIEW_TYPES.length) {
        setChoice(c => ({ ...c, [idx]: REVIEW_TYPES[n - 1].type }))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [goNext, goPrev, accept, close, idx])

  const acceptedCount = Object.values(done).filter(v => v === 'accepted').length

  if (!current || !crop || !endpoints) {
    return (
      <Backdrop onClose={close}>
        <div className="rounded-lg bg-[#f8f8f7] p-6 text-center text-sm text-[#2d2d2d]">
          No reviewable edges. <button onClick={onClose} className="ml-2 underline">Close</button>
        </div>
      </Backdrop>
    )
  }

  return (
    <Backdrop onClose={close}>
      <div
        className="w-[min(720px,94vw)] overflow-hidden rounded-xl border border-[#dededc] bg-[#f8f8f7] shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#dededc] px-4 py-3">
          <div className="text-sm font-semibold text-[#1a1a1a]">
            Line {idx + 1} of {total}
            <span className="ml-2 text-xs font-normal text-[#6b7280]">{acceptedCount} confirmed</span>
          </div>
          <button onClick={close} title="Save what you've done and close"
            className="rounded p-1 text-[#6b7280] hover:bg-[#eeeeed] hover:text-[#1a1a1a]">✕</button>
        </div>

        {/* Progress dots */}
        <div className="flex flex-wrap gap-1 px-4 pt-3">
          {suggestions.map((_, i) => (
            <button
              key={i}
              onClick={() => setIdx(i)}
              title={done[i] === 'accepted' ? `Line ${i + 1} — done` : `Line ${i + 1}`}
              className={`h-1.5 w-5 rounded-full transition ${ done[i] === 'accepted' ? 'bg-emerald-500' : i === idx ? 'bg-blue-500' : 'bg-[#d4d4d2]' }`}
            />
          ))}
        </div>

        <div className="grid gap-4 p-4 sm:grid-cols-2">
          {/* Zoomed inset with the edge highlighted */}
          <div className="overflow-hidden rounded-lg border border-[#dededc] bg-black">
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
            <div className="mb-1 text-[10px] uppercase tracking-wide text-[#6b7280]">
              {current.existing ? 'Current label' : 'AI classification'}
            </div>
            <div className="flex items-center gap-2">
              <span
                className="inline-block h-3 w-3 rounded-full"
                style={{ background: colorFor(current.suggested_edge_type) }}
              />
              <span className="text-lg font-bold capitalize text-[#1a1a1a]">
                {current.suggested_edge_type.replace('_', ' ')}
              </span>
              {!current.existing && <ConfidencePill v={current.confidence} />}
            </div>
            {current.reason && (
              <div className="mt-1 text-xs text-[#6b7280]">{current.reason}</div>
            )}
            {current.shared_with_facet_label && (
              <div className="mt-1 text-[10px] text-[#6b7280]">
                Shared with facet {current.shared_with_facet_label}
              </div>
            )}

            <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-2">
              <div className="text-[11px] font-semibold text-amber-900">
                Wrong? Pick the correct type, then save it
              </div>
              <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                {REVIEW_TYPES.map((t, i) => {
                  const selected = chosenType === t.type
                  const isCorrection = selected && t.type !== current.suggested_edge_type
                  return (
                    <button
                      key={t.type}
                      onClick={() => setChoice(c => ({ ...c, [idx]: t.type }))}
                      title={`${i + 1} · ${t.hint}`}
                      className={`flex items-center gap-1.5 rounded-md border px-2.5 py-2 text-left text-xs font-medium text-[#1a1a1a] transition ${ selected ? 'border-transparent' : 'border-[#dededc] bg-white hover:bg-[#f3f4f6]' }`}
                      style={selected ? { background: `${t.color}33`, boxShadow: `0 0 0 2px ${t.color}` } : undefined}
                    >
                      <span className="inline-block h-3 w-3 rounded-full" style={{ background: t.color }} />
                      {t.label}
                      {isCorrection && <span className="ml-auto text-[9px] font-bold text-amber-800">FIX</span>}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        </div>

        {/* Footer actions */}
        <div className="flex items-center justify-between gap-2 border-t border-[#dededc] px-4 py-3">
          <div className="flex gap-2">
            <button onClick={goPrev} disabled={idx === 0}
              className="rounded bg-[#eeeeed] px-3 py-1.5 text-xs text-[#1a1a1a] hover:bg-[#e4e4e2] disabled:opacity-30">← Previous</button>
          </div>
          <div className="flex gap-2">
            <button onClick={accept}
              className="rounded bg-emerald-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500">
              {chosenType === current.suggested_edge_type ? 'Accept' : 'Save correction'} (⏎)
            </button>
            <button onClick={close}
              className="rounded border border-[#dededc] bg-white px-4 py-1.5 text-xs font-semibold text-[#1a1a1a] hover:bg-[#f3f4f6]">
              Save &amp; close
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
  // Dark translucent pills with pale text read as muddy smears on a light
  // page — and these carry the confidence number, which has to be legible.
  const tone = v >= 0.75 ? 'bg-emerald-100 text-emerald-900'
    : v >= 0.5 ? 'bg-amber-100 text-amber-900'
    : 'bg-rose-100 text-rose-900'
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${tone}`}>{Math.round(v * 100)}%</span>
}
