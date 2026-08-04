'use client'

/**
 * Map view (M6) — the day's stops plotted by their real lat/lng, one color per
 * crew, with each crew's jobs connected in scheduled order so the route reads at a
 * glance. Deliberately dependency-free (no tile provider / API key): it's a
 * normalized geographic scatter over the board data already in memory, which keeps
 * the section self-contained and offline-safe. Click a stop to open its detail.
 */
import { useMemo } from 'react'
import type { BoardData } from './lib/board'
import { num } from './lib/board'

const PALETTE = ['var(--sky)', 'var(--dawn)', 'var(--balanced)', 'var(--tight)', 'var(--over)', 'var(--idle)', '#a78bfa', '#22d3ee']
const jobTypeLabel = (t: string) => t.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase())

interface Stop {
  apptId: string; crewId: string; lat: number; lng: number
  jobNumber: number; label: string; time: string; squares: number | null; order: number
}

export default function MapView({ data, focusDate, onDetail }: { data: BoardData; focusDate: string; onDetail: (id: string) => void }) {
  const crewColor = useMemo(() => {
    const m: Record<string, string> = {}
    data.crews.forEach((c, i) => { m[c.id] = PALETTE[i % PALETTE.length] })
    return m
  }, [data.crews])

  const { stops, routes } = useMemo(() => {
    const jobs = new Map(data.jobs.map(j => [j.id, j]))
    const props = new Map(data.properties.map(p => [p.id, p]))
    const dayAppts = data.appointments
      .filter(a => a.scheduled_start.slice(0, 10) === focusDate)
      .sort((a, b) => a.scheduled_start.localeCompare(b.scheduled_start))

    const perCrewOrder: Record<string, number> = {}
    const raw: Stop[] = []
    for (const a of dayAppts) {
      const job = jobs.get(a.job_id); if (!job) continue
      const prop = props.get(job.property_id)
      const lat = prop ? num(prop.lat) : 0, lng = prop ? num(prop.lng) : 0
      if (!prop || (lat === 0 && lng === 0)) continue
      const crewId = data.appointment_crew[a.id] || 'unassigned'
      perCrewOrder[crewId] = (perCrewOrder[crewId] ?? 0) + 1
      raw.push({
        apptId: a.id, crewId, lat, lng, jobNumber: job.job_number,
        label: jobTypeLabel(job.job_type), time: a.scheduled_start.slice(11, 16),
        squares: job.squares != null ? num(job.squares) : null, order: perCrewOrder[crewId],
      })
    }
    if (raw.length === 0) return { stops: [] as (Stop & { x: number; y: number })[], routes: [] as { crewId: string; points: { x: number; y: number }[] }[] }

    const lats = raw.map(s => s.lat), lngs = raw.map(s => s.lng)
    let minLat = Math.min(...lats), maxLat = Math.max(...lats), minLng = Math.min(...lngs), maxLng = Math.max(...lngs)
    // Pad degenerate bounds so a single stop (or a colinear set) still lays out.
    if (maxLat - minLat < 1e-4) { minLat -= 0.01; maxLat += 0.01 }
    if (maxLng - minLng < 1e-4) { minLng -= 0.01; maxLng += 0.01 }
    const PAD = 0.08
    const placed = raw.map(s => ({
      ...s,
      x: PAD + (1 - 2 * PAD) * (s.lng - minLng) / (maxLng - minLng),
      y: PAD + (1 - 2 * PAD) * (maxLat - s.lat) / (maxLat - minLat), // north up
    }))
    const byCrew: Record<string, typeof placed> = {}
    placed.forEach(s => { (byCrew[s.crewId] ||= []).push(s) })
    const routeLines = Object.entries(byCrew).map(([crewId, arr]) => ({
      crewId, points: arr.sort((a, b) => a.order - b.order).map(s => ({ x: s.x, y: s.y })),
    }))
    return { stops: placed, routes: routeLines }
  }, [data, focusDate])

  const crewsWithStops = useMemo(() => {
    const ids = new Set(stops.map(s => s.crewId))
    return data.crews.filter(c => ids.has(c.id))
  }, [stops, data.crews])

  if (stops.length === 0) {
    return (
      <div className="p-10 text-center text-sm" style={{ color: 'var(--muted)' }}>
        No mapped stops for {focusDate.slice(5)}. Jobs need a property location to appear here.
      </div>
    )
  }

  const W = 1000, H = 640
  return (
    <div className="flex flex-col gap-3 p-3 lg:flex-row">
      <div className="min-w-0 flex-1 overflow-hidden rounded-xl border" style={{ borderColor: 'var(--line)', background: 'var(--panel2)' }}>
        <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`Route map for ${focusDate}`}>
          {/* faint grid */}
          {Array.from({ length: 9 }).map((_, i) => (
            <line key={`v${i}`} x1={(i + 1) * W / 10} y1={0} x2={(i + 1) * W / 10} y2={H} stroke="var(--line)" strokeWidth={1} />
          ))}
          {Array.from({ length: 5 }).map((_, i) => (
            <line key={`h${i}`} x1={0} y1={(i + 1) * H / 6} x2={W} y2={(i + 1) * H / 6} stroke="var(--line)" strokeWidth={1} />
          ))}
          {/* routes */}
          {routes.map(r => r.points.length > 1 && (
            <polyline key={r.crewId} fill="none" stroke={crewColor[r.crewId] || 'var(--muted)'} strokeOpacity={0.5}
              strokeWidth={2} strokeDasharray="5 4" points={r.points.map(p => `${p.x * W},${p.y * H}`).join(' ')} />
          ))}
          {/* stops */}
          {stops.map(s => (
            <g key={s.apptId} className="cursor-pointer" onClick={() => onDetail(s.apptId)}>
              <circle cx={s.x * W} cy={s.y * H} r={16} fill={crewColor[s.crewId] || 'var(--muted)'} fillOpacity={0.18} />
              <circle cx={s.x * W} cy={s.y * H} r={9} fill={crewColor[s.crewId] || 'var(--muted)'} stroke="var(--ink)" strokeWidth={2} />
              <text x={s.x * W} y={s.y * H + 3.5} textAnchor="middle" fontSize={10} fontWeight={700} fill="#04121f">{s.order}</text>
              <text x={s.x * W} y={s.y * H - 16} textAnchor="middle" fontSize={12} fontWeight={700} fill="var(--text)">#{s.jobNumber}</text>
            </g>
          ))}
        </svg>
      </div>

      {/* Legend / stop list */}
      <div className="w-full shrink-0 lg:w-72">
        <div className="rounded-xl border p-3" style={{ borderColor: 'var(--line)', background: 'var(--panel)' }}>
          <div className="mb-2 text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--muted)' }}>Routes · {focusDate.slice(5)}</div>
          <div className="space-y-2">
            {crewsWithStops.map(c => {
              const cs = stops.filter(s => s.crewId === c.id).sort((a, b) => a.order - b.order)
              const sq = cs.reduce((t, s) => t + (s.squares || 0), 0)
              return (
                <div key={c.id}>
                  <div className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: crewColor[c.id] }} />
                    <span className="text-[12px] font-semibold">{c.name}</span>
                    <span className="ml-auto text-[11px]" style={{ color: 'var(--muted)' }}>{cs.length} stop{cs.length === 1 ? '' : 's'} · {sq} sq</span>
                  </div>
                  <div className="mt-1 space-y-0.5 pl-[18px]">
                    {cs.map(s => (
                      <button key={s.apptId} onClick={() => onDetail(s.apptId)} className="flex w-full items-center gap-2 rounded px-1.5 py-0.5 text-left text-[11px] hover:bg-white/5">
                        <span className="w-4 shrink-0 tabular-nums" style={{ color: 'var(--muted)' }}>{s.order}.</span>
                        <span className="truncate">{s.time} #{s.jobNumber} {s.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
