'use client'

/**
 * My leads — the exclusive leads this account has paid for.
 *
 * Served from the snapshot taken at the moment of sale, not from a fresh county
 * query. Counties rewrite their data, and somebody who paid $50 has to be able
 * to see exactly what they bought a year later.
 */
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import toast from 'react-hot-toast'
import { api, type LeadProblemReason, type LeadProblemReport, type PurchasedLead } from '@/lib/api'
import { getUser } from '@/lib/auth'

const mapsLink = (lat: number, lng: number) => `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`
const streetViewLink = (lat: number, lng: number) =>
  `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lng}`

// Mirrors leads.CLAIM_WINDOW_DAYS on the server. The button disappears once the
// window has closed rather than offering a claim that would be refused.
const CLAIM_WINDOW_DAYS = 7
const daysOld = (iso?: string) => {
  if (!iso) return 0
  const t = new Date(iso).getTime()
  return isNaN(t) ? 0 : (Date.now() - t) / 86_400_000
}

const when = (iso?: string) => {
  if (!iso) return ''
  const d = new Date(iso)
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

const REASONS: Array<{ key: LeadProblemReason; label: string; hint: string }> = [
  { key: 'not_a_home', label: "It isn't a home",
    hint: 'Vacant land, a business, a demolished structure.' },
  { key: 'sold_before_purchase', label: 'It had already sold',
    hint: 'The county shows it changed hands before you bought the lead.' },
  { key: 'record_wrong', label: 'The record is wrong',
    hint: 'The address or the owner on file does not match the county.' },
]

/**
 * Reporting a dud.
 *
 * Only reasons the county record can settle are offered, and the dialog says
 * so plainly — being told up front that "they weren't interested" is not a
 * defect is kinder than filing a claim that gets refused.
 */
function ProblemDialog({ lead, used, perMonth, onClose, onFiled }: {
  lead: PurchasedLead; used: number; perMonth: number
  onClose: () => void; onFiled: (r: { status: string; message: string; credits?: number }) => void
}) {
  const [reason, setReason] = useState<LeadProblemReason | ''>('')
  const [detail, setDetail] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (!reason) return
    setBusy(true)
    try {
      const out = await api.billing.reportLeadProblem(lead.purchase_id, reason, detail.trim() || undefined)
      onFiled(out)
    } catch (e) {
      toast.error(e instanceof Error ? e.message.replace(/\[HTTP \d+\]\s*/, '') : 'Could not file that report.')
    } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog" aria-modal="true" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-[#dededc] bg-white p-5 shadow-xl"
        onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-bold text-[#1a1a1a]">Report a problem</h2>
        <p className="mt-1 truncate text-xs text-[#6b7280]">{lead.address}</p>

        <div className="mt-3 space-y-1.5">
          {REASONS.map(r => (
            <label key={r.key}
              className={`flex cursor-pointer gap-2.5 rounded-xl border px-3 py-2.5 transition-colors ${reason === r.key ? 'border-blue-400 bg-blue-50' : 'border-[#dededc] hover:bg-[#f8f8f7]'}`}>
              <input type="radio" name="reason" className="mt-0.5 accent-blue-500"
                checked={reason === r.key} onChange={() => setReason(r.key)} />
              <span>
                <span className="block text-[13px] font-semibold text-[#1a1a1a]">{r.label}</span>
                <span className="block text-[11px] leading-snug text-[#6b7280]">{r.hint}</span>
              </span>
            </label>
          ))}
        </div>

        <label htmlFor="detail" className="mt-3 block text-[11px] font-semibold uppercase tracking-wider text-[#6b7280]">
          Anything else (optional)
        </label>
        <textarea id="detail" value={detail} onChange={e => setDetail(e.target.value)} rows={2} maxLength={2000}
          className="mt-1 w-full rounded-xl border border-[#dededc] bg-[#f8f8f7] px-3 py-2 text-sm text-[#1a1a1a] focus:border-blue-400/40 focus:outline-none" />

        <p className="mt-3 text-[11px] leading-relaxed text-[#6b7280]">
          I check this against the county record. If it backs you up you get a replacement lead
          straight away; if it cannot settle it, I look myself. No answer or not interested
          is not something I can credit. {perMonth - used} of {perMonth} reports left this month.
        </p>

        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} disabled={busy}
            className="rounded-xl px-4 py-2 text-sm font-semibold text-[#4b5563] hover:bg-[#f8f8f7] disabled:opacity-50">
            Cancel
          </button>
          <button onClick={submit} disabled={busy || !reason}
            className="rounded-xl px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
            style={{ background: '#007fff', boxShadow: '0 4px 14px rgba(59,130,246,0.3)' }}>
            {busy ? 'Filing…' : 'Report it'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function MyLeadsPage() {
  const router = useRouter()
  const [leads, setLeads] = useState<PurchasedLead[] | null>(null)
  const [converting, setConverting] = useState<string | null>(null)
  const [reporting, setReporting] = useState<PurchasedLead | null>(null)
  const [claims, setClaims] = useState<LeadProblemReport[]>([])
  const [credits, setCredits] = useState(0)
  const [used, setUsed] = useState(0)
  const [perMonth, setPerMonth] = useState(3)

  useEffect(() => {
    api.billing.myLeads()
      .then(r => setLeads(r.leads))
      .catch(e => {
        setLeads([])
        toast.error(e instanceof Error ? e.message.replace(/\[HTTP \d+\]\s*/, '') : 'Could not load your leads.')
      })
    // Claims are a side panel on this page, so a failure here must not stop
    // the leads themselves rendering.
    api.billing.leadProblems().then(r => {
      setClaims(r.reports)
      setCredits(r.credits)
      setUsed(r.claims_used_this_month)
      setPerMonth(r.claims_per_month)
    }).catch(() => {})
  }, [])

  const claimFor = (purchaseId: string) => claims.find(c => c.purchase_id === purchaseId)

  const measure = async (lead: PurchasedLead) => {
    if (!lead.address) return
    setConverting(lead.purchase_id)
    try {
      const u = await getUser()
      if (!u) { router.push('/login'); return }
      const proj = await api.projects.create({
        name: lead.address, address: lead.address, city: lead.city || undefined,
        state: 'NC', region: 'US-NC', blueprint_type: 'residential',
      }, u.id)
      router.push(`/roof-v2?project=${proj.id}`)
    } catch {
      setConverting(null)
      toast.error('Could not start a project for this home.')
    }
  }

  const spent = (leads || []).reduce((n, l) => n + (l.price_usd || 0), 0)

  return (
    <div className="min-h-full">
      <div className="mx-auto max-w-5xl p-8">
        <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-[#1a1a1a]">My leads</h1>
            <p className="mt-1 text-sm text-[#6b7280]">
              Leads you bought. Each one is yours alone — nobody else was sold it.
            </p>
          </div>
          <a href="/find-roofs" className="rounded-xl border border-[#dededc] px-3 py-2 text-xs font-semibold text-[#4b5563] hover:bg-[#f8f8f7]">
            ← Find more roofs
          </a>
        </div>

        {leads === null ? (
          <div className="py-20 text-center text-sm text-[#6b7280]">Loading your leads…</div>
        ) : leads.length === 0 ? (
          <div className="py-20 text-center">
            <div className="text-sm font-medium text-[#2d2d2d]">You haven&apos;t bought any leads yet</div>
            <div className="mx-auto mt-1 max-w-md text-xs text-[#6b7280]">
              Find Roofs scores the homes most likely due for a replacement. Buy one and the address,
              the owner and their mailing address are yours exclusively.
            </div>
            <a href="/find-roofs"
              className="mt-4 inline-block rounded-xl px-4 py-2 text-sm font-bold text-white"
              style={{ background: '#007fff', boxShadow: '0 4px 14px rgba(59,130,246,0.3)' }}>
              Find roofs
            </a>
          </div>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs text-[#6b7280]">
                {leads.length} lead{leads.length === 1 ? '' : 's'} · ${spent} spent
              </div>
              {credits > 0 && (
                <div className="rounded-full bg-emerald-50 px-3 py-1 text-[11px] font-semibold text-emerald-800">
                  {credits} replacement lead{credits === 1 ? '' : 's'} to spend — applied automatically on your next purchase
                </div>
              )}
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              {leads.map(l => (
                <div key={l.purchase_id}
                  className="flex flex-col rounded-2xl border border-[#dededc] bg-[#f8f8f7] p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-[#1a1a1a]">{l.address || 'Lead'}</div>
                      <div className="mt-0.5 text-[11px] text-[#6b7280]">
                        {l.city}{l.zip ? ` ${l.zip}` : ''} · bought {when(l.bought_at)} · ${l.price_usd}
                      </div>
                    </div>
                    <span className="flex-shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-800">Yours</span>
                  </div>

                  <div className="mt-2.5 rounded-lg border border-[#dededc] bg-white px-3 py-2">
                    <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-[#6b7280]">Homeowner</div>
                    {l.owner ? (
                      <div className="space-y-0.5 text-[11px] text-[#2d2d2d]">
                        <div><span className="text-[#6b7280]">Name:</span> {l.owner}</div>
                        {l.owner_mail && <div><span className="text-[#6b7280]">Mailing:</span> {l.owner_mail}</div>}
                        <div className="text-[#6b7280]">Phone / email: not in public records</div>
                      </div>
                    ) : (
                      <div className="text-[11px] text-[#6b7280]">Owner name isn&apos;t in this county&apos;s records.</div>
                    )}
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                    {l.year_built && <span className="rounded bg-blue-50 px-1.5 py-0.5 font-medium text-blue-900">Built {l.year_built}</span>}
                    {l.owner_occupied === true && <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-800">Owner-occupied</span>}
                    {l.score != null && <span className="text-[#6b7280]">score {l.score}</span>}
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button onClick={() => measure(l)} disabled={converting === l.purchase_id || !l.address}
                      className="rounded-lg bg-blue-600 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-blue-500 disabled:opacity-50">
                      {converting === l.purchase_id ? 'Starting…' : 'Create project & measure'}
                    </button>
                    {l.lat !== undefined && l.lng !== undefined && (
                      <>
                        <a href={streetViewLink(l.lat, l.lng)} target="_blank" rel="noreferrer"
                          className="text-[11px] text-[#6b7280] underline decoration-dotted hover:text-[#1a1a1a]">Street view ↗</a>
                        <a href={mapsLink(l.lat, l.lng)} target="_blank" rel="noreferrer"
                          className="text-[11px] text-[#6b7280] underline decoration-dotted hover:text-[#1a1a1a]">Map ↗</a>
                      </>
                    )}
                    {(() => {
                      const claim = claimFor(l.purchase_id)
                      if (claim) {
                        const label = claim.status === 'approved'
                          ? (claim.resolution === 'refund' ? 'Refund agreed' : 'Replacement credited')
                          : claim.status === 'rejected' ? 'Reviewed — not a dud' : 'Problem reported'
                        const tone = claim.status === 'approved' ? 'text-emerald-700'
                          : claim.status === 'rejected' ? 'text-[#6b7280]' : 'text-amber-700'
                        return <span className={`ml-auto text-[11px] font-semibold ${tone}`}
                          title={claim.review_note || undefined}>{label}</span>
                      }
                      if (daysOld(l.bought_at) > CLAIM_WINDOW_DAYS) return null
                      return (
                        <button onClick={() => setReporting(l)}
                          className="ml-auto text-[11px] text-[#6b7280] underline decoration-dotted hover:text-[#1a1a1a]">
                          Report a problem
                        </button>
                      )
                    })()}
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-5 text-[11px] leading-relaxed text-[#6b7280]">
              These are public county records — an address and an owner, with no phone or email.
              Checking the Do Not Call registry before you call is on you.
            </p>
          </>
        )}
      </div>
      {reporting && (
        <ProblemDialog lead={reporting} used={used} perMonth={perMonth}
          onClose={() => setReporting(null)}
          onFiled={out => {
            setReporting(null)
            setUsed(n => n + 1)
            if (typeof out.credits === 'number') setCredits(out.credits)
            // Reload the claims so the card shows its new state without a refresh.
            api.billing.leadProblems().then(r => setClaims(r.reports)).catch(() => {})
            toast.success(out.message)
          }} />
      )}
    </div>
  )
}
