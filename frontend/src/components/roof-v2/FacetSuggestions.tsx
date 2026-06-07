'use client'

/**
 * Axis Performance — AI facet detection suggestions.
 *
 * Calls /api/v1/roofing/v2/runs/{id}/facets/suggest, which uses Gemini Vision
 * to propose distinct roof planes (facets) on the satellite tile.
 * Contractor accepts each suggestion individually; accepted facets get added
 * to the editor's facet list, where the contractor can then drag vertices,
 * adjust pitch, and label edges as usual.
 *
 * Every accepted facet is marked confidence=0.7 (below the 0.85 organic
 * threshold) so the database trigger captures it as capture_source =
 * 'ai_corrected' — the gold-standard training data type. When the contractor
 * subsequently drags a vertex to correct the polygon, the trigger fires
 * again and the corrected version replaces the AI's original guess as the
 * training example.
 */
import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import type { Facet } from './RoofFacetEditor'

type Pt = [number, number]

interface Suggestion {
  polygon: Pt[]
  confidence: number
  predicted_pitch: string
  note: string
}

interface Props {
  runId: string
  imageUrl: string
  existingFacets: Facet[]
  onAccept: (facet: Facet) => void
}

const FACET_LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

// Matches AnnotatedRoofView.tsx so accepted suggestions visually align with
// what the contractor sees in the editor / report.
const FACET_HUES = ['#3b82f6', '#a855f7', '#22c55e', '#f59e0b', '#ec4899', '#06b6d4', '#84cc16']

function hueByIndex(i: number): string {
  return FACET_HUES[i % FACET_HUES.length]
}

function nextLabel(existing: Facet[], offset = 0): string {
  return FACET_LABELS[existing.length + offset] || `F${existing.length + offset + 1}`
}

