'use client'

/**
 * Axis Roofing Performance — AI-suggested penetration spotter.
 *
 * Calls the existing /roofing/v2/runs/{id}/penetrations/suggest endpoint
 * (Gemini Vision spots likely chimneys, vents, skylights, etc. on the
 * satellite tile), then renders each suggestion as a card with Accept /
 * Reject buttons.
 *
 * Accepted penetrations are persisted with user_confirmed=true. Only
 * confirmed penetrations enter the materials list (e.g., vent boots for
 * plumbing vents) or the PDF report's Roof Penetrations section. The AI's
 * raw guesses never reach a material order.
 *
 * The suggestions panel also doubles as the "review confirmed penetrations"
 * list — confirmed items appear in a separate row with a remove button.
 */
import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'

interface Suggestion {
  type: string
  // Position is only present for satellite-vision hits; ground-photo
  // suggestions (chimney/skylight seen in the contractor's photos) have none.
  pos_x_frac?: number
  pos_y_frac?: number
  confidence: number
  note: string
  count?: number
  source?: string
}

interface ConfirmedPenetration {
  id: string
  type: string
  count: number
  pos_x_frac?: number
  pos_y_frac?: number
  notes?: string
}

interface Props {
  runId: string
  imageUrl?: string
}

const TYPE_LABELS: Record<string, string> = {
  plumbing_vent: 'Plumbing vent',
  exhaust_vent: 'Exhaust vent',
  ridge_vent: 'Ridge vent',
  box_vent: 'Box vent',
  turbine_vent: 'Turbine vent',
  chimney: 'Chimney',
  skylight: 'Skylight',
  satellite_dish: 'Satellite dish',
  solar_panel: 'Solar panel',
  hvac_unit: 'HVAC unit',
  other: 'Other',
}

const TYPE_COLORS: Record<string, string> = {
  plumbing_vent: '#60a5fa',
  exhaust_vent:  '#a78bfa',
  ridge_vent:    '#34d399',
  box_vent:      '#fbbf24',
  turbine_vent:  '#f87171',
  chimney:       '#fb923c',
  skylight:      '#22d3ee',
  satellite_dish:'#9ca3af',
  solar_panel:   '#facc15',
  hvac_unit:     '#94a3b8',
  other:         '#cbd5e1',
}

