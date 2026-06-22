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
import { buildEdgeMap, snapToNearestEdge } from '@/lib/edgeSnap'
import type { Facet } from './RoofFacetEditor'

type Pt = [number, number]

interface Suggestion {
  polygon: Pt[]
  confidence: number
  predicted_pitch: string
  pitch_source?: string
  facet_type?: string
  note: string
}

// Show WHERE the pitch came from so a defaulted 6/12 (the silent area-killer)
// looks different from a real ground-photo read.
function pitchSourceMeta(src?: string): { label: string; color: string } {
  switch (src) {
    case 'ground_photo': return { label: 'from ground photo ✓', color: 'text-emerald-400' }
    case 'ai_satellite': return { label: 'AI from satellite — verify', color: 'text-slate-400' }
    default: return { label: 'default — set this!', color: 'text-amber-400' }
  }
}

// Turn the backend's facet_type code into a human label + emoji so the
// contractor can see at a glance WHAT plane the AI thinks it traced.
const FACET_TYPE_LABELS: Record<string, string> = {
  'gable-front': '🏠 Gable · front slope',
  'gable-rear': '🏠 Gable · rear slope',
  'hip-front': '⛰️ Hip · front slope',
  'hip-rear': '⛰️ Hip · rear slope',
  'hip-left': '⛰️ Hip · left slope',
  'hip-right': '⛰️ Hip · right slope',
  'garage': '🚗 Garage slope',
  'dormer': '🪟 Dormer',
  'flat': '▭ Flat / low-slope',
  'shed': '📐 Shed (single slope)',
  'other': '🔷 Roof plane',
}

function prettyFacetType(t?: string): string {
  if (!t) return '🔷 Roof plane'
  return FACET_TYPE_LABELS[t.toLowerCase()] || `🔷 ${t}`
}

