'use client'

/**
 * Crew & time-off management (M7) — the admin the board was missing: add / edit /
 * remove crews (capacity, pitch/story limits, business unit) and manage
 *
 * The Lead picker was removed: it could only ever offer the four seeded demo
 * foremen, because nothing in the app creates people, and a crew's lead_id is
 * purely cosmetic — it prints a name on the crew rail and drives no logic. The
 * column and the rail display stay, so a crew that already has a lead keeps it
 * and the field is ready if person management is ever built.
 * each crew's time off. New crews get regular shifts generated so they're
 * immediately schedulable. Changes invalidate the board so the grid reflects them.
 */
import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import type { BoardData, Crew, CrewInput, TimeOffEvent } from './lib/board'
import { num, createCrew, updateCrew, deleteCrew, listTimeOff, addTimeOff, deleteTimeOff } from './lib/board'

const WEEKDAYS = [['Mon', 0], ['Tue', 1], ['Wed', 2], ['Thu', 3], ['Fri', 4], ['Sat', 5], ['Sun', 6]] as const
const INPUT_CLS = 'w-full rounded-md border px-2 py-1.5 text-[12px]'
const INPUT_STYLE = { background: 'var(--panel)', borderColor: 'var(--line)', color: 'var(--text)' } as React.CSSProperties

