'use client'

/**
 * Board — dispatch grid with single-item interaction (M3). Drag a job card to any
 * crew-day: on hover the target cell is previewed (server dry-run) and painted
 * green/amber/red; a chip on the drag shows the resulting utilization. Drop does
 * an optimistic move, reconciles with the server's affected slice, and offers a
 * 15s Undo. BLOCK conflicts refuse the drop with a reason. Click a card for the
 * detail slide-over. Read-only visuals from M2 are preserved.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { shiftISODate } from './lib/today'
import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor, useDraggable, useDroppable,
  useSensor, useSensors, type DragEndEvent, type DragOverEvent, type DragStartEvent,
} from '@dnd-kit/core'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { format, parseISO } from 'date-fns'
import toast from 'react-hot-toast'
import type { BoardData, Crew, DayLoad, Job, LoadState, PreviewResult, AffectedSlice, AffectedMulti, LiveWx } from './lib/board'
import { num, patchAppointment, previewMove, createAppointment, fetchLiveWeather } from './lib/board'
import DetailPanel from './DetailPanel'
import { useSelection } from './lib/selection'
import BulkBar from './BulkBar'
import JobsTray from './JobsTray'
import WeatherReschedule from './WeatherReschedule'
import Copilot from './Copilot'
import MapView from './MapView'
import AuditPanel from './AuditPanel'
import CrewManager from './CrewManager'

const BU_COLOR: Record<string, string> = {
  'bu-install': 'var(--sky)', 'bu-service': 'var(--balanced)', 'bu-gutter': 'var(--tight)', 'bu-siding': 'var(--dawn)',
}
const buColor = (t: string) => BU_COLOR[t] || 'var(--sky)'
const STATE_META: Record<LoadState, { color: string; label: string; glyph: string }> = {
  IDLE: { color: 'var(--idle)', label: 'Idle', glyph: '○' },
  LIGHT: { color: 'var(--sky)', label: 'Light', glyph: '◔' },
  BALANCED: { color: 'var(--balanced)', label: 'On track', glyph: '◑' },
  TIGHT: { color: 'var(--tight)', label: 'Tight', glyph: '◕' },
  OVERBOOKED: { color: 'var(--over)', label: 'Over', glyph: '●' },
}
const STATUS_COLOR: Record<string, string> = {
  SCHEDULED: 'var(--sky)', DISPATCHED: 'var(--sky)', WORKING: 'var(--dawn)', PAUSED: 'var(--tight)',
  DONE: 'var(--balanced)', HOLD: 'var(--muted)', UNASSIGNED: 'var(--muted)', CANCELED: 'var(--muted)',
}
const jobTypeLabel = (t: string) => t.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase())
const cellId = (crew: string, date: string) => `${crew}|${date}`

// ── optimistic cache transforms ──────────────────────────────────────────────
function applyMove(old: BoardData, apptId: string, crewId: string, dateStr: string, pv?: PreviewResult): BoardData {
  const appointments = old.appointments.map(a =>
    a.id === apptId ? { ...a, scheduled_start: dateStr + a.scheduled_start.slice(10), scheduled_end: dateStr + a.scheduled_end.slice(10) } : a)
  const appointment_crew = { ...old.appointment_crew, [apptId]: crewId }
  let day_loads = old.day_loads
  if (pv) {
    const k = `${crewId}:${dateStr}`
    const prevCount = old.day_loads[k]?.appointment_count || 0
    day_loads = { ...old.day_loads, [k]: {
      crew_id: crewId, date: dateStr, appointment_count: prevCount + 1, scheduled_hours: 0,
      available_hours: old.day_loads[k]?.available_hours ?? 0, planned_squares: pv.resulting_planned_squares,
      capacity_squares: pv.capacity_squares, utilization_pct: pv.resulting_utilization_pct, state: pv.resulting_state,
    } }
  }
  return { ...old, appointments, appointment_crew, day_loads }
}
function mergeSlice(old: BoardData, slice: AffectedSlice, movedCrewId: string): BoardData {
  const byId = new Map(old.appointments.map(a => [a.id, a]))
  slice.series.forEach(s => byId.set(s.id, s))
  byId.set(slice.appointment.id, slice.appointment)
  return {
    ...old, appointments: Array.from(byId.values()),
    appointment_crew: { ...old.appointment_crew, [slice.appointment.id]: movedCrewId },
    day_loads: { ...old.day_loads, ...slice.day_loads },
  }
}
function mergeAffected(old: BoardData, aff: AffectedMulti): BoardData {
  const byId = new Map(old.appointments.map(a => [a.id, a]))
  aff.appointments.forEach(a => byId.set(a.id, a))
  const appointment_crew = { ...old.appointment_crew }
  aff.appointments.forEach(a => {
    if (aff.appointment_crew[a.id]) appointment_crew[a.id] = aff.appointment_crew[a.id]
    else delete appointment_crew[a.id]  // unassigned → drops off the grid into the tray
  })
  return { ...old, appointments: Array.from(byId.values()), appointment_crew, day_loads: { ...old.day_loads, ...aff.day_loads } }
}
const isTrayDrag = (id: string | null): boolean => !!id && id.startsWith('tray:')

export default function Board({
  data, today, focusDate, onFocusDate,
}: {
  data: BoardData; today: string
  /** The day in focus, owned by the page so the week can follow it across edges. */
  focusDate: string
  onFocusDate: (d: string) => void
}) {
  const qc = useQueryClient()
  const queryKey = ['board', data.range.start, data.range.end]
  const days = data.range.days
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [activeId, setActiveId] = useState<string | null>(null)
  const [hoverCell, setHoverCell] = useState<string | null>(null)
  const [previewMap, setPreviewMap] = useState<Record<string, PreviewResult | 'loading'>>({})
  const [detailId, setDetailId] = useState<string | null>(null)
  const [view, setView] = useState<'week' | 'day' | 'map'>('week')
  const [auditOpen, setAuditOpen] = useState(false)
  const [crewMgrOpen, setCrewMgrOpen] = useState(false)
  const activeRef = useRef<string | null>(null)
  const previewRef = useRef<Record<string, PreviewResult | 'loading'>>({})

  // Default to the mobile-friendly day view on small screens.
  useEffect(() => { if (typeof window !== 'undefined' && window.innerWidth < 640) setView('day') }, [])

  const swipe = useDaySwipe(focusDate, onFocusDate)

  const [dragLabel, setDragLabel] = useState<string | null>(null)
  const sel = useSelection()
  const selCount = sel.selected.size

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor))

  const setPreview = (cid: string, v: PreviewResult | 'loading') => {
    previewRef.current = { ...previewRef.current, [cid]: v }; setPreviewMap(m => ({ ...m, [cid]: v }))
  }
  const clearPreview = () => { previewRef.current = {}; setPreviewMap({}) }

  const idx = useMemo(() => {
    const jobs = new Map(data.jobs.map(j => [j.id, j]))
    const customers = new Map(data.customers.map(c => [c.id, c]))
    const properties = new Map(data.properties.map(p => [p.id, p]))
    const tags = new Map(data.tags.map(t => [t.id, t]))
    const tagsByJob = new Map<string, string[]>()
    data.job_tag_links.forEach(l => { const a = tagsByJob.get(l.job_id) || []; a.push(l.tag_id); tagsByJob.set(l.job_id, a) })
    const shiftBy = new Map(data.shifts.map(s => [`${s.crew_id}:${s.date}`, s]))
    const membersBy = new Map<string, number>()
    data.crew_memberships.forEach(m => membersBy.set(m.crew_id, (membersBy.get(m.crew_id) || 0) + 1))
    const persons = new Map(data.persons.map(p => [p.id, p]))
    const apptBy = new Map<string, typeof data.appointments>()
    data.appointments.forEach(ap => {
      const k = `${data.appointment_crew[ap.id]}:${ap.scheduled_start.slice(0, 10)}`
      const arr = apptBy.get(k) || []; arr.push(ap); apptBy.set(k, arr)
    })
    const wxBy = new Map<string, typeof data.weather[number]>()
    data.weather.forEach(w => { if (!wxBy.has(w.date) || w.postal_prefix === '284') wxBy.set(w.date, w) })
    const crewsByBu = new Map<string, Crew[]>()
    data.crews.forEach(c => { const a = crewsByBu.get(c.business_unit_id) || []; a.push(c); crewsByBu.set(c.business_unit_id, a) })
    return { jobs, customers, properties, tags, tagsByJob, shiftBy, membersBy, persons, apptBy, wxBy, crewsByBu }
  }, [data])

  // Flat render-order of appointment ids, for shift-click range + Cmd+A.
  const visibleOrder = useMemo(() => {
    const order: string[] = []
    data.business_units.forEach(bu => {
      (idx.crewsByBu.get(bu.id) || []).forEach(crew => {
        days.forEach(d => { (idx.apptBy.get(`${crew.id}:${d}`) || []).forEach(ap => order.push(ap.id)) })
      })
    })
    return order
  }, [data.business_units, idx, days])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a' && visibleOrder.length) {
        e.preventDefault(); sel.setAll(visibleOrder)
      } else if (e.key === 'Escape') { sel.clear() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visibleOrder]) // eslint-disable-line react-hooks/exhaustive-deps

  const onSelect = (id: string, shift: boolean) => {
    if (shift && sel.last) {
      const a = visibleOrder.indexOf(sel.last), b = visibleOrder.indexOf(id)
      if (a >= 0 && b >= 0) { const [lo, hi] = a < b ? [a, b] : [b, a]; sel.addRange(visibleOrder.slice(lo, hi + 1)); sel.setLast(id); return }
    }
    sel.toggle(id)
  }

  const applyAffected = (aff: AffectedMulti) => qc.setQueryData<BoardData>(queryKey, old => old ? mergeAffected(old, aff) : old)

  function doCreate(jobId: string, crewId: string, dateStr: string) {
    createAppointment(jobId, crewId, dateStr)
      .then(slice => {
        qc.setQueryData<BoardData>(queryKey, old => old ? mergeSlice(old, slice, crewId) : old)
        qc.invalidateQueries({ queryKey: ['tray'] })
        toast.success('Scheduled.')
      })
      .catch(err => toast.error('Could not schedule — ' + (err instanceof Error ? err.message.replace(/\[HTTP \d+\]\s*/, '') : 'try again')))
  }

  // Live per-crew weather — non-blocking; the grid renders first, this fills in.
  const { data: liveWx } = useQuery({
    queryKey: ['weather-live', data.range.start, data.range.end],
    queryFn: () => fetchLiveWeather(data.range.start, data.range.end),
    staleTime: 3 * 3600 * 1000, refetchOnWindowFocus: false,
  })
  const crewWx = (crewId: string, d: string): LiveWx | undefined => liveWx?.crew_weather[`${crewId}:${d}`]
  const regionalPrecip = (d: string): number | null => {
    const r = liveWx?.regional[d]?.precip_probability
    return r != null ? r : (idx.wxBy.get(d)?.precip_probability ?? null)
  }

  const cols = `220px repeat(${days.length}, minmax(158px, 1fr))`
  const rainy = (d: string) => { const p = regionalPrecip(d); return p != null && p >= 60 }

  const onDragStart = (e: DragStartEvent) => {
    const id = String(e.active.id)
    activeRef.current = id; setActiveId(id)
    setDragLabel((e.active.data.current?.label as string) ?? null)
    clearPreview(); setHoverCell(null)
  }
  const onDragOver = (e: DragOverEvent) => {
    const over = e.over ? String(e.over.id) : null
    setHoverCell(over)
    const apptId = activeRef.current
    if (over && apptId && !isTrayDrag(apptId) && !(over in previewRef.current)) {
      const [crewId, dateStr] = over.split('|')
      setPreview(over, 'loading')
      previewMove(apptId, crewId, dateStr).then(pv => setPreview(over, pv)).catch(() => {
        previewRef.current = { ...previewRef.current }; delete previewRef.current[over]
        setPreviewMap(m => { const n = { ...m }; delete n[over]; return n })
      })
    }
  }
  const onDragEnd = (e: DragEndEvent) => {
    const apptId = activeRef.current
    const over = e.over ? String(e.over.id) : null
    const pmap = previewRef.current
    setActiveId(null); activeRef.current = null; setHoverCell(null); setDragLabel(null)
    if (!apptId || !over) { clearPreview(); return }
    const [crewId, dateStr] = over.split('|')
    if (isTrayDrag(apptId)) { doCreate(apptId.slice(5), crewId, dateStr); clearPreview(); return }
    const appt = data.appointments.find(a => a.id === apptId)
    if (!appt) { clearPreview(); return }
    const fromCrew = data.appointment_crew[apptId]
    const fromDate = appt.scheduled_start.slice(0, 10)
    if (crewId === fromCrew && dateStr === fromDate) { clearPreview(); return }
    const pv = pmap[over]
    if (pv && pv !== 'loading' && pv.blocked) {
      toast.error('Can’t drop here — ' + pv.conflicts.filter(c => c.severity === 'BLOCK').map(c => c.message).join(' '))
      clearPreview(); return
    }
    doMove(apptId, crewId, dateStr, fromCrew, fromDate, pv && pv !== 'loading' ? pv : undefined)
    clearPreview()
  }

  function doMove(apptId: string, crewId: string, dateStr: string, fromCrew: string, fromDate: string, pv?: PreviewResult) {
    const prev = qc.getQueryData<BoardData>(queryKey)
    qc.setQueryData<BoardData>(queryKey, old => old ? applyMove(old, apptId, crewId, dateStr, pv) : old)
    patchAppointment(apptId, { crew_id: crewId, date: dateStr, request_id: crypto.randomUUID() })
      .then(slice => {
        qc.setQueryData<BoardData>(queryKey, old => old ? mergeSlice(old, slice, crewId) : old)
        toast((t) => (
          <span className="flex items-center gap-3 text-[13px]">
            Job moved.
            <button className="font-bold underline" onClick={() => {
              toast.dismiss(t.id)
              if (prev) qc.setQueryData(queryKey, prev)
              patchAppointment(apptId, { crew_id: fromCrew, date: fromDate, request_id: crypto.randomUUID() }).catch(() => {})
            }}>Undo</button>
          </span>
        ), { duration: 15000 })
      })
      .catch(err => {
        if (prev) qc.setQueryData(queryKey, prev)
        toast.error('Move failed — ' + (err instanceof Error ? err.message.replace(/\[HTTP \d+\]\s*/, '') : 'try again'))
      })
  }

  const activeAppt = activeId ? data.appointments.find(a => a.id === activeId) : undefined
  const activeJob = activeAppt ? idx.jobs.get(activeAppt.job_id) : undefined
  const hoverPv = hoverCell ? previewMap[hoverCell] : undefined

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={() => { setActiveId(null); activeRef.current = null; setDragLabel(null); clearPreview() }}>
      <Copilot start={data.range.start} end={data.range.end} crews={data.crews}
        onApplied={applyAffected}
        onInvalidate={() => {
          qc.invalidateQueries({ queryKey: ['weather-impact'] }); qc.invalidateQueries({ queryKey: ['tray'] })
          qc.invalidateQueries({ queryKey: ['ai-brief'] }); qc.invalidateQueries({ queryKey: ['ai-throughput'] })
          qc.invalidateQueries({ queryKey: ['board'] })
        }} />
      <WeatherReschedule start={data.range.start} end={data.range.end} crews={data.crews}
        onApplied={applyAffected}
        onInvalidate={() => { qc.invalidateQueries({ queryKey: ['weather-impact'] }); qc.invalidateQueries({ queryKey: ['tray'] }) }} />

      {/* View switcher + day nav */}
      <div className="sticky left-0 z-[19] flex flex-wrap items-center gap-2 border-b px-4 py-2" style={{ borderColor: 'var(--line)', background: 'var(--ink)' }}>
        <div className="flex overflow-hidden rounded-lg border" style={{ borderColor: 'var(--line)' }}>
          {(['week', 'day', 'map'] as const).map(v => (
            <button key={v} onClick={() => setView(v)}
              className="px-3 py-1 text-[12px] font-semibold capitalize transition-colors"
              style={{ background: view === v ? 'var(--sky)' : 'transparent', color: view === v ? '#04121f' : 'var(--text)' }}>{v}</button>
          ))}
        </div>
        {view !== 'week' && (
          // Never dead-ends at the week edge — stepping past Sunday pulls the
          // next week in behind it, because the page derives the week from this.
          <div className="flex items-center gap-1">
            <button onClick={() => onFocusDate(shiftISODate(focusDate, -1))}
              className="rounded-md px-2 py-1 text-sm hover:bg-white/5" aria-label="Previous day" title="Previous day (←)">←</button>
            <span className="min-w-[132px] text-center text-[13px] font-semibold">{format(parseISO(focusDate), 'EEE, MMM d')}{focusDate === today && <span className="ml-1.5 rounded px-1 text-[9px] font-bold uppercase" style={{ background: 'var(--dawn)', color: '#1a0e05' }}>Today</span>}</span>
            <button onClick={() => onFocusDate(shiftISODate(focusDate, 1))}
              className="rounded-md px-2 py-1 text-sm hover:bg-white/5" aria-label="Next day" title="Next day (→)">→</button>
          </div>
        )}
        <span className="ml-auto hidden text-[11px] sm:inline" style={{ color: 'var(--muted)' }}>{view === 'week' ? 'Drag to move · click for detail' : view === 'day' ? 'One day, every crew' : 'Stops by location, routed in order'}</span>
        <button onClick={() => setCrewMgrOpen(true)} className="ml-auto rounded-md border px-2.5 py-1 text-[12px] font-semibold hover:bg-white/5 sm:ml-3" style={{ borderColor: 'var(--line)' }}>Crews</button>
        <button onClick={() => setAuditOpen(true)} className="rounded-md border px-2.5 py-1 text-[12px] font-semibold hover:bg-white/5" style={{ borderColor: 'var(--line)' }}>History</button>
      </div>

      {view === 'map' ? (
        <MapView data={data} focusDate={focusDate} onDetail={setDetailId} />
      ) : view === 'day' ? (
        <div className="flex flex-wrap gap-3 p-3 pb-16" {...swipe}>
          {data.business_units.map(bu => (idx.crewsByBu.get(bu.id) || []).map(crew => {
            const d = focusDate
            const load = data.day_loads[`${crew.id}:${d}`]
            const shift = idx.shiftBy.get(`${crew.id}:${d}`)
            const appts = idx.apptBy.get(`${crew.id}:${d}`) || []
            return (
              <div key={crew.id} className="flex w-full flex-col overflow-hidden rounded-xl border sm:w-[300px]" style={{ borderColor: 'var(--line)', background: 'var(--panel)' }}>
                <div className="flex items-center gap-2 border-b px-3 py-2" style={{ borderColor: 'var(--line)' }}>
                  <span className="h-2 w-2 rounded-full" style={{ background: buColor(bu.color_token) }} />
                  <span className="truncate text-[13px] font-semibold">{crew.name}</span>
                  <span className="ml-auto rounded px-1.5 text-[11px] font-semibold" style={{ background: 'rgba(255,255,255,0.06)', color: buColor(bu.color_token) }}>{num(crew.squares_per_day)} sq/day</span>
                </div>
                <div className="p-2">
                  {crewWx(crew.id, d) && <CrewWeatherChip wx={crewWx(crew.id, d)!} />}
                  <CapacityHeader load={load} hasShift={!!shift} shift={shift ? `${shift.start_time}–${shift.end_time}` : undefined} />
                </div>
                <Cell id={cellId(crew.id, d)} rainy={rainy(d)} dragging={!!activeId} preview={previewMap[cellId(crew.id, d)]}>
                  <div className="space-y-1.5">
                    {appts.length === 0 && <div className="py-4 text-center text-[11px]" style={{ color: 'var(--muted)' }}>Open — drop a job here</div>}
                    {appts.map(ap => {
                      const job = idx.jobs.get(ap.job_id); if (!job) return null
                      const cust = idx.customers.get(job.customer_id); const prop = idx.properties.get(job.property_id)
                      const tagIds = idx.tagsByJob.get(job.id) || []
                      return (
                        <DraggableCard key={ap.id} id={ap.id} dragging={activeId === ap.id} onClick={() => setDetailId(ap.id)}
                          selected={sel.isSelected(ap.id)} selectionActive={selCount > 0} onToggle={(shiftKey) => onSelect(ap.id, shiftKey)}>
                          <JobCardBody start={ap.scheduled_start} end={ap.scheduled_end} status={ap.status}
                            seq={ap.sequence} total={ap.total_in_series} job={job} custLast={cust?.last_name}
                            street={prop?.line1} city={prop?.city} tags={tagIds.map(t => idx.tags.get(t)).filter(Boolean) as BoardData['tags']}
                            buColor={buColor(bu.color_token)} storm={rainy(d)} />
                        </DraggableCard>
                      )
                    })}
                  </div>
                </Cell>
              </div>
            )
          }))}
        </div>
      ) : (
      <div className="min-w-max pb-12 text-[13px]">
        {/* Day header */}
        <div className="sticky top-0 z-20 grid border-b" style={{ gridTemplateColumns: cols, background: 'var(--ink)', borderColor: 'var(--line)' }}>
          <div className="sticky left-0 z-30 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider" style={{ background: 'var(--ink)', color: 'var(--muted)' }}>Crew</div>
          {days.map(d => {
            const dt = parseISO(d); const isToday = d === today; const storm = rainy(d)
            const isFocus = d === focusDate
            const reg = liveWx?.regional[d]; const seeded = idx.wxBy.get(d)
            const pp = reg?.precip_probability ?? seeded?.precip_probability ?? null
            const hi = reg?.temp_high_f ?? seeded?.temp_high_f ?? null
            return (
              // Clicking a day focuses it, so switching to Day or Map lands on
              // the column you were already reading.
              <button key={d} onClick={() => onFocusDate(d)} title={`Focus ${format(dt, 'EEE, MMM d')}`}
                className="border-l px-3 py-2 text-left transition-colors hover:bg-white/[0.03]"
                style={{
                  borderColor: 'var(--line)',
                  background: storm ? 'rgba(90,169,255,0.05)' : undefined,
                  boxShadow: isFocus ? 'inset 0 -2px 0 0 var(--sky)' : undefined,
                }}>
                <div className="flex items-center justify-between">
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-[11px] uppercase tracking-wide" style={{ color: isToday ? 'var(--dawn)' : 'var(--muted)' }}>{format(dt, 'EEE')}</span>
                    <span className="text-[15px] font-bold" style={{ color: isToday ? 'var(--dawn)' : 'var(--text)' }}>{format(dt, 'd')}</span>
                    {isToday && <span className="rounded px-1 text-[9px] font-bold uppercase" style={{ background: 'var(--dawn)', color: '#1a0e05' }}>Today</span>}
                  </div>
                  {pp != null && <WeatherChip pp={pp} hi={hi} storm={storm} />}
                </div>
              </button>
            )
          })}
        </div>

        {/* Business-unit groups */}
        {data.business_units.map(bu => {
          const crews = idx.crewsByBu.get(bu.id) || []
          if (!crews.length) return null
          const isCollapsed = collapsed[bu.id]
          return (
            <div key={bu.id}>
              <div className="sticky left-0 z-10 flex items-center gap-2 px-4 py-1.5" style={{ background: 'var(--panel2)', borderBottom: '1px solid var(--line)' }}>
                <button onClick={() => setCollapsed(c => ({ ...c, [bu.id]: !c[bu.id] }))} className="text-[11px]" style={{ color: 'var(--muted)' }}>{isCollapsed ? '▸' : '▾'}</button>
                <span className="h-2.5 w-2.5 rounded-sm" style={{ background: buColor(bu.color_token) }} />
                <span className="text-[12px] font-bold uppercase tracking-wide">{bu.name}</span>
                <span className="text-[11px]" style={{ color: 'var(--muted)' }}>{crews.length} crew{crews.length === 1 ? '' : 's'}</span>
              </div>
              {!isCollapsed && crews.map(crew => (
                <div key={crew.id} className="grid border-b" style={{ gridTemplateColumns: cols, borderColor: 'var(--line)' }}>
                  <CrewRail crew={crew} lead={crew.lead_id ? idx.persons.get(crew.lead_id) : undefined} members={idx.membersBy.get(crew.id) || 0} buColor={buColor(bu.color_token)} />
                  {days.map(d => {
                    const cid = cellId(crew.id, d)
                    const load = data.day_loads[`${crew.id}:${d}`]
                    const shift = idx.shiftBy.get(`${crew.id}:${d}`)
                    const appts = idx.apptBy.get(`${crew.id}:${d}`) || []
                    return (
                      <Cell key={d} id={cid} rainy={rainy(d)} dragging={!!activeId} preview={previewMap[cid]}>
                        {crewWx(crew.id, d) && <CrewWeatherChip wx={crewWx(crew.id, d)!} />}
                        <CapacityHeader load={load} hasShift={!!shift} shift={shift ? `${shift.start_time}–${shift.end_time}` : undefined} />
                        <div className="mt-1.5 space-y-1.5">
                          {appts.map(ap => {
                            const job = idx.jobs.get(ap.job_id); if (!job) return null
                            const cust = idx.customers.get(job.customer_id); const prop = idx.properties.get(job.property_id)
                            const tagIds = idx.tagsByJob.get(job.id) || []
                            return (
                              <DraggableCard key={ap.id} id={ap.id} dragging={activeId === ap.id} onClick={() => setDetailId(ap.id)}
                                selected={sel.isSelected(ap.id)} selectionActive={selCount > 0} onToggle={(shift) => onSelect(ap.id, shift)}>
                                <JobCardBody start={ap.scheduled_start} end={ap.scheduled_end} status={ap.status}
                                  seq={ap.sequence} total={ap.total_in_series} job={job} custLast={cust?.last_name}
                                  street={prop?.line1} city={prop?.city} tags={tagIds.map(t => idx.tags.get(t)).filter(Boolean) as BoardData['tags']}
                                  buColor={buColor(bu.color_token)} storm={rainy(d)} />
                              </DraggableCard>
                            )
                          })}
                        </div>
                      </Cell>
                    )
                  })}
                </div>
              ))}
            </div>
          )
        })}
      </div>
      )}

      <DragOverlay dropAnimation={null}>
        {isTrayDrag(activeId) ? (
          <div className="w-[200px] rotate-1">
            <div className="rounded-md px-2 py-1.5 shadow-2xl ring-1 ring-white/20" style={{ background: 'var(--panel)' }}>
              <div className="text-[13px] font-semibold">{dragLabel ?? 'New job'}</div>
            </div>
            <div className="mt-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-bold shadow-lg" style={{ background: 'var(--sky)', color: '#04121f' }}>drop to schedule</div>
          </div>
        ) : activeJob && activeAppt ? (
          <div className="w-[200px] rotate-1">
            <div className="rounded-md px-2 py-1.5 shadow-2xl ring-1 ring-white/20" style={{ background: 'var(--panel)' }}>
              <div className="text-[13px] font-semibold">{jobTypeLabel(activeJob.job_type)}{activeJob.squares != null && <span style={{ color: 'var(--dawn)' }}> · {num(activeJob.squares)} sq</span>}</div>
            </div>
            {hoverPv && hoverPv !== 'loading' && (
              <div className="mt-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-bold shadow-lg"
                style={{ background: hoverPv.blocked ? 'var(--over)' : hoverPv.conflicts.length ? 'var(--tight)' : 'var(--balanced)', color: '#04121f' }}>
                {hoverPv.blocked ? '⃠ blocked' : `→ ${hoverPv.resulting_planned_squares}/${hoverPv.capacity_squares} sq · ${STATE_META[hoverPv.resulting_state].label}`}
              </div>
            )}
          </div>
        ) : null}
      </DragOverlay>

      {detailId && <DetailPanel appointmentId={detailId} data={data} onClose={() => setDetailId(null)}
        onPatched={(slice) => qc.setQueryData<BoardData>(queryKey, old => old ? mergeSlice(old, slice, data.appointment_crew[slice.appointment.id]) : old)} />}

      {selCount > 0 && (
        <BulkBar ids={Array.from(sel.selected)} crews={data.crews} tags={data.tags}
          onApplied={applyAffected} onClear={() => sel.clear()} onTrayInvalidate={() => qc.invalidateQueries({ queryKey: ['tray'] })} />
      )}
      <JobsTray />
      {auditOpen && <AuditPanel onClose={() => setAuditOpen(false)} />}
      {crewMgrOpen && <CrewManager data={data} onClose={() => setCrewMgrOpen(false)} />}
    </DndContext>
  )
}

