'use client'

/**
 * Founders & Trials — admin only (the server refuses everyone else).
 *
 * Every company code: who it was for, whether it has been redeemed and by
 * which account, where that account's 7-day trial stands, whether they
 * subscribed, and every report they made. Also where codes are created.
 */
import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { api, type FounderRow } from '@/lib/api'

const STATE_STYLE: Record<FounderRow['state'], string> = {
  unused: 'bg-[#eeeeed] text-[#2d2d2d]',
  expired: 'bg-rose-100 text-rose-800',
  trial: 'bg-emerald-100 text-emerald-800',
  'trial ended': 'bg-amber-100 text-amber-900',
  subscribed: 'bg-blue-100 text-blue-800',
}

function fmt(d: string | null | undefined) {
  if (!d) return '—'
  const t = new Date(d)
  return Number.isNaN(t.getTime()) ? '—' : t.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export default function FoundersPage() {
  const [rows, setRows] = useState<FounderRow[] | null>(null)
  const [denied, setDenied] = useState(false)
  const [enforcing, setEnforcing] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [company, setCompany] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await api.billing.founders()
      setRows(r.codes); setEnforcing(r.enforcing)
    } catch {
      setDenied(true)
    }
  }, [])
  useEffect(() => { void load() }, [load])

  async function create() {
    if (!code.trim() || !company.trim()) { toast.error('Enter a code and the company it is for.'); return }
    setBusy(true)
    try {
      await api.billing.createCode({ code: code.trim(), company: company.trim() })
      toast.success(`${code.trim().toUpperCase()} created`)
      setCode(''); setCompany('')
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create the code')
    } finally { setBusy(false) }
  }

  function copyLink(c: string) {
    const link = `${window.location.origin}/register?code=${encodeURIComponent(c)}`
    navigator.clipboard?.writeText(link).then(() => toast.success('Sign-up link copied'), () => toast(link))
  }

  if (denied) return <div className="p-8 text-sm text-[#6b7280]">This page isn&apos;t available.</div>
  if (!rows) return <div className="p-8 text-sm text-[#6b7280]">Loading…</div>

  const count = (s: FounderRow['state']) => rows.filter(r => r.state === s).length
  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <header>
        <h1 className="text-xl font-bold text-[#1a1a1a]">Founders &amp; Trials</h1>
        <p className="mt-1 text-sm text-[#6b7280]">
          Each code works once: 3 free reports and 7 days of full access from the moment it&apos;s redeemed,
          and that account becomes a founding member. Unused codes expire after 60 days.
          {!enforcing && <strong className="text-amber-700"> Billing enforcement is OFF — nothing is locked yet.</strong>}
        </p>
      </header>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {(['unused', 'trial', 'trial ended', 'subscribed', 'expired'] as const).map(s => (
          <div key={s} className="rounded-lg border border-[#dededc] bg-white p-3">
            <div className="text-2xl font-bold text-[#1a1a1a]">{count(s)}</div>
            <div className="text-xs capitalize text-[#6b7280]">{s}</div>
          </div>
        ))}
      </div>

      <section className="rounded-xl border border-[#dededc] bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-[#1a1a1a]">New code</h2>
        <div className="flex flex-wrap gap-2">
          <input value={code} onChange={e => setCode(e.target.value.toUpperCase())} maxLength={32}
            placeholder="CODE (e.g. FORTITUDE)" aria-label="Code"
            className="w-48 rounded-md border border-[#dededc] bg-[#f8f8f7] px-3 py-2 text-sm uppercase" />
          <input value={company} onChange={e => setCompany(e.target.value)} maxLength={120}
            placeholder="Company it's for" aria-label="Company"
            className="min-w-[220px] flex-1 rounded-md border border-[#dededc] bg-[#f8f8f7] px-3 py-2 text-sm" />
          <button onClick={() => void create()} disabled={busy}
            className="rounded-md bg-[#1a1a1a] px-4 py-2 text-sm font-semibold text-white hover:bg-black disabled:opacity-50">
            {busy ? 'Creating…' : 'Create code'}
          </button>
        </div>
      </section>

      <section className="overflow-x-auto rounded-xl border border-[#dededc] bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-[#dededc] bg-[#f8f8f7] text-xs uppercase tracking-wide text-[#6b7280]">
            <tr>
              <th className="px-4 py-2">Company</th><th className="px-4 py-2">Code</th>
              <th className="px-4 py-2">Status</th><th className="px-4 py-2">Redeemed</th>
              <th className="px-4 py-2">Trial</th><th className="px-4 py-2">Reports made</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-6 text-center text-[#6b7280]">No codes yet. Create one above.</td></tr>
            )}
            {rows.map(r => (
              <FounderRowView key={r.code} r={r} open={open === r.code}
                onToggle={() => setOpen(open === r.code ? null : r.code)} onCopy={() => copyLink(r.code)} />
            ))}
          </tbody>
        </table>
      </section>
    </div>
  )
}

function FounderRowView({ r, open, onToggle, onCopy }: {
  r: FounderRow; open: boolean; onToggle: () => void; onCopy: () => void
}) {
  const trial = r.promo
    ? r.promo.active
      ? `${r.promo.days_left}d · ${r.promo.reports_left}/${r.promo.reports_total} reports left`
      : `ended ${fmt(r.promo.access_until)}`
    : '—'
  return (
    <>
      <tr className="border-b border-[#eeeeed] align-top">
        <td className="px-4 py-3 font-medium text-[#1a1a1a]">{r.company}</td>
        <td className="px-4 py-3 font-mono text-xs">{r.code}</td>
        <td className="px-4 py-3">
          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold capitalize ${STATE_STYLE[r.state]}`}>
            {r.state === 'subscribed' && r.plan_key ? `subscribed · ${r.plan_key}` : r.state}
          </span>
        </td>
        <td className="px-4 py-3 text-xs text-[#2d2d2d]">
          {r.redeemed_at ? <>{fmt(r.redeemed_at)}<div className="text-[#6b7280]">{r.account_email || '—'}</div></> : <span className="text-[#6b7280]">expires {fmt(r.expires_at)}</span>}
        </td>
        <td className="px-4 py-3 text-xs text-[#2d2d2d]">{trial}</td>
        <td className="px-4 py-3">
          {r.reports.length ? (
            <button onClick={onToggle} className="text-xs font-semibold text-blue-700 underline underline-offset-2">
              {r.reports.length} {open ? '▾' : '▸'}
            </button>
          ) : <span className="text-xs text-[#6b7280]">0</span>}
        </td>
        <td className="px-4 py-3 text-right">
          {r.state === 'unused' && (
            <button onClick={onCopy} className="rounded border border-[#dededc] px-2 py-1 text-xs hover:bg-[#f8f8f7]">
              Copy sign-up link
            </button>
          )}
        </td>
      </tr>
      {open && r.reports.length > 0 && (
        <tr className="border-b border-[#eeeeed] bg-[#fafaf9]">
          <td colSpan={7} className="px-4 py-3">
            <ul className="space-y-1 text-xs text-[#2d2d2d]">
              {r.reports.map(rep => (
                <li key={`${rep.run_id}-${rep.created_at}`} className="flex justify-between gap-4">
                  <span>{rep.address}</span><span className="text-[#6b7280]">{fmt(rep.created_at)}</span>
                </li>
              ))}
            </ul>
          </td>
        </tr>
      )}
    </>
  )
}
