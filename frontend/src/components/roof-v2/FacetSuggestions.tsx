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
import { useCallback, useState } from 'react'
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

function nextLabel(existing: Facet[], offset = 0): string {
  return FACET_LABELS[existing.length + offset] || `F${existing.length + offset + 1}`
}

export function FacetSuggestions({ runId, imageUrl, existingFacets, onAccept }: Props) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

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
              {suggestions.length} facet{suggestions.length === 1 ? '' : 's'} suggested
            </span>
            <button
              onClick={acceptAll}
              className="rounded bg-emerald-700 px-2 py-1 text-xs text-white hover:bg-emerald-600"
            >Accept all</button>
          </div>
          <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {suggestions.map((s, i) => {
              const confColor =
                s.confidence >= 0.75 ? 'text-emerald-300'
                : s.confidence >= 0.5 ? 'text-amber-300'
                : 'text-rose-300'
              return (
                <li
                  key={i}
                  className="flex items-start gap-3 rounded border border-amber-400/30 bg-amber-500/5 p-3"
                >
                  <PolygonThumb polygon={s.polygon} imageUrl={imageUrl} />
                  <div className="flex flex-1 flex-col gap-1">
                    <div className="flex items-center gap-2">
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
                        className="rounded bg-emerald-600 px-2 py-1 text-xs text-white hover:bg-emerald-500"
                      >Accept</button>
                      <button
                        onClick={() => reject(i)}
                        className="rounded bg-slate-700 px-2 py-1 text-xs text-slate-200 hover:bg-slate-600"
                      >Reject</button>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
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

function PolygonThumb({ polygon, imageUrl }: { polygon: Pt[]; imageUrl: string }) {
  if (!imageUrl) {
    return (
      <div className="flex h-[60px] w-[80px] items-center justify-center rounded border border-white/10 bg-slate-900/60 text-[10px] text-slate-500">
        no tile
      </div>
    )
  }
  // Compute bounding box of polygon
  const xs = polygon.map(p => p[0])
  const ys = polygon.map(p => p[1])
  const minX = Math.max(0, Math.min(...xs) - 0.02)
  const maxX = Math.min(1, Math.max(...xs) + 0.02)
  const minY = Math.max(0, Math.min(...ys) - 0.02)
  const maxY = Math.min(1, Math.max(...ys) + 0.02)
  const w = maxX - minX || 0.05
  const h = maxY - minY || 0.05
  // Thumbnail is 80x60 — show the polygon area at its actual location on the tile
  const points = polygon
    .map(([x, y]) => `${((x - minX) / w) * 80},${((y - minY) / h) * 60}`)
    .join(' ')
  return (
    <div className="relative h-[60px] w-[80px] shrink-0 overflow-hidden rounded border border-amber-400/40 bg-slate-900/60">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={imageUrl}
        alt=""
        className="absolute h-full w-full object-cover"
        style={{
          objectPosition: `${(minX + maxX) * 50}% ${(minY + maxY) * 50}%`,
          transform: `scale(${1 / Math.max(w, h)})`,
          transformOrigin: 'center',
        }}
      />
      <svg
        viewBox="0 0 80 60"
        className="absolute inset-0 h-full w-full"
      >
        <polygon
          points={points}
          fill="rgba(251, 191, 36, 0.35)"
          stroke="#fbbf24"
          strokeWidth={2}
        />
      </svg>
    </div>
  )
}

export default FacetSuggestions