export function FacetSuggestions({ runId, imageUrl, existingFacets, onAccept }: Props) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [zoomedSuggestion, setZoomedSuggestion] = useState<Suggestion | null>(null)

  const runDetect = useCallback(async () => {
    setLoading(true)
    setError(null)
    setMessage(null)
    try {
      const res = await api.roofing.v2.suggestFacets(runId)
      setSuggestions(res.facets || [])
      setMessage(res.message || null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Auto-detect failed')
    } finally {
      setLoading(false)
    }
  }, [runId])

  const accept = useCallback((s: Suggestion, idx: number) => {
    const facet: Facet = {
      label: nextLabel(existingFacets, idx),
      polygon: s.polygon,
      pitch: s.predicted_pitch || '6/12',
      // Confidence < 0.85 marks this as ai_corrected in the training data trigger
      confidence: 0.7,
      userConfirmed: true,
    }
    onAccept(facet)
    setSuggestions(prev => prev.filter((_, i) => i !== idx))
  }, [existingFacets, onAccept])

  const reject = useCallback((idx: number) => {
    setSuggestions(prev => prev.filter((_, i) => i !== idx))
  }, [])

  const acceptAll = useCallback(() => {
    suggestions.forEach((s, i) => {
      const facet: Facet = {
        label: nextLabel(existingFacets, i),
        polygon: s.polygon,
        pitch: s.predicted_pitch || '6/12',
        confidence: 0.7,
        userConfirmed: true,
      }
      onAccept(facet)
    })
    setSuggestions([])
  }, [suggestions, existingFacets, onAccept])

  return (
    <section className="rounded-lg border border-white/10 bg-slate-900/40 p-4 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">Auto-detect facets</h3>
          <p className="text-xs text-slate-400">
            AI proposes roof facet polygons from the satellite tile.
            <strong> Accept each one individually</strong> — accepted polygons drop into the editor
            where you can drag vertices to perfect them.
          </p>
        </div>
        <button
          onClick={runDetect}
          disabled={loading}
          className="rounded bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-500 disabled:opacity-50"
        >{loading ? 'Detecting…' : suggestions.length > 0 ? 'Re-detect' : 'Auto-detect facets'}</button>
      </div>

      {error && <p className="mt-2 text-xs text-rose-400">{error}</p>}
      {message && !error && <p className="mt-2 text-xs text-slate-400">{message}</p>}

      {suggestions.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wide text-amber-300">
              {suggestions.length} facet{suggestions.length === 1 ? '' : 's'} suggested · click thumbnail to enlarge
            </span>
            <button
              onClick={acceptAll}
              className="rounded bg-emerald-700 px-2 py-1 text-xs text-white hover:bg-emerald-600"
            >Accept all</button>
          </div>
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {suggestions.map((s, i) => {
              const confColor =
                s.confidence >= 0.75 ? 'text-emerald-300'
                : s.confidence >= 0.5 ? 'text-amber-300'
                : 'text-rose-300'
              const facetColor = hueByIndex(existingFacets.length + i)
              return (
                <li
                  key={i}
                  className="flex flex-col gap-3 rounded border bg-slate-900/40 p-3 sm:flex-row"
                  style={{ borderColor: `${facetColor}66` }}
                >
                  <PolygonThumb
                    polygon={s.polygon}
                    imageUrl={imageUrl}
                    color={facetColor}
                    onClick={() => setZoomedSuggestion(s)}
                  />
                  <div className="flex flex-1 flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span
                        className="inline-flex h-6 w-6 items-center justify-center rounded text-xs font-bold text-white"
                        style={{ background: facetColor }}
                      >{nextLabel(existingFacets, i)}</span>
                      <strong className="text-slate-100">
                        Facet {nextLabel(existingFacets, i)}
                      </strong>
                      <span className={`text-xs ${confColor}`}>
                        {(s.confidence * 100).toFixed(0)}% confident
                      </span>
                    </div>
                    <div className="text-xs text-slate-400">{s.note || '—'}</div>
                    <div className="text-[10px] text-slate-500">
                      Pitch guess: {s.predicted_pitch || '6/12'} · {s.polygon.length} vertices
                    </div>
                    <div className="mt-1 flex gap-2">
                      <button
                        onClick={() => accept(s, i)}
                        className="rounded bg-emerald-600 px-3 py-1.5 text-xs text-white hover:bg-emerald-500"
                      >Accept</button>
                      <button
                        onClick={() => reject(i)}
                        className="rounded bg-slate-700 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-600"
                      >Reject</button>
                      <button
                        onClick={() => setZoomedSuggestion(s)}
                        className="rounded bg-blue-700 px-3 py-1.5 text-xs text-white hover:bg-blue-600"
                      >View full size</button>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {/* Click-to-zoom modal */}
      {zoomedSuggestion && (
        <ZoomModal
          suggestion={zoomedSuggestion}
          imageUrl={imageUrl}
          onClose={() => setZoomedSuggestion(null)}
          onAccept={() => {
            const idx = suggestions.indexOf(zoomedSuggestion)
            if (idx >= 0) accept(zoomedSuggestion, idx)
            setZoomedSuggestion(null)
          }}
          onReject={() => {
            const idx = suggestions.indexOf(zoomedSuggestion)
            if (idx >= 0) reject(idx)
            setZoomedSuggestion(null)
          }}
        />
      )}

      {!suggestions.length && !loading && !error && (
        <p className="mt-3 text-xs text-slate-500">
          Click <strong>Auto-detect facets</strong> to have AI propose polygons. You can also draw facets
          manually in the editor at any time.
        </p>
      )}
    </section>
  )
}

function PolygonThumb({
  polygon, imageUrl, color = '#fbbf24', onClick,
}: { polygon: Pt[]; imageUrl: string; color?: string; onClick?: () => void }) {
  if (!imageUrl) {
    return (
      <div className="flex h-[150px] w-[200px] items-center justify-center rounded border border-white/10 bg-slate-900/60 text-xs text-slate-500">
        no tile available
      </div>
    )
  }
  // Show a wider context view: include the polygon plus ~20% margin around it
  // so the contractor can see what the polygon is relative to its surroundings.
  const xs = polygon.map(p => p[0])
  const ys = polygon.map(p => p[1])
  const minX = Math.max(0, Math.min(...xs) - 0.08)
  const maxX = Math.min(1, Math.max(...xs) + 0.08)
  const minY = Math.max(0, Math.min(...ys) - 0.08)
  const maxY = Math.min(1, Math.max(...ys) + 0.08)
  const w = Math.max(maxX - minX, 0.1)
  const h = Math.max(maxY - minY, 0.1)
  const tW = 200
  const tH = 150
  const points = polygon
    .map(([x, y]) => `${((x - minX) / w) * tW},${((y - minY) / h) * tH}`)
    .join(' ')

  // Use HTML <img> + CSS positioning instead of SVG <image>. SVG <image> often
  // fails silently on cross-origin URLs (MapTiler/Replicate don't send CORS
  // headers for display contexts that they should). HTML <img> always works.
  return (
    <button
      type="button"
      onClick={onClick}
      title="Click to view at full size"
      className="relative shrink-0 overflow-hidden rounded border-2 bg-slate-900/60 transition hover:brightness-110"
      style={{ width: tW, height: tH, borderColor: color }}
    >
      {/* Underlying satellite image, scaled + positioned so the polygon bbox
          fills the thumbnail. The math: image width = tW/w (so the bbox-relative
          x maps to thumbnail pixel x), then translate by -minX*(tW/w) to clip
          the rest off-screen. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={imageUrl}
        alt=""
        draggable={false}
        style={{
          position: 'absolute',
          left: `${-minX * (tW / w)}px`,
          top: `${-minY * (tH / h)}px`,
          width: `${tW / w}px`,
          height: `${tH / h}px`,
          maxWidth: 'none',
          maxHeight: 'none',
          pointerEvents: 'none',
        }}
      />
      {/* Polygon overlay on top */}
      <svg viewBox={`0 0 ${tW} ${tH}`} className="absolute inset-0 h-full w-full">
        <polygon
          points={points}
          fill={color + '40'}
          stroke={color}
          strokeWidth={3}
        />
      </svg>
      <div className="pointer-events-none absolute bottom-1 right-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white">
        🔍 Click to enlarge
      </div>
    </button>
  )
}

function ZoomModal({
  suggestion, imageUrl, onClose, onAccept, onReject,
}: {
  suggestion: Suggestion
  imageUrl: string
  onClose: () => void
  onAccept: () => void
  onReject: () => void
}) {
  // Esc to close
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4"
      onClick={onClose}
    >
      <div
        className="relative max-h-[90vh] w-full max-w-5xl overflow-hidden rounded-lg border border-amber-400/40 bg-slate-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Image with polygon overlay at full size */}
        <div className="relative bg-black">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imageUrl}
            alt="satellite"
            className="block max-h-[75vh] w-full object-contain"
          />
          <svg
            viewBox={`0 0 1 1`}
            preserveAspectRatio="none"
            className="absolute inset-0 h-full w-full"
          >
            <polygon
              points={suggestion.polygon.map(([x, y]) => `${x},${y}`).join(' ')}
              fill="rgba(251, 191, 36, 0.25)"
              stroke="#fbbf24"
              strokeWidth={0.004}
            />
            {suggestion.polygon.map(([x, y], i) => (
              <circle key={i} cx={x} cy={y} r={0.006} fill="#fbbf24" stroke="white" strokeWidth={0.002} />
            ))}
          </svg>
        </div>

        {/* Bottom controls */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 bg-slate-900 p-4 text-sm">
          <div>
            <div className="font-semibold text-slate-100">
              AI suggested facet — {(suggestion.confidence * 100).toFixed(0)}% confidence
            </div>
            <div className="mt-1 text-xs text-slate-400">{suggestion.note || '—'}</div>
            <div className="text-[10px] text-slate-500">
              Pitch guess: {suggestion.predicted_pitch || '6/12'} · {suggestion.polygon.length} vertices
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={onReject}
              className="rounded bg-rose-700 px-4 py-2 text-sm font-medium text-white hover:bg-rose-600"
            >Reject</button>
            <button
              onClick={onAccept}
              className="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
            >Accept</button>
            <button
              onClick={onClose}
              className="rounded bg-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-600"
            >Close (Esc)</button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default FacetSuggestions
