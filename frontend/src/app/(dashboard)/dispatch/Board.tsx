'use client'

/**
 * Board — the read-only dispatch grid (M2). Business-unit bands → crew rows →
 * per-crew-day cells. Each cell leads with a squares-based capacity meter (the
 * product's whole thesis), then the shift window, then job cards. Weather rides
 * in the day header; a stormy day hatches its column. No interaction yet.
 */
import { useMemo, useState } from 'react'
import { format, parseISO } from 'date-fns'
import type { BoardData, Crew, DayLoad, Job, LoadState } from './lib/board'
import { num } from './lib/board'

const BU_COLOR: Record<string, string> = {
  'bu-install': 'var(--sky)', 'bu-service': 'var(--balanced)',
  'bu-gutter': 'var(--tight)', 'bu-siding': 'var(--dawn)',
}
const buColor = (token: string) => BU_COLOR[token] || 'var(--sky)'

const STATE_META: Record<LoadState, { color: string; label: string; glyph: string }> = {
  IDLE: { color: 'var(--idle)', label: 'Idle', glyph: '○' },
  LIGHT: { color: 'var(--sky)', label: 'Light', glyph: '◔' },
  BALANCED: { color: 'var(--balanced)', label: 'On track', glyph: '◑' },
  TIGHT: { color: 'var(--tight)', label: 'Tight', glyph: '◕' },
  OVERBOOKED: { color: 'var(--over)', label: 'Over', glyph: '●' },
}

const STATUS_COLOR: Record<string, string> = {
  SCHEDULED: 'var(--sky)', DISPATCHED: 'var(--sky)', WORKING: 'var(--dawn)',
  PAUSED: 'var(--tight)', DONE: 'var(--balanced)', HOLD: 'var(--muted)',
  UNASSIGNED: 'var(--muted)', CANCELED: 'var(--muted)',
}

const jobTypeLabel = (t: string) => t.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase())