// HONEST confidence. The model's number is a self-rating, NOT measured accuracy —
// showing "90% confident" makes contractors trust a guess that may be on the
// neighbor's roof. Present it as a qualitative band that always says "verify".
function confidenceBand(c: number): { label: string; color: string } {
  if (c >= 0.75) return { label: 'AI: looks clear — verify', color: 'text-emerald-300' }
  if (c >= 0.5) return { label: 'AI: likely — verify', color: 'text-amber-300' }
  return { label: 'AI: unsure — check carefully', color: 'text-rose-300' }
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
  const [reason, setReason] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ran, setRan] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [refineOnAccept, setRefineOnAccept] = useState(true)
  const [zoomedSuggestion, setZoomedSuggestion] = useState<Suggestion | null>(null)

  // Elapsed-time ticker while detecting — so a cold-started backend (up to ~60s
  // on Render free tier) never looks frozen.
  useEffect(() => {
    if (!loading) { setElapsed(0); return }
    const t0 = Date.now()
    const id = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 500)
    return () => clearInterval(id)
  }, [loading])

  const runDetect = useCallback(async () => {
    setLoading(true)
    setError(null)
    setMessage(null)
    setReason(null)
    try {
      const res = await api.roofing.v2.suggestFacets(runId)
      setSuggestions(res.facets || [])
      setMessage(res.message || null)
      setReason(res.reason || null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Auto-detect failed')
    } finally {
      setLoading(false)
      setRan(true)
    }
  }, [runId])

  // Optionally tighten an AI polygon's vertices to the nearest real image
  // edge. CONSERVATIVE on purpose — a small 8px radius + a strong-gradient
  // threshold means a vertex only moves when it's already very close to a
  // crisp edge, so it can never jump to a wrong line (a shadow, a neighbor).
  const refinePolygon = useCallback(async (poly: [number, number][]): Promise<[number, number][]> => {
    if (!refineOnAccept || !imageUrl) return poly
    try {
      const map = await buildEdgeMap(imageUrl)
      return poly.map(([fx, fy]) => {
        const r = snapToNearestEdge(fx * map.width, fy * map.height, 8, 0.16)
        return (r.snapped ? [r.x / map.width, r.y / map.height] : [fx, fy]) as [number, number]
      })
    } catch {
      return poly   // CORS / not-ready → leave the AI polygon untouched
    }
  }, [refineOnAccept, imageUrl])

  const accept = useCallback(async (s: Suggestion, idx: number) => {
    const facet: Facet = {
      label: nextLabel(existingFacets, idx),
      polygon: await refinePolygon(s.polygon),
      pitch: s.predicted_pitch || '6/12',
      // Confidence < 0.85 marks this as ai_corrected in the training data trigger
      confidence: 0.7,
      userConfirmed: true,
    }
    onAccept(facet)
    setSuggestions(prev => prev.filter((_, i) => i !== idx))
  }, [existingFacets, onAccept, refinePolygon])

  const reject = useCallback((idx: number) => {
    const s = suggestions[idx]
    if (s) {
      // Capture the rejection as a NEGATIVE training example — "AI proposed this
      // polygon, a human said it is NOT a roof plane". Fire-and-forget: training
      // capture must never block or error the contractor's flow.
      void api.roofing.v2
        .recordFacetRejections(runId, [
          { polygon: s.polygon, facet_type: s.facet_type, ai_confidence: s.confidence },
        ])
        .catch(() => { /* swallow — best-effort */ })
    }
    setSuggestions(prev => prev.filter((_, i) => i !== idx))
  }, [suggestions, runId])

  const acceptAll = useCallback(async () => {
    const current = suggestions
    for (let i = 0; i < current.length; i++) {
      const s = current[i]
      const facet: Facet = {
        label: nextLabel(existingFacets, i),
        polygon: await refinePolygon(s.polygon),
        pitch: s.predicted_pitch || '6/12',
        confidence: 0.7,
        userConfirmed: true,
      }
      onAccept(facet)
    }
    setSuggestions([])
  }, [suggestions, existingFacets, onAccept, refinePolygon])

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

      {/* Loading state with elapsed timer + cold-start hint */}
      {loading && (
        <div className="mt-3 flex items-center gap-3 rounded-md border border-blue-500/20 bg-blue-500/5 p-3 text-xs text-blue-200">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-blue-400 border-t-transparent" />
          <div>
            <div>Analyzing the satellite tile with AI vision… {elapsed}s</div>
            {elapsed >= 8 && (
              <div className="mt-0.5 text-[10px] text-blue-300/80">
                First request after the server idles can take up to ~60s (cold start). Hang tight.
              </div>
            )}
          </div>
        </div>
      )}

      {error && !loading && (
        <div className="mt-3 rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-xs text-rose-300">
          <div className="font-semibold">Auto-detect failed</div>
          <div className="mt-1 text-rose-200/90">{error}</div>
          <button onClick={runDetect} className="mt-2 rounded bg-rose-700 px-2.5 py-1 text-xs text-white hover:bg-rose-600">
            Try again
          </button>
        </div>
      )}

      {/* Rich 0-result state — never just emptiness. Shows the AI's reasoning
          plus concrete next steps. */}
      {ran && !loading && !error && suggestions.length === 0 && (
        <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
          <div className="font-semibold text-amber-200">AI didn&apos;t find facets it was confident about</div>
          {reason && (
            <div className="mt-1 text-amber-100/90">
              <span className="text-amber-300/80">What the AI saw: </span>{reason}
            </div>
          )}
          {message && <div className="mt-1 text-slate-300">{message}</div>}
          <div className="mt-2 flex flex-wrap gap-2">
            <button onClick={runDetect} className="rounded bg-blue-600 px-2.5 py-1 text-white hover:bg-blue-500">
              Re-detect
            </button>
            <span className="flex items-center text-[10px] text-slate-400">
              …or just trace facets manually in the editor — snap-to-edge makes it quick.
            </span>
          </div>
        </div>
      )}

      {message && !error && !loading && suggestions.length > 0 && (
        <p className="mt-2 text-xs text-slate-400">{message}</p>
      )}

      {suggestions.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-[10px] uppercase tracking-wide text-amber-300">
              {suggestions.length} facet{suggestions.length === 1 ? '' : 's'} suggested · click thumbnail to enlarge
            </span>
            <div className="flex items-center gap-2">
              <label className="flex cursor-pointer items-center gap-1 text-[10px] text-slate-300" title="Tighten each accepted polygon's vertices to the nearest crisp edge (small, safe radius)">
                <input type="checkbox" checked={refineOnAccept} onChange={e => setRefineOnAccept(e.target.checked)} className="h-3 w-3" />
                Refine to edges
              </label>
              <button
                onClick={() => void acceptAll()}
                className="rounded bg-emerald-700 px-2 py-1 text-xs text-white hover:bg-emerald-600"
              >Accept all</button>
            </div>
          </div>
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {suggestions.map((s, i) => {
              const conf = confidenceBand(s.confidence)
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
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className="inline-flex h-6 w-6 items-center justify-center rounded text-xs font-bold text-white"
                        style={{ background: facetColor }}
                      >{nextLabel(existingFacets, i)}</span>
                      <strong className="text-slate-100">
                        Facet {nextLabel(existingFacets, i)}
                      </strong>
                      <span className="rounded bg-slate-700/70 px-1.5 py-0.5 text-[10px] text-slate-200">
                        {prettyFacetType(s.facet_type)}
                      </span>
                      <span
                        className={`text-xs ${conf.color}`}
                        title="The AI's own self-rating — not a measured accuracy. Always confirm the polygon is on the right house."
                      >
                        {conf.label}
                      </span>
                    </div>
                    <div className="text-xs text-slate-400">
                      <span className="text-slate-500">Why: </span>{s.note || '—'}
                    </div>
                    <div className="text-[10px] text-slate-500">
                      Pitch: {s.predicted_pitch || '6/12'}{' '}
                      <span className={pitchSourceMeta(s.pitch_source).color}>
                        ({pitchSourceMeta(s.pitch_source).label})
                      </span>{' '}· {s.polygon.length} vertices
                    </div>
                    <div className="mt-1 flex gap-2">
                      <button
                        onClick={() => void accept(s, i)}
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
            if (idx >= 0) void accept(zoomedSuggestion, idx)
            setZoomedSuggestion(null)
          }}
          onReject={() => {
            const idx = suggestions.indexOf(zoomedSuggestion)
            if (idx >= 0) reject(idx)
            setZoomedSuggestion(null)
          }}
        />
      )}

      {!ran && !loading && (
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
              {prettyFacetType(suggestion.facet_type)}
              <span className={`ml-2 text-xs font-normal ${confidenceBand(suggestion.confidence).color}`}>
                {confidenceBand(suggestion.confidence).label}
              </span>
            </div>
            <div className="mt-1 text-xs text-slate-400">
              <span className="text-slate-500">Why: </span>{suggestion.note || '—'}
            </div>
            <div className="text-[10px] text-slate-500">
              Pitch: {suggestion.predicted_pitch || '6/12'}{' '}
              <span className={pitchSourceMeta(suggestion.pitch_source).color}>
                ({pitchSourceMeta(suggestion.pitch_source).label})
              </span>{' '}· {suggestion.polygon.length} vertices
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
