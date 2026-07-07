'use client'

/**
 * Client portal — the homeowner's window into their roofing job.
 * One link, no account: status timeline, proposal, report, photos, and the
 * contractor's contact card. Light theme, matching /q and /p.
 */
import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'

import { api } from '@/lib/api'

type Portal = Awaited<ReturnType<typeof api.clientPortal.publicGet>>

const STAGE_LABELS: Record<string, { label: string; blurb: string }> = {
  measured: { label: 'Roof measured', blurb: 'Your roof has been measured from aerial + solar data.' },
  proposal: { label: 'Proposal sent', blurb: 'Your proposal is ready — review your options below.' },
  accepted: { label: 'Proposal accepted', blurb: 'You accepted a proposal. Scheduling is next.' },
  scheduled: { label: 'Job scheduled', blurb: 'Your installation date is on the calendar.' },
  in_progress: { label: 'Work in progress', blurb: 'The crew is on it.' },
  complete: { label: 'Complete', blurb: 'Your new roof is done — documents live here for your records.' },
}

export default function ClientPortalPage() {
  const params = useParams<{ token: string }>()
  const token = params.token
  const [p, setP] = useState<Portal | null>(null)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    if (!token) return
    api.clientPortal.publicGet(token).then(setP).catch(() => setNotFound(true))
  }, [token])

  const money = (v?: number | null) => v == null ? '—' : v.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

  if (notFound) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6 text-slate-600">
        This portal link isn&apos;t valid — ask your contractor to resend it.
      </main>
    )
  }
  if (!p) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
      </main>
    )
  }

  const stageIdx = Math.max(0, p.stages.indexOf(p.stage))
  const current = STAGE_LABELS[p.stage] || STAGE_LABELS.measured
  const c = p.contractor

  return (
    <main
      className="min-h-screen px-4 py-10 text-slate-900 sm:px-8"
      style={{ background: 'linear-gradient(170deg, #f8fafc 0%, #eef4fb 55%, #f8fafc 100%)' }}
    >
      <div className="mx-auto max-w-3xl">
        {/* Contractor header */}
        <header className="mb-8 text-center">
          {c.logo_url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={c.logo_url} alt={c.company_name || ''} className="mx-auto mb-3 h-12 object-contain" />
          )}
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{c.company_name || 'Your roofing contractor'}</h1>
          <div className="mt-1 text-xs text-slate-500">
            {[c.license_number ? `License ${c.license_number}` : null, c.phone, c.email].filter(Boolean).join(' · ')}
          </div>
        </header>

        {/* Status card */}
        <section className="mb-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_10px_40px_-12px_rgba(15,40,80,0.12)] sm:p-6">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.28em] text-blue-600/80">Your project</div>
          <div className="text-lg font-semibold">{p.address}</div>
          <div className="mt-1 text-sm text-slate-500">{current.blurb}</div>

          {/* Timeline */}
          <ol className="mt-5 space-y-0">
            {p.stages.map((s, i) => {
              const info = STAGE_LABELS[s] || { label: s, blurb: '' }
              const done = i < stageIdx
              const active = i === stageIdx
              return (
                <li key={s} className="relative flex items-start gap-3 pb-4 last:pb-0">
                  {/* connector */}
                  {i < p.stages.length - 1 && (
                    <span className={`absolute left-[11px] top-6 h-full w-0.5 ${done ? 'bg-emerald-400' : 'bg-slate-200'}`} />
                  )}
                  <span className={`relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
                    done ? 'bg-emerald-500 text-white'
                      : active ? 'bg-blue-600 text-white ring-4 ring-blue-100'
                      : 'bg-slate-200 text-slate-500'
                  }`}>{done ? '✓' : i + 1}</span>
                  <span className={`pt-0.5 text-sm ${active ? 'font-semibold text-slate-900' : done ? 'text-slate-600' : 'text-slate-400'}`}>
                    {info.label}
                  </span>
                </li>
              )
            })}
          </ol>
        </section>

        {/* Roof stats */}
        {(p.roof.total_roof_sqft || p.roof.squares) && (
          <section className="mb-6 grid grid-cols-3 gap-3">
            {[
              { v: p.roof.total_roof_sqft ? `${Math.round(p.roof.total_roof_sqft).toLocaleString()} ft²` : '—', l: 'Roof area' },
              { v: p.roof.squares != null ? String(p.roof.squares) : '—', l: 'Squares' },
              { v: p.roof.predominant_pitch || '—', l: 'Pitch' },
            ].map(x => (
              <div key={x.l} className="rounded-xl border border-slate-200 bg-white p-3 text-center shadow-sm">
                <div className="text-lg font-bold">{x.v}</div>
                <div className="mt-0.5 text-[10px] uppercase tracking-wide text-slate-500">{x.l}</div>
              </div>
            ))}
          </section>
        )}

        {/* Proposal */}
        {p.proposal && (
          <section className="mb-6 rounded-2xl border border-blue-200 bg-blue-50/60 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold">Your proposal</div>
                <div className="mt-0.5 text-xs text-slate-500">
                  {p.proposal.status === 'accepted'
                    ? <>✓ You accepted the <strong>{p.proposal.accepted_tier}</strong> option.</>
                    : <>Options from {money(p.proposal.price_low)} to {money(p.proposal.price_high)}{p.proposal.valid_until ? ` · valid through ${p.proposal.valid_until}` : ''}</>}
                </div>
              </div>
              <a
                href={`/p/${p.proposal.token}`}
                className="rounded-lg px-4 py-2.5 text-sm font-semibold text-white"
                style={{ background: 'linear-gradient(180deg, #3B82F6 0%, #1E40AF 100%)', boxShadow: '0 6px 20px rgba(59,130,246,0.35)' }}
              >{p.proposal.status === 'accepted' ? 'View proposal' : 'Review & accept →'}</a>
            </div>
          </section>
        )}

        {/* Report */}
        {p.report_url && (
          <section className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div>
              <div className="text-sm font-semibold">📄 Your roof report</div>
              <div className="mt-0.5 text-xs text-slate-500">Full measurement report — keep it for your records and insurance.</div>
            </div>
            <a href={p.report_url} target="_blank" rel="noreferrer"
              className="rounded-lg bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-800 ring-1 ring-slate-200 hover:bg-slate-200">
              Download PDF
            </a>
          </section>
        )}

        {/* Photos */}
        {p.photos.length > 0 && (
          <section className="mb-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="mb-3 text-sm font-semibold">📷 Project photos</div>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {p.photos.map((u, i) => (
                <a key={i} href={u} target="_blank" rel="noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={u} alt={`Project photo ${i + 1}`} className="aspect-square w-full rounded-lg object-cover ring-1 ring-slate-200" />
                </a>
              ))}
            </div>
          </section>
        )}

        {/* Contact */}
        {(c.phone || c.email) && (
          <section className="rounded-2xl border border-slate-200 bg-white p-5 text-center shadow-sm">
            <div className="text-sm font-semibold">Questions about your project?</div>
            <div className="mt-3 flex flex-wrap justify-center gap-2">
              {c.phone && (
                <>
                  <a href={`tel:${c.phone}`} className="rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-500">📞 Call</a>
                  <a href={`sms:${c.phone}`} className="rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-500">💬 Text</a>
                </>
              )}
              {c.email && (
                <a href={`mailto:${c.email}`} className="rounded-lg bg-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-200">✉ Email</a>
              )}
            </div>
          </section>
        )}

        <p className="mt-8 text-center text-[10px] text-slate-400">Powered by Axis Performance.</p>
      </div>
    </main>
  )
}