/**
 * Swipe left/right on the day view to walk days — the gesture a dispatcher
 * reaches for on a phone in a truck. Deliberately narrow so it can't misfire:
 * it ignores anything starting on a job card (that's a drag-to-reschedule), and
 * only fires on a decisively horizontal travel of 60px+, so vertical scrolling
 * through a long crew list is never swallowed.
 */
function useDaySwipe(focusDate: string, onFocusDate: (d: string) => void) {
  const start = useRef<{ x: number; y: number } | null>(null)
  return {
    onTouchStart: (e: React.TouchEvent) => {
      if ((e.target as HTMLElement).closest('[data-job-card]')) { start.current = null; return }
      const t = e.touches[0]
      start.current = { x: t.clientX, y: t.clientY }
    },
    onTouchEnd: (e: React.TouchEvent) => {
      const s = start.current
      start.current = null
      if (!s) return
      const t = e.changedTouches[0]
      const dx = t.clientX - s.x
      const dy = t.clientY - s.y
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return
      onFocusDate(shiftISODate(focusDate, dx < 0 ? 1 : -1))
    },
  }
}

function Cell({ id, rainy, dragging, preview, children }: { id: string; rainy: boolean; dragging: boolean; preview?: PreviewResult | 'loading'; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id })
  let ring = 'transparent'; let bg: string | undefined = rainy ? 'rgba(90,169,255,0.04)' : undefined
  if (dragging && preview && preview !== 'loading') {
    const c = preview.blocked ? 'var(--over)' : preview.conflicts.length ? 'var(--tight)' : 'var(--balanced)'
    ring = c; if (isOver) bg = `color-mix(in srgb, ${c} 12%, var(--ink))`
  } else if (dragging && isOver) { ring = 'var(--sky)' }
  return (
    <div ref={setNodeRef} className="min-h-[128px] border-l p-1.5 transition-colors"
      style={{ borderColor: 'var(--line)', background: bg, boxShadow: ring !== 'transparent' ? `inset 0 0 0 2px ${ring}` : undefined, cursor: dragging && preview && preview !== 'loading' && preview.blocked && isOver ? 'not-allowed' : undefined }}>
      {children}
    </div>
  )
}

