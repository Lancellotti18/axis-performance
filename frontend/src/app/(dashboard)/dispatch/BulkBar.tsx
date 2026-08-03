'use client'

/**
 * Bulk action bar — appears when one or more grid cards are selected. Every action
 * runs a server dry-run first and shows a summary (what changes, and any BLOCK
 * conflicts) before you commit. Apply is transactional: all-or-nothing on a block.
 * A single Undo reverses the whole batch via the inverse-batch endpoint.
 */
import { useState } from 'react'
import toast from 'react-hot-toast'
import { bulkOp, bulkUndo, type AffectedMulti, type BulkResult, type Crew, type JobTag } from './lib/board'

const STATUSES = ['SCHEDULED', 'DISPATCHED', 'HOLD', 'CANCELED']
const opLabel: Record<string, string> = {
  REASSIGN: 'Reassign crew', SHIFT_DAYS: 'Shift days', MOVE_TO_DATE: 'Move to date',
  SET_STATUS: 'Set status', ADD_TAG: 'Add tag', UNASSIGN: 'Send to tray',
}

export default function BulkBar({
  ids, crews, tags, onApplied, onClear, onTrayInvalidate,
}: {
  ids: string[]
  crews: Crew[]
  tags: JobTag[]
  onApplied: (aff: AffectedMulti) => void
  onClear: () => void
  onTrayInvalidate: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [modal, setModal] = useState<{ op: string; payload: Record<string, unknown>; res: BulkResult } | null>(null)
  const n = ids.length

  async function preview(op: string, payload: Record<string, unknown>) {
    setBusy(true)
    try {
      const res = await bulkOp(ids, op, payload, true)
      setModal({ op, payload, res })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not preview')
    } finally { setBusy(false) }
  }

  async function apply() {
    if (!modal) return
    setBusy(true)
    try {
      const res = await bulkOp(ids, modal.op, modal.payload, false)
      if (!res.applied) {
        setModal(m => (m ? { ...m, res } : m))
        toast.error('Blocked — resolve the conflicts first.')
        return
      }
      if (res.affected) onApplied(res.affected)
      const batch = res.batch_id
      setModal(null); onTrayInvalidate(); onClear()
      toast((t) => (
        <span className="flex items-center gap-3 text-[13px]">
          {opLabel[modal.op] || 'Applied'} · {n} job{n === 1 ? '' : 's'}.
          <button className="font-bold underline" onClick={async () => {
            toast.dismiss(t.id)
            if (!batch) return
            try { const u = await bulkUndo(batch); onApplied(u.affected); onTrayInvalidate() }
            catch { toast.error('Undo failed.') }
          }}>Undo</button>
        </span>
      ), { duration: 15000 })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not apply')
    } finally { setBusy(false) }
  }

  const crewName = (id: string | null) => (id ? crews.find(c => c.id === id)?.name ?? 'crew' : '—')

  return (
    <>
      <div className="fixed inset-x-0 bottom-14 z-40 flex justify-center px-4">
        <div className="flex max-w-full items-center gap-2 overflow-x-auto rounded-full border px-3 py-2 shadow-2xl"
          style={{ background: 'var(--panel)', borderColor: 'var(--line)' }}>
          <span className="shrink-0 rounded-full px-2.5 py-1 text-[12px] font-bold" style={{ background: 'var(--sky)', color: '#04121f' }}>{n} selected</span>

          <select disabled={busy} defaultValue="" onChange={e => { if (e.target.value) { preview('REASSIGN', { crew_id: e.target.value }); e.target.value = '' } }}
            className="shrink-0 rounded-md border px-2 py-1 text-[12px]" style={{ background: 'var(--panel2)', borderColor: 'var(--line)', color: 'var(--text)' }}>
            <option value="">Reassign to…</option>
            {crews.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>

          <button disabled={busy} onClick={() => preview('SHIFT_DAYS', { days: 1 })} className="shrink-0 rounded-md border px-2.5 py-1 text-[12px] font-semibold hover:bg-white/5" style={{ borderColor: 'var(--line)' }}>+1 day</button>
          <button disabled={busy} onClick={() => preview('SHIFT_DAYS', { days: -1 })} className="shrink-0 rounded-md border px-2.5 py-1 text-[12px] font-semibold hover:bg-white/5" style={{ borderColor: 'var(--line)' }}>−1 day</button>

          <input type="date" disabled={busy} onChange={e => { if (e.target.value) preview('MOVE_TO_DATE', { date: e.target.value }) }}
            className="shrink-0 rounded-md border px-2 py-1 text-[12px]" style={{ background: 'var(--panel2)', borderColor: 'var(--line)', color: 'var(--text)' }} title="Move all to a date" />

          <select disabled={busy} defaultValue="" onChange={e => { if (e.target.value) { preview('SET_STATUS', { status: e.target.value }); e.target.value = '' } }}
            className="shrink-0 rounded-md border px-2 py-1 text-[12px]" style={{ background: 'var(--panel2)', borderColor: 'var(--line)', color: 'var(--text)' }}>
            <option value="">Set status…</option>
            {STATUSES.map(s => <option key={s} value={s}>{s.toLowerCase()}</option>)}
          </select>

          {tags.length > 0 && (
            <select disabled={busy} defaultValue="" onChange={e => { if (e.target.value) { preview('ADD_TAG', { tag_id: e.target.value }); e.target.value = '' } }}
              className="shrink-0 rounded-md border px-2 py-1 text-[12px]" style={{ background: 'var(--panel2)', borderColor: 'var(--line)', color: 'var(--text)' }}>
              <option value="">Add tag…</option>
              {tags.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          )}

          <button disabled={busy} onClick={() => preview('UNASSIGN', {})} className="shrink-0 rounded-md border px-2.5 py-1 text-[12px] font-semibold hover:bg-white/5" style={{ borderColor: 'var(--line)' }}>Send to tray</button>
          <button onClick={onClear} className="shrink-0 rounded-md px-2 py-1 text-[12px]" style={{ color: 'var(--muted)' }}>Clear</button>
        </div>
      </div>

      {modal && (
        <SummaryModal modal={modal} busy={busy} crewName={crewName} onApply={apply} onCancel={() => setModal(null)} />
      )}
    </>
  )
}

function SummaryModal({
  modal, busy, crewName, onApply, onCancel,
}: {
  modal: { op: string; payload: Record<string, unknown>; res: BulkResult }
  busy: boolean
  crewName: (id: string | null) => string
  onApply: () => void
  onCancel: () => void
}) {
  const changes = modal.res.changes || []
  const conflicts = modal.res.conflicts || {}
  const blockedIds = Object.keys(conflicts)
  const hasBlocks = blockedIds.length > 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onCancel}>
      <div className="w-full max-w-lg overflow-hidden rounded-xl border shadow-2xl" onClick={e => e.stopPropagation()}
        style={{ background: 'var(--panel)', borderColor: 'var(--line)' }}>
        <div className="border-b px-5 py-3" style={{ borderColor: 'var(--line)' }}>
          <div className="text-[15px] font-bold">{opLabel[modal.op] || modal.op} · {changes.length} job{changes.length === 1 ? '' : 's'}</div>
          {hasBlocks && <div className="mt-0.5 text-[12px] font-semibold" style={{ color: 'var(--over)' }}>{blockedIds.length} blocked — nothing applies until these clear.</div>}
        </div>

        <div className="max-h-[45vh] overflow-y-auto px-5 py-3">
          <div className="space-y-1">
            {changes.map(c => {
              const blocks = conflicts[c.id] || []
              return (
                <div key={c.id} className="flex items-center gap-3 rounded-md px-2 py-1.5 text-[12px]" style={{ background: 'var(--panel2)' }}>
                  <span className="w-10 shrink-0 font-mono text-[11px]" style={{ color: 'var(--muted)' }}>#{c.job_number ?? '—'}</span>
                  <span className="shrink-0" style={{ color: 'var(--muted)' }}>
                    {crewName(c.from.crew_id)} {c.from.date?.slice(5) ?? ''}
                  </span>
                  <span style={{ color: 'var(--sky)' }}>→</span>
                  <span className="font-semibold">
                    {crewName(c.to.crew_id)} {c.to.date?.slice(5) ?? ''}
                  </span>
                  {blocks.length > 0 && <span className="ml-auto rounded px-1 py-0.5 text-[9px] font-bold" style={{ background: 'color-mix(in srgb, var(--over) 20%, transparent)', color: 'var(--over)' }} title={blocks.map(b => b.message).join(' · ')}>⃠ {blocks[0].message}</span>}
                </div>
              )
            })}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-5 py-3" style={{ borderColor: 'var(--line)' }}>
          <button onClick={onCancel} className="rounded-md px-3 py-1.5 text-[12px] font-semibold hover:bg-white/5" style={{ color: 'var(--muted)' }}>Cancel</button>
          <button onClick={onApply} disabled={busy || hasBlocks}
            className="rounded-md px-4 py-1.5 text-[12px] font-bold disabled:opacity-40"
            style={{ background: hasBlocks ? 'var(--panel2)' : 'var(--dawn)', color: hasBlocks ? 'var(--muted)' : '#1a0e05' }}>
            {hasBlocks ? 'Resolve conflicts' : `Apply to ${changes.length}`}
          </button>
        </div>
      </div>
    </div>
  )
}