export default function Board({ data, today }: { data: BoardData; today: string }) {
  const days = data.range.days
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

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
    // appointments grouped by crew:date
    const apptBy = new Map<string, typeof data.appointments>()
    data.appointments.forEach(ap => {
      const crew = data.appointment_crew[ap.id]
      const d = ap.scheduled_start.slice(0, 10)
      const k = `${crew}:${d}`
      const arr = apptBy.get(k) || []; arr.push(ap); apptBy.set(k, arr)
    })
    // weather by day (prefer the 284 Wilmington bucket)
    const wxBy = new Map<string, typeof data.weather[number]>()
    data.weather.forEach(w => { if (!wxBy.has(w.date) || w.postal_prefix === '284') wxBy.set(w.date, w) })
    const crewsByBu = new Map<string, Crew[]>()
    data.crews.forEach(c => { const a = crewsByBu.get(c.business_unit_id) || []; a.push(c); crewsByBu.set(c.business_unit_id, a) })
    return { jobs, customers, properties, tags, tagsByJob, shiftBy, membersBy, persons, apptBy, wxBy, crewsByBu }
  }, [data])

  const cols = `220px repeat(${days.length}, minmax(158px, 1fr))`
  const rainy = (d: string) => { const w = idx.wxBy.get(d); return w ? w.precip_probability >= 60 : false }

  return (
    <div className="min-w-max text-[13px]">
      {/* Day header */}
      <div className="sticky top-0 z-20 grid border-b" style={{ gridTemplateColumns: cols, background: 'var(--ink)', borderColor: 'var(--line)' }}>
        <div className="sticky left-0 z-30 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider" style={{ background: 'var(--ink)', color: 'var(--muted)' }}>Crew</div>
        {days.map(d => {
          const dt = parseISO(d); const isToday = d === today; const w = idx.wxBy.get(d); const storm = rainy(d)
          return (
            <div key={d} className="border-l px-3 py-2" style={{ borderColor: 'var(--line)', background: storm ? 'rgba(90,169,255,0.05)' : undefined }}>
              <div className="flex items-center justify-between">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-[11px] uppercase tracking-wide" style={{ color: isToday ? 'var(--dawn)' : 'var(--muted)' }}>{format(dt, 'EEE')}</span>
                  <span className="text-[15px] font-bold" style={{ color: isToday ? 'var(--dawn)' : 'var(--text)' }}>{format(dt, 'd')}</span>
                  {isToday && <span className="rounded px-1 text-[9px] font-bold uppercase" style={{ background: 'var(--dawn)', color: '#1a0e05' }}>Today</span>}
                </div>
                {w && <WeatherChip pp={w.precip_probability} hi={w.temp_high_f} storm={storm} />}
              </div>
            </div>
          )
        })}
      </div>

      {/* Business-unit groups */}
      {data.business_units.map(bu => {
        const crews = (idx.crewsByBu.get(bu.id) || [])
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
                  const load = data.day_loads[`${crew.id}:${d}`]
                  const shift = idx.shiftBy.get(`${crew.id}:${d}`)
                  const appts = idx.apptBy.get(`${crew.id}:${d}`) || []
                  return (
                    <div key={d} className="min-h-[128px] border-l p-1.5" style={{ borderColor: 'var(--line)', background: rainy(d) ? 'rgba(90,169,255,0.04)' : undefined }}>
                      <CapacityHeader load={load} hasShift={!!shift} shift={shift ? `${shift.start_time}–${shift.end_time}` : undefined} />
                      <div className="mt-1.5 space-y-1.5">
                        {appts.map(ap => {
                          const job = idx.jobs.get(ap.job_id)
                          if (!job) return null
                          const cust = idx.customers.get(job.customer_id)
                          const prop = idx.properties.get(job.property_id)
                          const tagIds = idx.tagsByJob.get(job.id) || []
                          return (
                            <JobCard key={ap.id}
                              start={ap.scheduled_start} end={ap.scheduled_end} status={ap.status}
                              seq={ap.sequence} total={ap.total_in_series}
                              job={job} custLast={cust?.last_name} street={prop?.line1} city={prop?.city}
                              plannedSq={num(ap.planned_squares)}
                              tags={tagIds.map(t => idx.tags.get(t)).filter(Boolean) as BoardData['tags']}
                              buColor={buColor(bu.color_token)} storm={rainy(d)} />
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        )
      })}
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
  if (!hasShift) {
    return <div className="rounded-md px-2 py-1.5 text-[11px]" style={{ background: 'var(--panel2)', color: 'var(--muted)' }}>No shift</div>
  }
  if (load && load.available_hours === 0) {
    return <div className="rounded-md px-2 py-1.5 text-[11px]" style={{ background: 'rgba(245,86,108,0.08)', color: 'var(--muted)' }}>Blocked · PTO</div>
  }
  const st = STATE_META[(load?.state || 'IDLE') as LoadState]
  const planned = load?.planned_squares ?? 0
  const cap = load?.capacity_squares ?? 0
  const fill = cap > 0 ? Math.min(1.25, planned / cap) : 0
  return (
    <div className="rounded-md px-2 py-1.5" style={{ background: 'var(--panel2)' }}>
      <div className="flex items-baseline justify-between">
        <div className="text-[14px] font-bold leading-none">
          {planned}<span className="text-[11px] font-medium" style={{ color: 'var(--muted)' }}>/{cap} sq</span>
        </div>
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
      style={{ background: storm ? 'rgba(245,178,46,0.15)' : 'rgba(255,255,255,0.05)', color: storm ? 'var(--tight)' : 'var(--muted)' }}
      title={`${pp}% precip`}>
      <span>{storm ? '⛈' : pp >= 30 ? '🌦' : '☀'}</span>
      {hi != null && <span>{hi}°</span>}
      <span>{pp}%</span>
    </span>
  )
}

function JobCard({
  start, end, status, seq, total, job, custLast, street, city, plannedSq, tags, buColor, storm,
}: {
  start: string; end: string; status: string; seq: number; total: number
  job: Job; custLast?: string; street?: string; city?: string; plannedSq: number
  tags: BoardData['tags']; buColor: string; storm: boolean
}) {
  const sc = STATUS_COLOR[status] || 'var(--muted)'
  const sq = job.squares != null ? num(job.squares) : null
  const isExterior = true
  const badges: { label: string; color: string }[] = []
  if (storm && isExterior) badges.push({ label: '⛈ Weather', color: 'var(--tight)' })
  if (job.priority === 'URGENT') badges.push({ label: 'Urgent', color: 'var(--over)' })
  const visTags = tags.slice(0, 2)
  const extra = tags.length - visTags.length

  return (
    <div className="relative overflow-hidden rounded-md pl-2 pr-2 py-1.5" style={{ background: `color-mix(in srgb, ${sc} 12%, var(--panel))` }}>
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
        {sq != null ? <span className="ml-1" style={{ color: 'var(--dawn)' }}>· {sq} sq</span>
          : <span className="ml-1 text-[11px] font-normal" style={{ color: 'var(--muted)' }}>· no measurements</span>}
      </div>
      <div className="truncate text-[11px]" style={{ color: 'var(--muted)' }}>
        {[custLast, street, city].filter(Boolean).join(' · ')}
      </div>
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
