'use client'

/**
 * Public proposal page — the homeowner-facing good/better/best proposal.
 * LIGHT theme: homeowner-facing surfaces read clean/trustworthy in white.
 * Branded with the contractor's company; homeowner picks a tier and accepts
 * online. This is the last mile from measurement to signed job.
 */
import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'next/navigation'

import { api, type PublicProposal, type ProposalTier } from '@/lib/api'

const inputCls = 'rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20'

export default function PublicProposalPage() {
  const params = useParams<{ token: string }>()
  const token = params.token

  const [p, setP] = useState<PublicProposal | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [choosing, setChoosing] = useState<ProposalTier | null>(null)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [accepted, setAccepted] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!token) return
    api.roofProposals.publicGet(token)
      .then(setP)
      .catch(() => setNotFound(true))
  }, [token])

  const accept = useCallback(async () => {
    if (!choosing) return
    if (name.trim().length < 2) { setError('Please enter your name.'); return }
    setSubmitting(true); setError(null)
    try {
      const res = await api.roofProposals.publicAccept(token, {
        tier_name: choosing.name,
        name: name.trim(),
        email: email.trim() || undefined,
        note: note.trim() || undefined,
      })
      setAccepted(res.message)
      setChoosing(null)
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/\[HTTP \d+\]\s*/, '') : 'Could not accept — please call the contractor.')
    } finally {
      setSubmitting(false)
    }
  }, [choosing, name, email, note, token])

  const money = (v?: number | null) => v == null ? '—' : v.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

  if (notFound) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6 text-slate-600">
        This proposal link isn&apos;t valid — please contact your contractor for a fresh one.
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

  const isAccepted = p.status === 'accepted' || accepted != null
  const popularIdx = p.tiers.length >= 2 ? 1 : 0   // "Better" is the anchor

  return (
    <main
      className="min-h-screen px-4 py-10 text-slate-900 sm:px-8"
      style={{ background: 'linear-gradient(170deg, #f8fafc 0%, #eef4fb 55%, #f8fafc 100%)' }}
    >
      <div className="mx-auto max-w-4xl">
        {/* Contractor header */}
        <header className="mb-8 text-center">
          {p.logo_url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={p.logo_url} alt={p.company_name} className="mx-auto mb-3 h-24 sm:h-28 max-w-[340px] object-contain" />
          )}
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">{p.company_name}</h1>
          <div className="mt-1 text-xs text-slate-500">
            {[p.license_number ? `License ${p.license_number}` : null, p.phone, p.email].filter(Boolean).join(' · ')}
          </div>
        </header>

        {/* Property + measurement summary */}
        <section className="mb-8 rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_10px_40px_-12px_rgba(15,40,80,0.12)]">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.28em] text-blue-600/80">Roof replacement proposal</div>
          <div className="text-lg font-semibold text-slate-900">{p.address || 'Your property'}</div>
          <div className="mt-3 grid grid-cols-3 gap-3 text-center">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <div className="text-lg font-bold text-slate-900">{p.total_roof_sqft ? Math.round(p.total_roof_sqft).toLocaleString() : '—'} ft²</div>
              <div className="mt-0.5 text-[10px] uppercase tracking-wide text-slate-500">Measured roof area</div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <div className="text-lg font-bold text-slate-900">{p.squares ?? '—'}</div>
              <div className="mt-0.5 text-[10px] uppercase tracking-wide text-slate-500">Roofing squares</div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <div className="text-lg font-bold text-slate-900">{p.predominant_pitch || '—'}</div>
              <div className="mt-0.5 text-[10px] uppercase tracking-wide text-slate-500">Roof pitch</div>
            </div>
          </div>
          <p className="mt-2 text-[11px] text-slate-400">
            Measured from aerial + solar data{p.valid_until ? ` · proposal valid through ${p.valid_until}` : ''}.
          </p>
        </section>

        {isAccepted ? (
          <section className="rounded-2xl border border-emerald-200 bg-emerald-50 p-8 text-center shadow-sm">
            <div className="text-3xl">🎉</div>
            <h2 className="mt-2 text-xl font-bold text-emerald-800">
              {accepted || `Accepted — ${p.accepted_tier} option`}
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              {p.company_name} will contact you to confirm details and schedule the work.
            </p>
            {p.phone && (
              <a href={`tel:${p.phone}`} className="mt-4 inline-block rounded-lg bg-white px-4 py-2 text-xs font-semibold text-slate-700 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50">
                Questions? Call {p.phone}
              </a>
            )}
          </section>
        ) : (
          <>
            {/* Tier cards */}
            <div className="grid gap-4 md:grid-cols-3">
              {p.tiers.map((t, i) => (
                <div
                  key={t.name}
                  className={`relative flex flex-col rounded-2xl border bg-white p-5 ${
                    i === popularIdx
                      ? 'border-blue-400 shadow-[0_16px_44px_-14px_rgba(59,130,246,0.35)]'
                      : 'border-slate-200 shadow-[0_8px_30px_-14px_rgba(15,40,80,0.15)]'
                  }`}
                >
                  {i === popularIdx && !t.homeowner_pick && (
                    <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 rounded-full bg-blue-600 px-3 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
                      Most popular
                    </span>
                  )}
                  {t.homeowner_pick && (
                    <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 rounded-full bg-emerald-600 px-3 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
                      ★ Your pick
                    </span>
                  )}
                  {t.render_url && (
                    <div className="mb-3 overflow-hidden rounded-xl ring-1 ring-slate-200">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={t.render_url} alt={`Your roof in ${t.color_name || t.name}`} className="block aspect-[4/3] w-full object-cover" />
                      {t.color_name && (
                        <div className="bg-slate-900/80 px-2 py-1 text-center text-[10px] font-medium text-white">
                          Your home in {t.color_name}
                        </div>
                      )}
                    </div>
                  )}
                  <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-blue-600/80">{t.name}</div>
                  <div className="mt-1 text-base font-semibold text-slate-900">{t.headline}</div>
                  <div className="mt-3 text-3xl font-bold text-slate-900">{money(t.price)}</div>
                  <p className="mt-2 text-xs leading-relaxed text-slate-500">{t.description}</p>
                  <ul className="mt-3 flex-1 space-y-1.5">
                    {t.features.map(f => (
                      <li key={f} className="flex items-start gap-1.5 text-xs text-slate-600">
                        <span className="mt-0.5 text-emerald-500">✓</span>{f}
                      </li>
                    ))}
                  </ul>
                  <button
                    onClick={() => { setChoosing(t); setError(null) }}
                    className={`mt-4 rounded-lg py-2.5 text-sm font-semibold transition ${
                      i === popularIdx
                        ? 'text-white hover:scale-[1.02]'
                        : 'bg-slate-100 text-slate-800 ring-1 ring-slate-200 hover:bg-slate-200'
                    }`}
                    style={i === popularIdx ? { background: 'linear-gradient(180deg, #3B82F6 0%, #1E40AF 100%)', boxShadow: '0 6px 20px rgba(59,130,246,0.35)' } : undefined}
                  >Choose {t.name}</button>
                </div>
              ))}
            </div>

            {/* Accept modal */}
            {choosing && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm" onClick={() => setChoosing(null)}>
                <div
                  className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl"
                  onClick={e => e.stopPropagation()}
                >
                  <h3 className="text-lg font-bold text-slate-900">Accept the {choosing.name} option</h3>
                  <div className="mt-1 text-sm text-slate-500">{choosing.headline} — <strong className="text-slate-900">{money(choosing.price)}</strong></div>
                  <div className="mt-4 grid gap-2">
                    <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Your full name" className={inputCls} />
                    <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Email (optional)" className={inputCls} />
                    <textarea value={note} onChange={e => setNote(e.target.value)} placeholder="Anything the crew should know? (optional)"
                      className={`h-16 ${inputCls}`} />
                  </div>
                  {error && <p className="mt-2 text-xs text-rose-600">{error}</p>}
                  <div className="mt-4 flex gap-2">
                    <button onClick={accept} disabled={submitting}
                      className="flex-1 rounded-lg bg-emerald-600 py-2.5 text-sm font-semibold text-white shadow-[0_6px_18px_rgba(5,150,105,0.3)] hover:bg-emerald-500 disabled:opacity-50">
                      {submitting ? 'Accepting…' : `Accept — ${money(choosing.price)}`}
                    </button>
                    <button onClick={() => setChoosing(null)} className="rounded-lg bg-slate-100 px-4 text-sm text-slate-600 ring-1 ring-slate-200 hover:bg-slate-200">Back</button>
                  </div>
                  <p className="mt-3 text-[10px] text-slate-400">
                    Accepting signals your intent to move forward — {p.company_name} will confirm final details
                    and paperwork before any work begins.
                  </p>
                </div>
              </div>
            )}
          </>
        )}

        <p className="mt-8 text-center text-[10px] text-slate-400">Proposal generated with Axis Performance.</p>
      </div>
    </main>
  )
}