function DraggableCard({
  id, dragging, selected, selectionActive, onToggle, onClick, children,
}: {
  id: string; dragging: boolean; selected: boolean; selectionActive: boolean
  onToggle: (shift: boolean) => void; onClick: () => void; children: React.ReactNode
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id })
  return (
    <div ref={setNodeRef} data-job-card className="group relative rounded-md"
      style={{ opacity: isDragging || dragging ? 0.4 : 1, boxShadow: selected ? '0 0 0 2px var(--sky)' : undefined }}>
      <div {...listeners} {...attributes} onClick={onClick} className="cursor-grab active:cursor-grabbing">{children}</div>
      <button
        onPointerDown={e => e.stopPropagation()}
        onClick={e => { e.stopPropagation(); onToggle(e.shiftKey) }}
        title="Select"
        className={`absolute left-1 top-1 z-10 flex h-4 w-4 items-center justify-center rounded-[3px] border text-[9px] font-bold leading-none transition-opacity ${selected || selectionActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
        style={{ borderColor: selected ? 'var(--sky)' : 'var(--line)', background: selected ? 'var(--sky)' : 'var(--panel)', color: selected ? '#04121f' : 'transparent' }}>
        ✓
      </button>
    </div>
  )
}

function CrewRail({ crew, lead, members, buColor }: { crew: Crew; lead?: { first_name: string; last_name: string }; members: number; buColor: string }) {
  return (
    <div className="sticky left-0 z-10 flex flex-col justify-center gap-0.5 px-4 py-2" style={{ background: 'var(--panel)', borderRight: '1px solid var(--line)' }}>
      <div className="flex items-center gap-2">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--balanced)' }} title="Active" />
        <span className="truncate text-[13px] font-semibold">{crew.name}</span>
      </div>
      <div className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--muted)' }}>
        <span className="rounded px-1 font-semibold" style={{ background: 'rgba(255,255,255,0.06)', color: buColor }}>{num(crew.squares_per_day)} sq/day</span>
        {lead && <span className="truncate">{lead.first_name} {lead.last_name[0]}.</span>}
        <span>· {members}</span>
      </div>
    </div>
  )
}

function CapacityHeader({ load, hasShift, shift }: { load?: DayLoad; hasShift: boolean; shift?: string }) {
  if (!hasShift) return <div className="rounded-md px-2 py-1.5 text-[11px]" style={{ background: 'var(--panel2)', color: 'var(--muted)' }}>No shift</div>
  if (load && load.available_hours === 0) return <div className="rounded-md px-2 py-1.5 text-[11px]" style={{ background: 'rgba(245,86,108,0.08)', color: 'var(--muted)' }}>Blocked · PTO</div>
  const st = STATE_META[(load?.state || 'IDLE') as LoadState]
  const planned = load?.planned_squares ?? 0; const cap = load?.capacity_squares ?? 0
  const fill = cap > 0 ? Math.min(1.25, planned / cap) : 0
  return (
    <div className="rounded-md px-2 py-1.5" style={{ background: 'var(--panel2)' }}>
      <div className="flex items-baseline justify-between">
        <div className="text-[14px] font-bold leading-none">{planned}<span className="text-[11px] font-medium" style={{ color: 'var(--muted)' }}>/{cap} sq</span></div>
        <div className="text-[10px] font-semibold" style={{ color: st.color }}>{st.glyph} {st.label}</div>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full" style={{ background: 'rgba(255,255,255,0.08)' }}>
        <div className="h-full rounded-full" style={{ width: `${Math.min(100, fill * 100)}%`, background: st.color }} />
      </div>
      <div className="mt-0.5 flex justify-between text-[10px]" style={{ color: 'var(--muted)' }}>
        <span>{load?.appointment_count ?? 0} job{(load?.appointment_count ?? 0) === 1 ? '' : 's'}</span>
        {shift && <span>{shift}</span>}
      </div>
    </div>
  )
}

function WeatherChip({ pp, hi, storm }: { pp: number; hi: number | null; storm: boolean }) {
  return (
    <span className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold"
      style={{ background: storm ? 'rgba(245,178,46,0.15)' : 'rgba(255,255,255,0.05)', color: storm ? 'var(--tight)' : 'var(--muted)' }} title={`${Math.round(pp)}% precip`}>
      <span>{storm ? '⛈' : pp >= 30 ? '🌦' : '☀'}</span>{hi != null && <span>{Math.round(hi)}°</span>}<span>{Math.round(pp)}%</span>
    </span>
  )
}

// Per-crew weather for a crew-day — the sky at that crew's own job site.
function CrewWeatherChip({ wx }: { wx: LiveWx }) {
  const pp = wx.precip_probability ?? 0
  const storm = pp >= 60
  const windy = (wx.wind_mph ?? 0) >= 20
  return (
    <div className="mb-1 flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold"
      style={{ background: storm ? 'rgba(245,178,46,0.15)' : 'rgba(255,255,255,0.05)', color: storm ? 'var(--tight)' : 'var(--muted)' }}
      title={`Job-site forecast · ${Math.round(pp)}% precip${windy ? ` · ${Math.round(wx.wind_mph!)} mph wind` : ''}`}>
      <span>{storm ? '⛈' : pp >= 30 ? '🌦' : '☀'}</span>
      <span>{Math.round(pp)}%</span>
      {windy && <span>💨{Math.round(wx.wind_mph!)}</span>}
      {wx.temp_high_f != null && <span className="ml-auto">{Math.round(wx.temp_high_f)}°</span>}
    </div>
  )
}

function JobCardBody({
  start, end, status, seq, total, job, custLast, street, city, tags, buColor, storm,
}: {
  start: string; end: string; status: string; seq: number; total: number; job: Job
  custLast?: string; street?: string; city?: string; tags: BoardData['tags']; buColor: string; storm: boolean
}) {
  const sc = STATUS_COLOR[status] || 'var(--muted)'
  const sq = job.squares != null ? num(job.squares) : null
  const badges: { label: string; color: string }[] = []
  if (storm) badges.push({ label: '⛈ Weather', color: 'var(--tight)' })
  if (job.priority === 'URGENT') badges.push({ label: 'Urgent', color: 'var(--over)' })
  const visTags = tags.slice(0, 2); const extra = tags.length - visTags.length
  return (
    <div className="relative overflow-hidden rounded-md py-1.5 pl-2 pr-2" style={{ background: `color-mix(in srgb, ${sc} 12%, var(--panel))` }}>
      <span className="absolute left-0 top-0 h-full w-[3px]" style={{ background: buColor }} />
      <div className="flex items-center justify-between text-[10px]" style={{ color: 'var(--muted)' }}>
        <span>{start.slice(11, 16)}–{end.slice(11, 16)}</span>
        <span className="flex items-center gap-1">
          {total > 1 && <span className="rounded bg-white/10 px-1 font-semibold" style={{ color: 'var(--text)' }}>{seq}/{total}</span>}
          <span className="h-2 w-2 rounded-full" style={{ background: sc }} title={status.toLowerCase()} />
        </span>
      </div>
      <div className="mt-0.5 text-[13px] font-semibold leading-tight">
        {jobTypeLabel(job.job_type)}
        {sq != null ? <span className="ml-1" style={{ color: 'var(--dawn)' }}>· {sq} sq</span> : <span className="ml-1 text-[11px] font-normal" style={{ color: 'var(--muted)' }}>· no measurements</span>}
      </div>
      <div className="truncate text-[11px]" style={{ color: 'var(--muted)' }}>{[custLast, street, city].filter(Boolean).join(' · ')}</div>
      {(badges.length > 0 || visTags.length > 0) && (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {badges.map((b, i) => <span key={i} className="rounded px-1 py-0.5 text-[9px] font-bold" style={{ background: `color-mix(in srgb, ${b.color} 20%, transparent)`, color: b.color }}>{b.label}</span>)}
          {visTags.map(t => <span key={t.id} className="rounded px-1 py-0.5 text-[9px] font-semibold" style={{ background: 'rgba(255,255,255,0.07)', color: 'var(--muted)' }}>{t.label}</span>)}
          {extra > 0 && <span className="rounded px-1 py-0.5 text-[9px] font-semibold" style={{ background: 'rgba(255,255,255,0.07)', color: 'var(--muted)' }}>+{extra}</span>}
        </div>
      )}
    </div>
  )
}