export function PenetrationSuggestions({ runId, imageUrl }: Props) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [confirmed, setConfirmed] = useState<ConfirmedPenetration[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  // Refresh confirmed list whenever runId changes
  const refreshConfirmed = useCallback(async () => {
    try {
      const data = await api.roofing.v2.getRun(runId)
      const pens = (data.penetrations || []) as unknown as ConfirmedPenetration[]
      setConfirmed(pens.filter(p => (p as unknown as { user_confirmed?: boolean }).user_confirmed))
    } catch {
      /* not fatal */
    }
  }, [runId])

  useEffect(() => { void refreshConfirmed() }, [refreshConfirmed])

  const runSuggest = useCallback(async () => {
    setLoading(true)
    setError(null)
    setMessage(null)
    try {
      const res = await api.roofing.v2.suggestPenetrations(runId)
      setSuggestions(res.suggestions || [])
      setMessage(res.message || null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'AI suggest failed')
    } finally {
      setLoading(false)
    }
  }, [runId])

  const accept = useCallback(async (s: Suggestion, idx: number) => {
    try {
      await api.roofing.v2.addPenetration(runId, {
        type: s.type,
        count: s.count ?? 1,
        pos_x_frac: s.pos_x_frac,
        pos_y_frac: s.pos_y_frac,
        ai_suggested: true,
        user_confirmed: true,
        notes: s.note,
      })
      setSuggestions(prev => prev.filter((_, i) => i !== idx))
      await refreshConfirmed()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save')
    }
  }, [runId, refreshConfirmed])

  const reject = useCallback((idx: number) => {
    setSuggestions(prev => prev.filter((_, i) => i !== idx))
  }, [])

  const removeConfirmed = useCallback(async (id: string) => {
    try {
      await api.roofing.v2.deletePenetration(runId, id)
      await refreshConfirmed()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove')
    }
  }, [runId, refreshConfirmed])

  return (
    <section className="rounded-lg border border-[#dededc] bg-[#f8f8f7] p-4 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-[#1a1a1a]">Roof penetrations</h3>
          <p className="text-xs text-[#6b7280]">
            AI suggests likely chimneys, vents, skylights from the satellite tile.
            <strong> Each suggestion must be confirmed</strong> before it enters the materials list or PDF.
          </p>
        </div>
        <button
          onClick={runSuggest}
          disabled={loading}
          className="rounded bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-500 disabled:opacity-50"
        >{loading ? 'Scanning…' : suggestions.length > 0 ? 'Re-scan' : 'Find penetrations'}</button>
      </div>

      {error && <p className="mt-2 text-xs text-rose-400">{error}</p>}
      {message && !error && <p className="mt-2 text-xs text-[#6b7280]">{message}</p>}

      {/* AI suggestions awaiting confirmation */}
      {suggestions.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 text-[10px] uppercase tracking-wide text-amber-800">
            AI suggestions — needs your verification
          </div>
          <ul className="space-y-2">
            {suggestions.map((s, i) => (
              <li
                key={`${s.type}-${i}`}
                className="rounded border border-amber-400/30 bg-amber-500/5 p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3">
                    {s.pos_x_frac != null && s.pos_y_frac != null && (
                      <MarkerPreview x={s.pos_x_frac} y={s.pos_y_frac} color={TYPE_COLORS[s.type] || '#cbd5e1'} imageUrl={imageUrl} label={s.type?.replace('_', ' ')} />
                    )}
                    <div>
                      <div className="font-medium text-[#1a1a1a]">
                        <span className="inline-block h-2 w-2 rounded-full" style={{ background: TYPE_COLORS[s.type] || '#cbd5e1' }} />{' '}
                        {TYPE_LABELS[s.type] || s.type}
                        <span className="ml-2 text-xs text-[#6b7280]">
                          {(s.confidence * 100).toFixed(0)}% confidence
                        </span>
                      </div>
                      <div className="text-xs text-[#6b7280]">{s.note}</div>
                      <div className="text-[10px] text-[#6b7280]">
                        {s.pos_x_frac != null && s.pos_y_frac != null
                          ? <>Position: {(s.pos_x_frac * 100).toFixed(0)}%, {(s.pos_y_frac * 100).toFixed(0)}% of tile</>
                          : <>📷 From your ground photos</>}
                      </div>
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      onClick={() => accept(s, i)}
                      className="rounded bg-emerald-600 px-2 py-1 text-xs text-white hover:bg-emerald-500"
                    >Accept</button>
                    <button
                      onClick={() => reject(i)}
                      className="rounded bg-[#e4e4e2] px-2 py-1 text-xs text-[#1a1a1a] hover:bg-[#d4d4d2]"
                    >Reject</button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Confirmed list */}
      {confirmed.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 text-[10px] uppercase tracking-wide text-emerald-800">
            Confirmed ({confirmed.length})
          </div>
          <ul className="space-y-1">
            {confirmed.map(p => (
              <li
                key={p.id}
                className="flex items-center justify-between rounded bg-[#eeeeed] px-3 py-1.5 text-xs"
              >
                <span>
                  <span className="inline-block h-2 w-2 rounded-full" style={{ background: TYPE_COLORS[p.type] || '#cbd5e1' }} />{' '}
                  {TYPE_LABELS[p.type] || p.type} × {p.count}
                  {p.notes && <span className="ml-2 text-[#6b7280]">— {p.notes}</span>}
                </span>
                <button
                  onClick={() => removeConfirmed(p.id)}
                  className="text-rose-400 hover:text-rose-800"
                >Remove</button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {suggestions.length === 0 && confirmed.length === 0 && !loading && !error && (
        <p className="mt-3 text-xs text-[#6b7280]">
          No penetrations recorded yet. Click <strong>Find penetrations</strong> to have AI scan the satellite tile.
        </p>
      )}
    </section>
  )
}

/** A tile crop centred on one marker.
 *
 *  This used to squeeze the whole ~2048px tile into 80x60 and drop a dot on it,
 *  which is why the marker looked like it was "all over the place" — at that
 *  scale a roof is four pixels and the dot has nothing to sit against. We now
 *  blow the tile up and slide it so the marked point is dead centre, so the
 *  thumbnail actually shows the penetration and its surroundings.
 *
 *  `zoom` is how many times larger than the frame the tile is drawn: 8 means
 *  you are looking at an eighth of the tile.
 */
function TileCrop({
  x, y, color, imageUrl, zoom, className, dotSize = 12,
}: {
  x: number; y: number; color: string; imageUrl: string
  zoom: number; className?: string; dotSize?: number
}) {
  return (
    <div className={`relative overflow-hidden bg-[#f8f8f7] ${className || ''}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={imageUrl}
        alt=""
        className="absolute max-w-none"
        style={{
          width: `${zoom * 100}%`,
          height: `${zoom * 100}%`,
          // Put the fraction (x, y) of the image exactly at the frame centre.
          left: `${50 - x * zoom * 100}%`,
          top: `${50 - y * zoom * 100}%`,
        }}
      />
      <div
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
        style={{ width: dotSize, height: dotSize, background: color }}
      />
    </div>
  )
}

function MarkerPreview({
  x, y, color, imageUrl, label,
}: { x: number; y: number; color: string; imageUrl?: string; label?: string }) {
  const [open, setOpen] = useState(false)

  // Esc closes, and the body must not scroll behind the overlay.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev }
  }, [open])

  if (!imageUrl) {
    return (
      <div className="flex h-[60px] w-[80px] items-center justify-center rounded border border-[#dededc] bg-[#f8f8f7] text-[10px] text-[#6b7280]">
        no tile
      </div>
    )
  }

  return (
    <>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(true) }}
        title="Click to enlarge"
        aria-label="Enlarge this marker"
        className="group relative block h-[60px] w-[80px] shrink-0 rounded border border-[#dededc] hover:border-white/40"
      >
        <TileCrop x={x} y={y} color={color} imageUrl={imageUrl} zoom={8}
                  className="h-full w-full rounded" dotSize={10} />
        <span className="pointer-events-none absolute inset-0 hidden items-center justify-center bg-black/40 text-[10px] font-semibold text-[#1a1a1a] group-hover:flex">
          Enlarge
        </span>
      </button>

      {open && (
        // Click anywhere outside the image to dismiss, exactly like the X.
        <div
          onClick={() => setOpen(false)}
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-6"
        >
          <div onClick={(e) => e.stopPropagation()} className="relative w-full max-w-3xl">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-semibold text-[#1a1a1a]">{label || 'Penetration'}</span>
              <button
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="rounded px-2 py-0.5 text-lg leading-none text-[#2d2d2d] hover:bg-[#eeeeed] hover:text-[#1a1a1a]"
              >×</button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <TileCrop x={x} y={y} color={color} imageUrl={imageUrl} zoom={6}
                          className="aspect-[4/3] w-full rounded-lg border border-[#dededc]" dotSize={18} />
                <p className="mt-1 text-center text-[11px] text-[#6b7280]">Close up</p>
              </div>
              <div>
                <TileCrop x={x} y={y} color={color} imageUrl={imageUrl} zoom={1}
                          className="aspect-[4/3] w-full rounded-lg border border-[#dededc]" dotSize={14} />
                <p className="mt-1 text-center text-[11px] text-[#6b7280]">Whole roof — where it sits</p>
              </div>
            </div>
            <p className="mt-2 text-center text-[11px] text-[#6b7280]">Click outside, press Esc, or hit × to close.</p>
          </div>
        </div>
      )}
    </>
  )
}

export default PenetrationSuggestions
