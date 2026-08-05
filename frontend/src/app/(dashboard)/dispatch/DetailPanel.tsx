'use client'

/**
 * Job detail slide-over. Shows the appointment/job, the measurement-driven
 * crew-days breakdown (so the dispatcher trusts the number — it shows its work),
 * and a status control. Editing writes through the same PATCH the board uses.
 */
import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import type { BoardData, CrewDaysBreakdown, ProjectSearchResult } from './lib/board'
import { num, patchAppointment, previewMove, fetchAudit, fetchJobProject, searchProjects, linkJobProject, mediaUrl } from './lib/board'

const STATUSES = ['SCHEDULED', 'DISPATCHED', 'WORKING', 'PAUSED', 'DONE', 'HOLD', 'CANCELED', 'UNASSIGNED']

export default function DetailPanel({
  appointmentId, data, onClose, onPatched,
}: {
  appointmentId: string
  data: BoardData
  onClose: () => void
  onPatched: (slice: Awaited<ReturnType<typeof patchAppointment>>) => void
}) {
  const appt = data.appointments.find(a => a.id === appointmentId)
  const job = appt ? data.jobs.find(j => j.id === appt.job_id) : undefined
  const cust = job ? data.customers.find(c => c.id === job.customer_id) : undefined
  const prop = job ? data.properties.find(p => p.id === job.property_id) : undefined
  const crewId = appt ? data.appointment_crew[appt.id] : undefined
  const crew = crewId ? data.crews.find(c => c.id === crewId) : undefined
  const dateStr = appt ? appt.scheduled_start.slice(0, 10) : ''

  const [est, setEst] = useState<CrewDaysBreakdown | null>(null)
  const [savingStatus, setSavingStatus] = useState(false)
  const { data: history } = useQuery({ queryKey: ['audit', appointmentId], queryFn: () => fetchAudit(15, appointmentId), staleTime: 15_000 })

  useEffect(() => {
    if (!appt || !crewId) return
    let cancelled = false
    previewMove(appt.id, crewId, dateStr).then(p => { if (!cancelled) setEst(p.crew_days) }).catch(() => {})
    return () => { cancelled = true }
  }, [appt?.id, crewId, dateStr]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!appt || !job) return null

  const sq = job.squares != null ? num(job.squares) : null
  const series = data.appointments.filter(a => a.job_id === job.id).sort((a, b) => a.sequence - b.sequence)

  async function setStatus(status: string) {
    setSavingStatus(true)
    try {
      const slice = await patchAppointment(appointmentId, { status, request_id: crypto.randomUUID() })
      onPatched(slice)
      toast.success(`Status → ${status.toLowerCase()}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update status')
    } finally { setSavingStatus(false) }
  }

  const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
    <div className="flex justify-between gap-3 border-b py-1.5 text-[12px]" style={{ borderColor: 'var(--line)' }}>
      <span style={{ color: 'var(--muted)' }}>{k}</span>
      <span className="text-right font-semibold">{v}</span>
    </div>
  )

  return (
    <div className="fixed inset-0 z-40 flex justify-end" onClick={onClose}>
      <div className="h-full w-full max-w-md overflow-y-auto border-l shadow-2xl" onClick={e => e.stopPropagation()}
        style={{ background: 'var(--panel)', borderColor: 'var(--line)' }}>
        <div className="sticky top-0 flex items-center justify-between border-b px-5 py-3" style={{ background: 'var(--panel)', borderColor: 'var(--line)' }}>
          <div>
            <div className="text-[15px] font-bold">{jobTypeLabel(job.job_type)} <span className="text-[12px] font-normal" style={{ color: 'var(--muted)' }}>#{job.job_number}</span></div>
            <div className="text-[12px]" style={{ color: 'var(--muted)' }}>{[cust ? `${cust.first_name} ${cust.last_name}` : null, prop?.line1, prop?.city].filter(Boolean).join(' · ')}</div>
          </div>
          <button onClick={onClose} className="rounded-md px-2 py-1 text-sm hover:bg-white/5">✕</button>
        </div>

        <div className="space-y-5 p-5">
          {/* The linked roofing project — roof, report, crew photos */}
          <JobProjectSection jobId={job.id} />

          {/* Measurements + the crew-days calculation shown as work */}
          <section>
            <div className="mb-2 text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--muted)' }}>Measurements → production</div>
            <Row k="Squares" v={sq != null ? `${sq} sq` : <span style={{ color: 'var(--tight)' }}>none — needs measurement</span>} />
            <Row k="Pitch" v={job.predominant_pitch != null ? `${num(job.predominant_pitch)}/12` : '—'} />
            <Row k="Stories" v={job.stories ?? '—'} />
            <Row k="Tear-off layers" v={job.tear_off_layers} />
            <Row k="Waste factor" v={job.waste_factor_pct != null ? `${num(job.waste_factor_pct)}%` : '—'} />
            {crew && <Row k="Crew" v={`${crew.name} · ${num(crew.squares_per_day)} sq/day`} />}
            {est && (
              <div className="mt-3 rounded-lg p-3" style={{ background: 'var(--panel2)' }}>
                <div className="flex items-baseline justify-between">
                  <span className="text-[12px]" style={{ color: 'var(--muted)' }}>Estimated{est.is_estimated ? ' (no measurements)' : ''}</span>
                  <span className="text-[18px] font-bold" style={{ color: 'var(--dawn)' }}>{est.crew_days} crew-days</span>
                </div>
                {!est.is_estimated && (
                  <div className="mt-2 space-y-1 text-[11px]" style={{ color: 'var(--muted)' }}>
                    <div className="flex justify-between"><span>Install days</span><span>{est.install_days}</span></div>
                    <div className="flex justify-between"><span>Tear-off days</span><span>{est.tear_off_days}</span></div>
                    <div className="flex justify-between"><span>Pitch multiplier</span><span>×{est.pitch_multiplier}</span></div>
                    <div className="flex justify-between"><span>Story multiplier</span><span>×{est.story_multiplier}</span></div>
                  </div>
                )}
                {est.warnings.length > 0 && (
                  <div className="mt-2 text-[11px]" style={{ color: 'var(--tight)' }}>{est.warnings.map(w => w.replace(/_/g, ' ').toLowerCase()).join(' · ')}</div>
                )}
              </div>
            )}
          </section>

          {/* Schedule / series */}
          <section>
            <div className="mb-2 text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--muted)' }}>Schedule</div>
            {series.map(s => (
              <div key={s.id} className={`flex items-center justify-between rounded-md px-2.5 py-1.5 text-[12px] ${s.id === appt.id ? 'font-bold' : ''}`}
                style={{ background: s.id === appt.id ? 'var(--panel2)' : undefined }}>
                <span>{s.total_in_series > 1 ? `Day ${s.sequence}/${s.total_in_series}` : 'Single day'} · {s.scheduled_start.slice(0, 10)}</span>
                <span style={{ color: 'var(--muted)' }}>{s.planned_squares != null ? `${num(s.planned_squares)} sq` : ''} · {s.status.toLowerCase()}</span>
              </div>
            ))}
          </section>

          {/* Status control */}
          <section>
            <div className="mb-2 text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--muted)' }}>Status</div>
            <div className="flex flex-wrap gap-1.5">
              {STATUSES.map(s => (
                <button key={s} disabled={savingStatus} onClick={() => setStatus(s)}
                  className="rounded-md border px-2.5 py-1 text-[11px] font-semibold transition-colors disabled:opacity-50"
                  style={{
                    borderColor: 'var(--line)',
                    background: appt.status === s ? 'var(--sky)' : 'transparent',
                    color: appt.status === s ? '#04121f' : 'var(--text)',
                  }}>{s.toLowerCase()}</button>
              ))}
            </div>
          </section>

          {job.sold_amount != null && (
            <div className="text-[12px]" style={{ color: 'var(--muted)' }}>Sold: <span className="font-semibold" style={{ color: 'var(--text)' }}>${num(job.sold_amount).toLocaleString()}</span></div>
          )}

          {/* History for this job */}
          {history && history.events.length > 0 && (
            <section>
              <div className="mb-2 text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--muted)' }}>History</div>
              <div className="space-y-1.5">
                {history.events.map(ev => (
                  <div key={ev.id} className="flex items-baseline justify-between gap-3 text-[12px]">
                    <span className="min-w-0 flex-1">{ev.summary}</span>
                    <span className="shrink-0 text-[11px]" style={{ color: 'var(--muted)' }}>{ev.created_at ? new Date(ev.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}

const jobTypeLabel = (t: string) => t.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase())

// ── Linked roofing project: roof tile, stats, crew photos, deep links ─────────
function JobProjectSection({ jobId }: { jobId: string }) {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({ queryKey: ['job-project', jobId], queryFn: () => fetchJobProject(jobId), staleTime: 30_000 })
  const [busy, setBusy] = useState(false)

  const relink = async (projectId: string | null) => {
    setBusy(true)
    try {
      await linkJobProject(jobId, projectId)
      await qc.invalidateQueries({ queryKey: ['job-project', jobId] })
      toast.success(projectId ? 'Project linked' : 'Project unlinked')
    } catch { toast.error('Could not update the link') } finally { setBusy(false) }
  }

  if (isLoading) return <div className="h-24 animate-pulse rounded-xl" style={{ background: 'var(--panel2)' }} />

  if (!data?.linked || !data.project) return <ProjectPicker busy={busy} onPick={relink} />

  const p = data.project
  const thumb = mediaUrl(data.thumbnail_url)
  const stats = [
    data.squares != null ? `${data.squares} sq` : null,
    data.facet_count ? `${data.facet_count} facets` : null,
    data.roof_sqft != null ? `${Math.round(data.roof_sqft).toLocaleString()} ft²` : null,
  ].filter(Boolean).join(' · ')

  return (
    <section className="overflow-hidden rounded-xl border" style={{ borderColor: 'var(--line)', background: 'var(--panel2)' }}>
      {thumb ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={thumb} alt="Roof satellite" className="h-32 w-full object-cover" />
      ) : (
        <div className="flex h-20 items-center justify-center text-[11px]" style={{ color: 'var(--muted)' }}>No roof scan yet</div>
      )}
      <div className="space-y-2 p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-[13px] font-bold">{p.name}</div>
            {p.address && <div className="truncate text-[11px]" style={{ color: 'var(--muted)' }}>{p.address}</div>}
          </div>
          {p.status && <span className="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase" style={{ background: 'rgba(255,255,255,0.07)', color: 'var(--muted)' }}>{p.status}</span>}
        </div>
        {stats && <div className="text-[11px] font-semibold" style={{ color: 'var(--dawn)' }}>{stats}</div>}

        {data.photos && data.photos.length > 0 && (
          <div className="flex gap-1.5 overflow-x-auto pb-0.5">
            {data.photos.map((ph, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={i} src={mediaUrl(ph.url) || ''} alt={ph.caption || 'Job photo'} title={ph.caption || ph.phase || ''}
                className="h-12 w-12 shrink-0 rounded-md object-cover ring-1 ring-white/10" />
            ))}
          </div>
        )}

        <div className="flex flex-wrap gap-1.5 pt-0.5">
          <a href={`/projects/${p.id}`} target="_blank" rel="noreferrer"
            className="rounded-md px-2.5 py-1 text-[11px] font-bold" style={{ background: 'var(--sky)', color: '#04121f' }}>Open project ↗</a>
          {data.share_token && (
            <a href={`/crew/${data.share_token}`} target="_blank" rel="noreferrer"
              className="rounded-md border px-2.5 py-1 text-[11px] font-semibold hover:bg-white/5" style={{ borderColor: 'var(--line)' }}>Crew photos ↗</a>
          )}
          {data.has_report && (
            <a href={`/projects/${p.id}`} target="_blank" rel="noreferrer"
              className="rounded-md border px-2.5 py-1 text-[11px] font-semibold hover:bg-white/5" style={{ borderColor: 'var(--line)' }}>Report ↗</a>
          )}
          <button disabled={busy} onClick={() => relink(null)} className="ml-auto rounded-md px-2 py-1 text-[11px] disabled:opacity-50" style={{ color: 'var(--muted)' }}>Unlink</button>
        </div>
      </div>
    </section>
  )
}

function ProjectPicker({ busy, onPick }: { busy: boolean; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [results, setResults] = useState<ProjectSearchResult[]>([])
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancel = false
    setSearching(true)
    const t = setTimeout(() => {
      searchProjects(q).then(r => { if (!cancel) setResults(r.projects) }).catch(() => {}).finally(() => { if (!cancel) setSearching(false) })
    }, 250)
    return () => { cancel = true; clearTimeout(t) }
  }, [q, open])

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed py-3 text-[12px] font-semibold transition-colors hover:bg-white/5"
        style={{ borderColor: 'var(--line)', color: 'var(--muted)' }}>
        🔗 Link this job to a roofing project
      </button>
    )
  }
  return (
    <section className="rounded-xl border p-3" style={{ borderColor: 'var(--line)', background: 'var(--panel2)' }}>
      <div className="mb-2 flex items-center gap-2">
        <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search your projects…"
          className="flex-1 rounded-md border px-2 py-1.5 text-[12px]" style={{ background: 'var(--panel)', borderColor: 'var(--line)', color: 'var(--text)' }} />
        <button onClick={() => setOpen(false)} className="text-[12px]" style={{ color: 'var(--muted)' }}>Cancel</button>
      </div>
      <div className="max-h-56 space-y-1 overflow-y-auto">
        {searching && results.length === 0 ? (
          <div className="py-4 text-center text-[11px]" style={{ color: 'var(--muted)' }}>Searching…</div>
        ) : results.length === 0 ? (
          <div className="py-4 text-center text-[11px]" style={{ color: 'var(--muted)' }}>No projects found.</div>
        ) : results.map(r => (
          <button key={r.id} disabled={busy} onClick={() => onPick(r.id)}
            className="flex w-full items-center gap-2 rounded-md p-1.5 text-left hover:bg-white/5 disabled:opacity-50">
            {mediaUrl(r.thumbnail_url) ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={mediaUrl(r.thumbnail_url)!} alt="" className="h-9 w-9 shrink-0 rounded object-cover" />
            ) : <div className="h-9 w-9 shrink-0 rounded" style={{ background: 'var(--panel)' }} />}
            <div className="min-w-0">
              <div className="truncate text-[12px] font-semibold">{r.name}</div>
              {r.address && <div className="truncate text-[10px]" style={{ color: 'var(--muted)' }}>{r.address}</div>}
            </div>
          </button>
        ))}
      </div>
    </section>
  )
}
