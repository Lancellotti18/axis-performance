'use client'

/**
 * Lead problems — the admin review queue (Ryan only).
 *
 * Most claims never reach this page: when the county's current record
 * contradicts what was sold, the server approves the claim and credits a
 * replacement lead on the spot. What lands here is everything the record could
 * not settle, which is exactly the set that needs a person.
 *
 * The evidence the server gathered at the moment of the claim is shown with
 * each one, because a decision made days later cannot be a fair one otherwise.
 */
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import toast from 'react-hot-toast'
import { api, type AdminLeadProblem } from '@/lib/api'

const REASON_LABEL: Record<string, string> = {
  not_a_home: "Isn't a home",
  sold_before_purchase: 'Had already sold',
  record_wrong: 'Record is wrong',
}

const STATUS: Record<string, string> = {
  open: 'bg-amber-50 text-amber-800 ring-amber-400/30',
  approved: 'bg-emerald-50 text-emerald-800 ring-emerald-400/30',
  rejected: 'bg-[#eeeeed] text-[#6b7280] ring-slate-400/30',
}

const when = (iso?: string) => {
  if (!iso) return ''
  const d = new Date(iso)
  return isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  })
}

export default function LeadProblemsPage() {
  const [reports, setReports] = useState<AdminLeadProblem[] | null>(null)
  const [openCount, setOpenCount] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [denied, setDenied] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await api.billing.adminLeadProblems()
      setReports(r.reports)
      setOpenCount(r.open)
    } catch (e) {
      setReports([])
      const msg = e instanceof Error ? e.message : ''
      if (/\[HTTP 403\]/.test(msg)) setDenied(true)
      else toast.error(msg.replace(/\[HTTP \d+\]\s*/, '') || 'Could not load the queue.')
    }
  }, [])

  useEffect(() => { load() }, [load])

  const decide = async (r: AdminLeadProblem, approve: boolean,
                        resolution: 'replacement' | 'refund' | 'none') => {
    setBusy(r.id)
    try {
      const out = await api.billing.resolveLeadProblem(r.id, {
        approve, resolution, note: notes[r.id]?.trim() || undefined,
      })
      toast.success(
        out.refund_is_manual
          ? 'Recorded. Issue the refund in Stripe — this does not move money.'
          : approve ? `Approved. ${out.credits} replacement lead(s) on that account.`
            : 'Rejected.')
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message.replace(/\[HTTP \d+\]\s*/, '') : 'Could not save that.')
    } finally { setBusy(null) }
  }

  if (denied) {
    return (
      <div className="mx-auto max-w-2xl p-8">
        <h1 className="text-2xl font-bold text-[#1a1a1a]">Lead problems</h1>
        <p className="mt-2 text-sm text-[#6b7280]">This page is only available on an admin account.</p>
      </div>
    )
  }

  return (
    <div className="min-h-full">
      <div className="mx-auto max-w-4xl p-8">
        <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-[#1a1a1a]">Lead problems</h1>
            <p className="mt-1 text-sm text-[#6b7280]">
              Dud claims the county record couldn&apos;t settle on its own.
              {openCount > 0 && <span className="font-semibold text-amber-700"> {openCount} waiting.</span>}
            </p>
          </div>
          <Link href="/founders" className="rounded-xl border border-[#dededc] px-3 py-2 text-xs font-semibold text-[#4b5563] hover:bg-[#f8f8f7]">
            Founders &amp; Trials →
          </Link>
        </div>

        {reports === null ? (
          <div className="py-20 text-center text-sm text-[#6b7280]">Loading…</div>
        ) : reports.length === 0 ? (
          <div className="py-20 text-center">
            <div className="text-sm font-medium text-[#2d2d2d]">No dud claims</div>
            <div className="mt-1 text-xs text-[#6b7280]">
              Nobody has reported a problem with a lead they bought.
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {reports.map(r => (
              <div key={r.id} className="rounded-2xl border border-[#dededc] bg-[#f8f8f7] p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ring-1 ${STATUS[r.status] || STATUS.open}`}>
                        {r.status}
                      </span>
                      <span className="text-sm font-semibold text-[#1a1a1a]">
                        {REASON_LABEL[r.reason] || r.reason}
                      </span>
                      {r.auto_verified && (
                        <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-semibold text-blue-900">
                          auto-confirmed
                        </span>
                      )}
                    </div>
                    <div className="mt-1 truncate text-[12px] text-[#2d2d2d]">
                      {r.address || '—'}{r.owner ? ` · ${r.owner}` : ''}
                    </div>
                    <div className="mt-0.5 text-[11px] text-[#6b7280]">
                      {r.county} · ${r.price_usd ?? 50} · reported {when(r.created_at)}
                    </div>
                  </div>
                  <code className="rounded bg-white px-1.5 py-0.5 text-[10px] text-[#6b7280]">
                    {String(r.user_id).slice(0, 8)}
                  </code>
                </div>

                {r.detail && (
                  <p className="mt-2 rounded-lg bg-white px-3 py-2 text-[12px] leading-relaxed text-[#2d2d2d]">
                    “{r.detail}”
                  </p>
                )}

                {r.evidence && Object.keys(r.evidence).length > 0 && (
                  <div className="mt-2 rounded-lg border border-[#dededc] bg-white px-3 py-2">
                    <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-[#6b7280]">
                      What the county said when they reported it
                    </div>
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
                      {Object.entries(r.evidence).map(([k, v]) => (
                        <div key={k} className="flex gap-1.5">
                          <dt className="text-[#6b7280]">{k.replace(/_/g, ' ')}:</dt>
                          <dd className="min-w-0 truncate text-[#2d2d2d]">{String(v)}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                )}

                {r.status === 'open' ? (
                  <>
                    <input value={notes[r.id] || ''} placeholder="Note (what you checked)"
                      onChange={e => setNotes(n => ({ ...n, [r.id]: e.target.value }))}
                      className="mt-2.5 w-full rounded-xl border border-[#dededc] bg-white px-3 py-2 text-[12px] text-[#1a1a1a] focus:border-blue-400/40 focus:outline-none" />
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button onClick={() => decide(r, true, 'replacement')} disabled={busy === r.id}
                        className="rounded-lg bg-emerald-600 px-3 py-1.5 text-[11px] font-bold text-white hover:bg-emerald-500 disabled:opacity-50">
                        Approve → replacement lead
                      </button>
                      <button onClick={() => decide(r, true, 'refund')} disabled={busy === r.id}
                        className="rounded-lg border border-[#dededc] bg-white px-3 py-1.5 text-[11px] font-semibold text-[#4b5563] hover:bg-[#f8f8f7] disabled:opacity-50">
                        Approve → refund (manual in Stripe)
                      </button>
                      <button onClick={() => decide(r, false, 'none')} disabled={busy === r.id}
                        className="rounded-lg border border-[#dededc] bg-white px-3 py-1.5 text-[11px] font-semibold text-[#4b5563] hover:bg-[#f8f8f7] disabled:opacity-50">
                        Reject
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="mt-2 text-[11px] text-[#6b7280]">
                    {r.resolution === 'replacement' && 'Replacement lead credited.'}
                    {r.resolution === 'refund' && 'Refund agreed — issue it in Stripe if you haven’t.'}
                    {r.resolution === 'none' && 'No credit given.'}
                    {r.review_note && ` “${r.review_note}”`}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
