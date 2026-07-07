'use client'

/**
 * Public proposal page — the homeowner-facing good/better/best proposal.
 * Branded with the contractor's company; homeowner picks a tier and accepts
 * online. This is the last mile from measurement to signed job.
 */
import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'next/navigation'

import { api, type PublicProposal, type ProposalTier } from '@/lib/api'

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
      <main className="flex min-h-screen items-center justify-center bg-[#060b18] p-6 text-slate-300">
        This proposal link isn&apos;t valid — please contact your contractor for a fresh one.
      </main>
    )
  }
  if (!p) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#060b18]">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-blue-400 border-t-transparent" />
      </main>
    )
  }

  const isAccepted = p.status === 'accepted' || accepted != null
  const popularIdx = p.tiers.length >= 2 ? 1 : 0   // "Better" is the anchor

  return (
    <main className="min-h-screen bg-[#060b18] px-4 py-10 text-slate-100 sm:px-8">
      <div className="mx-auto max-w-4xl">
        {/* Contractor header */}
        <header className="mb-8 text-center">
          {p.logo_url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={p.logo_url} alt={p.company_name} className="mx-auto mb-3 h-12 object-contain" />
          )}
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{p.company_name}</h1>
          <div className="mt-1 text-xs text-slate-400">
            {[p.license_number ? `License ${p.license_number}` : null, p.phone, p.email].filter(Boolean).join(' · ')}
          </div>
        </header>

        {/* Property + measurement summary */}
        <section
          className="mb-8 rounded-2xl border border-white/10 p-5"
          style={{ background: 'linear-gradient(160deg, rgba(15,23,42,0.9), rgba(8,13,28,0.95))' }}
        >
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.28em] text-blue-300/80">Roof replacement proposal</div>
          <div className="text-lg font-semibold text-white">{p.address || 'Your property'}</div>
          <div className="mt-3 grid grid-cols-3 gap-3 text-center">
            <div className="rounded-xl border border-white/10 bg-slate-800/50 p-3">
              <div className="text-lg font-bold text-white">{p.total_roof_sqft ? Math.round(p.total_roof_sqft).toLocaleString() : '—'} ft²</div>
              <div className="mt-0.5 text-[10px] uppercase tracking-wide text-slate-500">Measured roof area</div>
            </div>
            <div className="rounded-xl border border-white/10 bg-slate-800/50 p-3">
              <div className="text-lg font-bold text-white">{p.squares ?? '—'}</div>
              <div className="mt-0.5 text-[10px] uppercase tracking-wide text-slate-500">Roofing squares</div>
            </div>
            <div className="rounded-xl border border-white/10 bg-slate-800/50 p-3">
              <div className="text-lg font-bold text-white">{p.predominant_pitch || '—'}</div>
              <div className="mt-0.5 text-[10px] uppercase tracking-wide text-slate-500">Roof pitch</div>
            </div>
          </div>
          <p className="mt-2 text-[11px] text-slate-500">
            Measured from aerial + solar data{p.valid_until ? ` · proposal valid through ${p.valid_until}` : ''}.
          </p>
        </section>

        {isAccepted ? (
          <section className="rounded-2xl border border-emerald-400/30 bg-emerald-500/10 p-8 text-center">
            <div className="text-3xl">🎉</div>
            <h2 className="mt-2 text-xl font-bold text-emerald-200">
              {accepted || `Accepted — ${p.accepted_tier} option`}
            </h2>
            <p className="mt-2 text-sm text-slate-300">
              {p.company_name} will contact you to confirm details and schedule the work.
            </p>
            {p.phone && (
              <a href={`tel:${p.phone}`} className="mt-4 inline-block rounded-lg bg-slate-800 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-700">
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
                  className={`relative flex flex-col rounded-2xl border p-5 ${
                    i === popularIdx
                      ? 'border-blue-400/50 bg-blue-500/10 shadow-[0_0_30px_rgba(59,130,246,0.15)]'
                      : 'border-white/10 bg-slate-900/60'
                  }`}
                >
                  {i === popularIdx && (
                    <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 rounded-full bg-blue-600 px-3 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
                      Most popular
                    </span>
                  )}
                  <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-blue-300/80">{t.name}</div>
                  <div className="mt-1 text-base font-semibold text-white">{t.headline}</div>
                  <div className="mt-3 text-3xl font-bold text-white">{money(t.price)}</div>
                  <p className="mt-2 text-xs leading-relaxed text-slate-400">{t.description}</p>
                  <ul className="mt-3 flex-1 space-y-1.5">
                    {t.features.map(f => (
                      <li key={f} className="flex items-start gap-1.5 text-xs text-slate-300">
                        <span className="mt-0.5 text-emerald-400">✓</span>{f}
                      </li>
                    ))}
                  </ul>
                  <button
                    onClick={() => { setChoosing(t); setError(null) }}
                    className={`mt-4 rounded-lg py-2.5 text-sm font-semibold transition ${
                      i === popularIdx
                        ? 'text-white hover:scale-[1.02]'
                        : 'bg-slate-800 text-white hover:bg-slate-700'
                    }`}
                    style={i === popularIdx ? { background: 'linear-gradient(180deg, #3B82F6 0%, #1E40AF 100%)', boxShadow: '0 6px 20px rgba(59,130,246,0.4)' } : undefined}
                  >Choose {t.name}</button>
                </div>
              ))}
            </div>

            {/* Accept modal */}
            {choosing && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setChoosing(null)}>
                <div
                  className="w-full max-w-md rounded-2xl border border-white/15 bg-slate-900 p-6"
                  onClick={e => e.stopPropagation()}
                >
                  <h3 className="text-lg font-bold text-white">Accept the {choosing.name} option</h3>
                  <div className="mt-1 text-sm text-slate-400">{choosing.headline} — <strong className="text-white">{money(choosing.price)}</strong></div>
                  <div className="mt-4 grid gap-2">
                    <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Your full name"
                      className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2.5 text-sm text-white placeholder:text-slate-500" />
                    <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Email (optional)"
                      className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2.5 text-sm text-white placeholder:text-slate-500" />
                    <textarea value={note} onChange={e => setNote(e.target.value)} placeholder="Anything the crew should know? (optional)"
                      className="h-16 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2.5 text-sm text-white placeholder:text-slate-500" />
                  </div>
                  {error && <p className="mt-2 text-xs text-rose-400">{error}</p>}
                  <div className="mt-4 flex gap-2">
                    <button onClick={accept} disabled={submitting}
                      className="flex-1 rounded-lg bg-emerald-600 py-2.5 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50">
                      {submitting ? 'Accepting…' : `Accept — ${money(choosing.price)}`}
                    </button>
                    <button onClick={() => setChoosing(null)} className="rounded-lg bg-slate-800 px-4 text-sm text-slate-300 hover:bg-slate-700">Back</button>
                  </div>
                  <p className="mt-3 text-[10px] text-slate-500">
                    Accepting signals your intent to move forward — {p.company_name} will confirm final details
                    and paperwork before any work begins.
                  </p>
                </div>
              </div>
            )}
          </>
        )}

        <p className="mt-8 text-center text-[10px] text-slate-600">Proposal generated with Axis Performance.</p>
      </div>
    </main>
  )
}