// Defined at module scope (NOT inside CrewForm) so typing doesn't remount inputs.
function CrewField({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="text-[11px] font-medium" style={{ color: 'var(--muted)' }}>{label}<div className="mt-1">{children}</div></label>
}
const DEFAULTS: CrewInput = { name: '', business_unit_id: '', squares_per_day: 25, tear_off_squares_per_day: 15, max_pitch: 9, max_stories: 2, lead_id: null, shift_weekdays: [0, 1, 2, 3, 4], shift_start: '07:00', shift_end: '15:30', shift_weeks: 8 }

export default function CrewManager({ data, onClose }: { data: BoardData; onClose: () => void }) {
  const qc = useQueryClient()
  const [addOpen, setAddOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [timeoffId, setTimeoffId] = useState<string | null>(null)
  const buName = (id: string) => data.business_units.find(b => b.id === id)?.name ?? '—'
  const refresh = () => qc.invalidateQueries({ queryKey: ['board'] })

  return (
    <div className="fixed inset-0 z-40 flex justify-end" onClick={onClose}>
      <div className="h-full w-full max-w-lg overflow-y-auto border-l shadow-2xl" onClick={e => e.stopPropagation()}
        style={{ background: 'var(--panel)', borderColor: 'var(--line)' }}>
        <div className="sticky top-0 z-10 flex items-center justify-between border-b px-5 py-3" style={{ background: 'var(--panel)', borderColor: 'var(--line)' }}>
          <div>
            <div className="text-[15px] font-bold">Crews</div>
            <div className="text-[12px]" style={{ color: 'var(--muted)' }}>{data.crews.length} crew{data.crews.length === 1 ? '' : 's'} · capacity, limits, and time off</div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => { setAddOpen(o => !o); setEditingId(null) }} className="rounded-md px-3 py-1.5 text-[12px] font-bold" style={{ background: 'var(--dawn)', color: '#ffffff' }}>{addOpen ? 'Cancel' : '＋ Add crew'}</button>
            <button onClick={onClose} className="rounded-md px-2 py-1 text-sm hover:bg-[#eeeeed]">✕</button>
          </div>
        </div>

        <div className="space-y-3 p-4">
          {addOpen && (
            <CrewForm data={data} initial={DEFAULTS} isNew onCancel={() => setAddOpen(false)}
              onSubmit={async (body) => { await createCrew(body); toast.success('Crew added'); setAddOpen(false); refresh() }} />
          )}

          {data.crews.map(crew => editingId === crew.id ? (
            <CrewForm key={crew.id} data={data} initial={crewToInput(crew)} onCancel={() => setEditingId(null)}
              onSubmit={async (body) => { await updateCrew(crew.id, body); toast.success('Crew updated'); setEditingId(null); refresh() }} />
          ) : (
            <div key={crew.id} className="rounded-xl border p-3" style={{ borderColor: 'var(--line)', background: 'var(--panel2)' }}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-bold">{crew.name}</div>
                  <div className="mt-0.5 text-[11px]" style={{ color: 'var(--muted)' }}>
                    {buName(crew.business_unit_id)} · {num(crew.squares_per_day)} sq/day · tear-off {num(crew.tear_off_squares_per_day)} · ≤{num(crew.max_pitch)}/12 · {crew.max_stories} stor{crew.max_stories === 1 ? 'y' : 'ies'}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <button onClick={() => { setTimeoffId(timeoffId === crew.id ? null : crew.id) }} className="rounded-md border px-2 py-1 text-[11px] font-semibold hover:bg-[#eeeeed]" style={{ borderColor: 'var(--line)' }}>Time off</button>
                  <button onClick={() => { setEditingId(crew.id); setAddOpen(false) }} className="rounded-md border px-2 py-1 text-[11px] font-semibold hover:bg-[#eeeeed]" style={{ borderColor: 'var(--line)' }}>Edit</button>
                  <button onClick={async () => {
                    if (!confirm(`Remove ${crew.name}? This clears its shifts and time off. Finished jobs keep their history.`)) return
                    try {
                      const res = await deleteCrew(crew.id)
                      // A crew with completed work is archived, not deleted, so
                      // the record of who did those jobs survives. Say so —
                      // otherwise "removed" is a quiet half-truth.
                      toast.success(res.archived
                        ? `${crew.name} archived — off the board, ${res.completed_jobs} completed job${res.completed_jobs === 1 ? '' : 's'} keep their history`
                        : 'Crew removed')
                      refresh()
                    } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not remove crew') }
                  }} className="rounded-md px-2 py-1 text-[11px]" style={{ color: 'var(--over)' }}>Delete</button>
                </div>
              </div>
              {timeoffId === crew.id && <TimeOffPanel crew={crew} onChanged={refresh} />}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function crewToInput(c: Crew): CrewInput {
  return { name: c.name, business_unit_id: c.business_unit_id, squares_per_day: num(c.squares_per_day), tear_off_squares_per_day: num(c.tear_off_squares_per_day), max_pitch: num(c.max_pitch), max_stories: c.max_stories, lead_id: c.lead_id }
}

function CrewForm({ data, initial, isNew, onSubmit, onCancel }: {
  data: BoardData; initial: CrewInput; isNew?: boolean
  onSubmit: (body: CrewInput) => Promise<void>; onCancel: () => void
}) {
  const [f, setF] = useState<CrewInput>(initial)
  const [busy, setBusy] = useState(false)
  const set = <K extends keyof CrewInput>(k: K, v: CrewInput[K]) => setF(prev => ({ ...prev, [k]: v }))
  const toggleDay = (d: number) => set('shift_weekdays', (f.shift_weekdays || []).includes(d) ? (f.shift_weekdays || []).filter(x => x !== d) : [...(f.shift_weekdays || []), d].sort())

  const submit = async () => {
    if (!f.name.trim()) { toast.error('Name the crew'); return }
    if (!f.business_unit_id) { toast.error('Pick a business unit'); return }
    setBusy(true)
    try { await onSubmit({ ...f, name: f.name.trim() }) }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Could not save') }
    finally { setBusy(false) }
  }

  const inputCls = INPUT_CLS
  const inputStyle = INPUT_STYLE

  return (
    <div className="rounded-xl border p-3" style={{ borderColor: 'var(--sky)', background: 'var(--panel2)' }}>
      <div className="mb-2 text-[12px] font-bold">{isNew ? 'New crew' : 'Edit crew'}</div>
      <div className="grid grid-cols-2 gap-2">
        <div className="col-span-2"><CrewField label="Crew name"><input className={inputCls} style={inputStyle} value={f.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Kevin's Crew" /></CrewField></div>
        <CrewField label="Business unit">
          <select className={inputCls} style={inputStyle} value={f.business_unit_id} onChange={e => set('business_unit_id', e.target.value)}>
            <option value="">Select…</option>
            {data.business_units.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </CrewField>
        <CrewField label="Squares / day"><input type="number" className={inputCls} style={inputStyle} value={f.squares_per_day} onChange={e => set('squares_per_day', parseFloat(e.target.value) || 0)} /></CrewField>
        <CrewField label="Tear-off sq / day"><input type="number" className={inputCls} style={inputStyle} value={f.tear_off_squares_per_day} onChange={e => set('tear_off_squares_per_day', parseFloat(e.target.value) || 0)} /></CrewField>
        <CrewField label="Max pitch (/12)"><input type="number" className={inputCls} style={inputStyle} value={f.max_pitch} onChange={e => set('max_pitch', parseFloat(e.target.value) || 0)} /></CrewField>
        <CrewField label="Max stories"><input type="number" className={inputCls} style={inputStyle} value={f.max_stories} onChange={e => set('max_stories', parseInt(e.target.value) || 1)} /></CrewField>
      </div>

      {isNew && (
        <div className="mt-3 rounded-lg border border-[#dededc] p-2.5">
          <div className="mb-1.5 text-[11px] font-semibold" style={{ color: 'var(--muted)' }}>Working days (shifts generated for {f.shift_weeks} weeks)</div>
          <div className="flex flex-wrap gap-1">
            {WEEKDAYS.map(([lbl, d]) => (
              <button key={d} onClick={() => toggleDay(d)} className="rounded-md border px-2 py-1 text-[11px] font-semibold" style={{ borderColor: (f.shift_weekdays || []).includes(d) ? 'var(--sky)' : 'var(--line)', background: (f.shift_weekdays || []).includes(d) ? 'var(--sky)' : 'transparent', color: (f.shift_weekdays || []).includes(d) ? '#ffffff' : 'var(--text)' }}>{lbl}</button>
            ))}
            <div className="ml-auto flex items-center gap-1 text-[11px]" style={{ color: 'var(--muted)' }}>
              <input type="time" className="rounded border px-1 py-0.5" style={inputStyle} value={f.shift_start} onChange={e => set('shift_start', e.target.value)} />
              <span>–</span>
              <input type="time" className="rounded border px-1 py-0.5" style={inputStyle} value={f.shift_end} onChange={e => set('shift_end', e.target.value)} />
            </div>
          </div>
        </div>
      )}

      <div className="mt-3 flex justify-end gap-2">
        <button onClick={onCancel} className="rounded-md px-3 py-1.5 text-[12px] font-semibold hover:bg-[#eeeeed]" style={{ color: 'var(--muted)' }}>Cancel</button>
        <button onClick={submit} disabled={busy} className="rounded-md px-4 py-1.5 text-[12px] font-bold disabled:opacity-50" style={{ background: 'var(--dawn)', color: '#ffffff' }}>{isNew ? 'Add crew' : 'Save'}</button>
      </div>
    </div>
  )
}

function TimeOffPanel({ crew, onChanged }: { crew: Crew; onChanged: () => void }) {
  const [events, setEvents] = useState<TimeOffEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [title, setTitle] = useState('Time off')
  const [busy, setBusy] = useState(false)

  const load = () => { setLoading(true); listTimeOff(crew.id).then(r => setEvents(r.events)).catch(() => {}).finally(() => setLoading(false)) }
  useEffect(() => { load() }, [crew.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const add = async () => {
    if (!start || !end) { toast.error('Pick a start and end date'); return }
    setBusy(true)
    try { await addTimeOff({ crew_id: crew.id, title: title.trim() || 'Time off', start_date: start, end_date: end }); toast.success('Time off added'); setStart(''); setEnd(''); load(); onChanged() }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Could not add') } finally { setBusy(false) }
  }
  const remove = async (id: string) => { try { await deleteTimeOff(id); load(); onChanged() } catch { toast.error('Could not remove') } }

  const inputStyle = { background: 'var(--panel)', borderColor: 'var(--line)', color: 'var(--text)' } as React.CSSProperties
  return (
    <div className="mt-3 border-t pt-3" style={{ borderColor: 'var(--line)' }}>
      <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>Time off</div>
      {loading ? <div className="text-[11px]" style={{ color: 'var(--muted)' }}>Loading…</div> : events.length === 0 ? (
        <div className="text-[11px]" style={{ color: 'var(--muted)' }}>No time off scheduled.</div>
      ) : (
        <div className="space-y-1">
          {events.map(ev => (
            <div key={ev.id} className="flex items-center justify-between gap-2 rounded-md px-2 py-1 text-[11px]" style={{ background: 'var(--panel)' }}>
              <span><strong>{ev.title}</strong> · {ev.start_at.slice(5, 10)} → {ev.end_at.slice(5, 10)}{ev.blocks_capacity ? '' : ' (soft)'}</span>
              <button onClick={() => remove(ev.id)} className="shrink-0" style={{ color: 'var(--over)' }}>Remove</button>
            </div>
          ))}
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Reason" className="w-24 rounded border px-1.5 py-1 text-[11px]" style={inputStyle} />
        <input type="date" value={start} onChange={e => setStart(e.target.value)} className="rounded border px-1.5 py-1 text-[11px]" style={inputStyle} />
        <span style={{ color: 'var(--muted)' }}>→</span>
        <input type="date" value={end} onChange={e => setEnd(e.target.value)} className="rounded border px-1.5 py-1 text-[11px]" style={inputStyle} />
        <button onClick={add} disabled={busy} className="rounded-md px-2.5 py-1 text-[11px] font-bold disabled:opacity-50" style={{ background: 'var(--sky)', color: '#ffffff' }}>Add</button>
      </div>
    </div>
  )
}
