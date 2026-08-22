'use client'

/**
 * Map view (M6/M7) — a real tile map of the day's stops. Free OpenStreetMap
 * streets + Esri satellite (no API key), one colored numbered marker per stop,
 * each crew's route drawn in scheduled order, auto-fit to the day's work. Click a
 * marker or a list row to open the job. Leaflet is loaded dynamically (client
 * only) and driven imperatively to avoid React-wrapper version friction.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Map as LeafletMap, LayerGroup, TileLayer } from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { BoardData } from './lib/board'
import { num } from './lib/board'

const PALETTE = ['#5aa9ff', '#ff8a3d', '#37c98b', '#f2b32e', '#f5566c', '#6b7687', '#a78bfa', '#22d3ee']
const jobTypeLabel = (t: string) => t.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase())

interface Stop { apptId: string; crewId: string; lat: number; lng: number; jobNumber: number; label: string; time: string; squares: number | null; order: number }

export default function MapView({ data, focusDate, onDetail }: { data: BoardData; focusDate: string; onDetail: (id: string) => void }) {
  const el = useRef<HTMLDivElement>(null)
  const mapRef = useRef<LeafletMap | null>(null)
  const baseRef = useRef<TileLayer | null>(null)
  const overlayRef = useRef<LayerGroup | null>(null)
  const [base, setBase] = useState<'streets' | 'satellite'>('streets')

  const crewColor = useMemo(() => {
    const m: Record<string, string> = {}
    data.crews.forEach((c, i) => { m[c.id] = PALETTE[i % PALETTE.length] })
    return m
  }, [data.crews])

  const { stops, routes } = useMemo(() => {
    const jobs = new Map(data.jobs.map(j => [j.id, j]))
    const props = new Map(data.properties.map(p => [p.id, p]))
    const perCrew: Record<string, number> = {}
    const list: Stop[] = []
    for (const a of data.appointments.filter(a => a.scheduled_start.slice(0, 10) === focusDate).sort((a, b) => a.scheduled_start.localeCompare(b.scheduled_start))) {
      const job = jobs.get(a.job_id); if (!job) continue
      const prop = props.get(job.property_id)
      const lat = prop ? num(prop.lat) : 0, lng = prop ? num(prop.lng) : 0
      if (!prop || (lat === 0 && lng === 0)) continue
      const crewId = data.appointment_crew[a.id] || 'unassigned'
      perCrew[crewId] = (perCrew[crewId] ?? 0) + 1
      list.push({ apptId: a.id, crewId, lat, lng, jobNumber: job.job_number, label: jobTypeLabel(job.job_type), time: a.scheduled_start.slice(11, 16), squares: job.squares != null ? num(job.squares) : null, order: perCrew[crewId] })
    }
    const byCrew: Record<string, Stop[]> = {}
    list.forEach(s => { (byCrew[s.crewId] ||= []).push(s) })
    const routeLines = Object.entries(byCrew).map(([crewId, arr]) => ({ crewId, points: arr.sort((a, b) => a.order - b.order) }))
    return { stops: list, routes: routeLines }
  }, [data, focusDate])

  const crewsWithStops = useMemo(() => {
    const ids = new Set(stops.map(s => s.crewId))
    return data.crews.filter(c => ids.has(c.id))
  }, [stops, data.crews])

  // Create the map once.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const L = (await import('leaflet')).default
      if (cancelled || !el.current || mapRef.current) return
      const map = L.map(el.current, { zoomControl: true }).setView([34.2257, -77.9447], 11)
      mapRef.current = map
      setTimeout(() => map.invalidateSize(), 120)
    })()
    return () => { cancelled = true; if (mapRef.current) { mapRef.current.remove(); mapRef.current = null } }
  }, [])

  // Base tile layer (streets / satellite).
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const L = (await import('leaflet')).default
      const map = mapRef.current; if (!map) return
      if (baseRef.current) map.removeLayer(baseRef.current)
      const layer = base === 'satellite'
        ? L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { attribution: 'Tiles © Esri', maxZoom: 19 })
        : L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap', maxZoom: 19 })
      if (cancelled) return
      layer.addTo(map)
      baseRef.current = layer
    })()
    return () => { cancelled = true }
  }, [base])

  // Markers + routes whenever the day's stops change.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const L = (await import('leaflet')).default
      const map = mapRef.current; if (!map) return
      if (overlayRef.current) { map.removeLayer(overlayRef.current) }
      const group = L.layerGroup().addTo(map); overlayRef.current = group
      routes.forEach(r => {
        if (r.points.length > 1) L.polyline(r.points.map(p => [p.lat, p.lng]), { color: crewColor[r.crewId] || '#888', dashArray: '6 6', opacity: 0.6, weight: 3 }).addTo(group)
      })
      const pts: [number, number][] = []
      stops.forEach(s => {
        const color = crewColor[s.crewId] || '#888'
        const icon = L.divIcon({
          className: '',
          html: `<div style="display:flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;background:${color};color:#04121f;font-weight:700;font-size:12px;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.45)">${s.order}</div>`,
          iconSize: [26, 26], iconAnchor: [13, 13],
        })
        const m = L.marker([s.lat, s.lng], { icon }).addTo(group)
        m.bindTooltip(`${s.time} · #${s.jobNumber} ${s.label}`)
        m.on('click', () => onDetail(s.apptId))
        pts.push([s.lat, s.lng])
      })
      if (!cancelled && pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.3), { maxZoom: 16 })
      setTimeout(() => map.invalidateSize(), 60)
    })()
    return () => { cancelled = true }
  }, [stops, routes, crewColor, onDetail])

  return (
    <div className="flex flex-col gap-3 p-3 lg:flex-row">
      <div className="relative min-w-0 flex-1">
        <div ref={el} className="h-[60vh] min-h-[380px] w-full overflow-hidden rounded-xl" style={{ border: '1px solid var(--line)', background: 'var(--panel2)', zIndex: 0 }} />
        <div className="absolute right-2 top-2 z-[1000] flex overflow-hidden rounded-md border shadow" style={{ borderColor: 'var(--line)' }}>
          {(['streets', 'satellite'] as const).map(b => (
            <button key={b} onClick={() => setBase(b)} className="px-2.5 py-1 text-[11px] font-semibold capitalize"
              style={{ background: base === b ? 'var(--sky)' : 'var(--panel)', color: base === b ? '#04121f' : 'var(--text)' }}>{b}</button>
          ))}
        </div>
        {stops.length === 0 && (
          <div className="pointer-events-none absolute inset-0 z-[500] flex items-center justify-center">
            <div className="pointer-events-auto rounded-lg px-4 py-2 text-center text-[12px] shadow-lg" style={{ background: 'var(--panel)', color: 'var(--muted)' }}>
              No mapped stops for {focusDate.slice(5)} — jobs need a property location to appear here.
            </div>
          </div>
        )}
      </div>

      <div className="w-full shrink-0 lg:w-72">
        <div className="rounded-xl border p-3" style={{ borderColor: 'var(--line)', background: 'var(--panel)' }}>
          <div className="mb-2 text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--muted)' }}>Routes · {focusDate.slice(5)}</div>
          {crewsWithStops.length === 0 ? (
            <div className="py-4 text-center text-[11px]" style={{ color: 'var(--muted)' }}>Nothing routed today.</div>
          ) : (
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
                        <button key={s.apptId} onClick={() => onDetail(s.apptId)} className="flex w-full items-center gap-2 rounded px-1.5 py-0.5 text-left text-[11px] hover:bg-[#eeeeed]">
                          <span className="w-4 shrink-0 tabular-nums" style={{ color: 'var(--muted)' }}>{s.order}.</span>
                          <span className="truncate">{s.time} #{s.jobNumber} {s.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
