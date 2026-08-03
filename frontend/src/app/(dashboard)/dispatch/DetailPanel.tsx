'use client'

/**
 * Job detail slide-over. Shows the appointment/job, the measurement-driven
 * crew-days breakdown (so the dispatcher trusts the number — it shows its work),
 * and a status control. Editing writes through the same PATCH the board uses.
 */
import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import type { BoardData, CrewDaysBreakdown } from './lib/board'
import { num, patchAppointment, previewMove } from './lib/board'

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
        </div>
      </div>
    </div>
  )
}

const jobTypeLabel = (t: string) => t.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase())
