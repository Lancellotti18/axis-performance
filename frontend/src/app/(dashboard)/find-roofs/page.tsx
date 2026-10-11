'use client'

/**
 * Find Roofs — exclusive leads.
 *
 * Pick an area, see what is for sale there, buy a lead for $50 and it is yours
 * alone: it vanishes from every other contractor's list the moment it is paid
 * for.
 *
 * What a lead looks like before it is bought is deliberate. The score, the roof
 * age, the reason and the satellite view of the roof are all there — that is
 * Axis's own work and it is what is being sold. The street address, the owner's
 * name and their mailing address are not, and they are not hidden in a
 * collapsed panel either: the server never sends them. A roof you can see but
 * cannot locate is exactly the thing worth $50.
 *
 * Neighborhood heat (Census tract ranking) stays off the page.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import toast from 'react-hot-toast'
import { api, type Lead } from '@/lib/api'
import { getUser } from '@/lib/auth'

// Hidden 2026-10-11: Axis sells roofing leads, so the Census neighborhood
// ranking is off the page. Flip to true to bring the mode toggle back.
const SHOW_NEIGHBORHOOD_HEAT = false

const CENSUS_COUNTIES = [
  { key: 'new_hanover', name: 'New Hanover (Wilmington)' },
  { key: 'brunswick', name: 'Brunswick (Leland, Southport)' },
  { key: 'pender', name: 'Pender (Hampstead, Topsail)' },
  { key: 'onslow', name: 'Onslow (Jacksonville)' },
  { key: 'columbus', name: 'Columbus (Whiteville)' },
  { key: 'bladen', name: 'Bladen (Elizabethtown)' },
  { key: 'duplin', name: 'Duplin (Kenansville)' },
  { key: 'carteret', name: 'Carteret (Morehead City)' },
  { key: 'york_pa', name: 'York / Hanover, PA' },
]

const mapsLink = (lat: number, lng: number) => `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`
const streetViewLink = (lat: number, lng: number) =>
  `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lng}`
const mapAreaLink = (lat: number, lng: number) => `https://www.google.com/maps/@${lat},${lng},15z`

const TIER: Record<string, string> = {
  Hot: 'bg-rose-50 text-rose-800 ring-rose-400/30',
  Warm: 'bg-amber-50 text-amber-800 ring-amber-400/30',
  Cool: 'bg-[#9ca3af] text-[#2d2d2d] ring-slate-400/30',
}

const clean = (e: unknown, fallback: string) =>
  e instanceof Error ? e.message.replace(/\[HTTP \d+\]\s*/, '') : fallback
const isGone = (e: unknown) => e instanceof Error && /\[HTTP 409\]/.test(e.message)

/**
 * The roof view, fetched when the card scrolls into sight.
 *
 * One request per thumbnail goes through the server, so loading sixty at once
 * on a search would be sixty round trips nobody asked for. The observer means
 * a contractor who looks at the top four pays for four.
 */
function RoofView({ county, token, owned, lat, lng }: {
  county: string; token: string; owned: boolean; lat?: number; lng?: number
}) {
  const [img, setImg] = useState<string | null>(null)
  const [state, setState] = useState<'idle' | 'loading' | 'failed'>('idle')
  const [street, setStreet] = useState<'idle' | 'loading' | 'none' | string>('idle')
  const [mode, setMode] = useState<'sat' | 'street'>('sat')
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = box.current
    if (!el || state !== 'idle') return
    const io = new IntersectionObserver(entries => {
      if (!entries.some(e => e.isIntersecting)) return
      io.disconnect()
      setState('loading')
      api.prospecting.leadThumb(county, token)
        .then(r => { setImg(r.image); setState('idle') })
        .catch(() => setState('failed'))
    }, { rootMargin: '200px' })
    io.observe(el)
    return () => io.disconnect()
  }, [county, token, state])

  // Street view is for leads this account owns. On an unbought lead it would
  // put the house, and so the address, back on the screen.
  const toggle = async () => {
    if (!owned || lat === undefined || lng === undefined) return
    if (mode === 'street') { setMode('sat'); return }
    setMode('street')
    if (street === 'idle') {
      setStreet('loading')
      try {
        const r = await api.roofing.v2.getStreetView(lat, lng)
        setStreet(r.available && r.image ? r.image : 'none')
      } catch { setStreet('none') }
    }
  }

  const imgCls = 'h-full w-full rounded-lg bg-[#eeeeed] object-cover ring-1 ring-[#dededc]'
  return (
    <div ref={box} className="relative h-28 w-36 flex-shrink-0">
      {mode === 'street' && typeof street === 'string' && street.startsWith('data:') ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={street} alt="Street view" className={imgCls} />
      ) : mode === 'street' && street === 'loading' ? (
        <div className={`flex items-center justify-center text-[10px] text-[#6b7280] ${imgCls}`}>Loading…</div>
      ) : mode === 'street' && street === 'none' ? (
        <div className={`flex items-center justify-center px-2 text-center text-[10px] text-[#6b7280] ${imgCls}`}>No street view here</div>
      ) : img ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={img} alt="Roof satellite view" className={imgCls} />
      ) : (
        <div className={`flex items-center justify-center px-2 text-center text-[10px] text-[#6b7280] ${imgCls}`}>
          {state === 'failed' ? 'Roof view unavailable' : 'Loading roof…'}
        </div>
      )}
      {owned && (
        <button onClick={toggle} type="button"
          className="absolute bottom-1 left-1 rounded bg-black/60 px-1.5 py-0.5 text-[9px] font-semibold text-white transition-colors hover:bg-black/80">
          {mode === 'street' ? '🛰 Satellite' : '📷 Street'}
        </button>
      )}
    </div>
  )
}

/** The one screen where money changes hands, so it says so plainly. */
function BuyDialog({ lead, price, busy, onConfirm, onCancel }: {
  lead: Lead; price: number; busy: boolean; onConfirm: () => void; onCancel: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog" aria-modal="true" onClick={onCancel}>
      <div className="w-full max-w-md rounded-2xl border border-[#dededc] bg-white p-5 shadow-xl"
        onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-bold text-[#1a1a1a]">Buy this lead for ${price}?</h2>
        <p className="mt-2 text-sm leading-relaxed text-[#4b5563]">
          Your card on file is charged ${price} now. The full address and the owner&apos;s name and
          mailing address are revealed to you, the lead is added to your CRM, and it disappears from
          every other contractor&apos;s Find Roofs for good.
        </p>
        <div className="mt-3 rounded-xl bg-[#f8f8f7] px-3 py-2 text-[12px] text-[#4b5563]">
          <div><span className="text-[#6b7280]">Area:</span> {lead.city || '—'}{lead.zip ? ` ${lead.zip}` : ''}</div>
          {lead.year_built && <div><span className="text-[#6b7280]">Built:</span> {lead.year_built}</div>}
          <div><span className="text-[#6b7280]">Score:</span> {lead.score} ({lead.tier})</div>
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-[#6b7280]">
          This is a public county record — an address and an owner, with no phone or email. Checking
          the Do Not Call registry before you call is on you.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onCancel} disabled={busy}
            className="rounded-xl px-4 py-2 text-sm font-semibold text-[#4b5563] hover:bg-[#f8f8f7] disabled:opacity-50">
            Cancel
          </button>
          <button onClick={onConfirm} disabled={busy}
            className="rounded-xl px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
            style={{ background: '#007fff', boxShadow: '0 4px 14px rgba(59,130,246,0.3)' }}>
            {busy ? 'Charging…' : `Buy for $${price}`}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function FindRoofsPage() {
  const router = useRouter()
  const [mode, setMode] = useState<'homes' | 'heat'>('homes')

  // Area
  const [sources, setSources] = useState<Array<{ key: string; name: string }>>([])
  const [county, setCounty] = useState('')
  const [city, setCity] = useState('')
  const [zip, setZip] = useState('')
  const [ownerOnly, setOwnerOnly] = useState(false)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.prospecting.findRoofs>> | null>(null)
  const [converting, setConverting] = useState<string | null>(null)

  // Buying
  const [pending, setPending] = useState<Lead | null>(null)
  const [buying, setBuying] = useState(false)

  // Heat
  const [heatCounty, setHeatCounty] = useState('new_hanover')
  const [heatLoading, setHeatLoading] = useState(false)
  const [heat, setHeat] = useState<Awaited<ReturnType<typeof api.prospecting.censusHeat>> | null>(null)

  useEffect(() => {
    api.prospecting.sources().then(r => {
      setSources(r.sources)
      if (r.sources[0]) setCounty(r.sources[0].key)
    }).catch(() => {})
  }, [])

  const search = useCallback(async () => {
    if (!county) return
    setLoading(true); setResult(null)
    try {
      setResult(await api.prospecting.findRoofs({
        county, city: city.trim() || undefined, zip: zip.trim() || undefined,
        ownerOccupiedOnly: ownerOnly, limit: 60,
      }))
    } catch (e) {
      toast.error(clean(e, 'Search failed'))
    } finally { setLoading(false) }
  }, [county, city, zip, ownerOnly])

  const rankNeighborhoods = useCallback(async () => {
    setHeatLoading(true); setHeat(null)
    try {
      setHeat(await api.prospecting.censusHeat(heatCounty))
    } catch (e) {
      toast.error(clean(e, 'Failed to load neighborhoods'))
    } finally { setHeatLoading(false) }
  }, [heatCounty])

  const buy = useCallback(async () => {
    if (!pending || !result) return
    setBuying(true)
    try {
      const out = await api.billing.purchaseLead(county, pending.token)
      if (out.requires_action) {
        toast.error(out.message || 'Your bank needs to confirm this payment.')
        return
      }
      // Swap the stripped card for the full one in place, so the address
      // appears where they were already looking.
      const bought = out.lead
      setResult(r => r && {
        ...r,
        for_sale: Math.max(0, r.for_sale - 1),
        owned: r.owned + 1,
        prospects: r.prospects.map(p => (p.token === pending.token && bought ? bought : p)),
      })
      toast.success(out.message || 'This lead is yours.')
      setPending(null)
    } catch (e) {
      if (isGone(e)) {
        // Somebody else got there first. Drop it from the list rather than
        // leave a card that cannot be bought.
        setResult(r => r && {
          ...r,
          for_sale: Math.max(0, r.for_sale - 1),
          prospects: r.prospects.filter(p => p.token !== pending.token),
        })
        setPending(null)
      }
      toast.error(clean(e, 'Could not buy that lead.'))
    } finally { setBuying(false) }
  }, [pending, result, county])

  const measure = useCallback(async (p: Lead) => {
    if (!p.address) return
    setConverting(p.token)
    try {
      const u = await getUser()
      if (!u) { router.push('/login'); return }
      const proj = await api.projects.create({
        name: p.address, address: p.address, city: p.city || undefined,
        state: 'NC', region: 'US-NC', blueprint_type: 'residential',
      }, u.id)
      router.push(`/roof-v2?project=${proj.id}`)
    } catch {
      setConverting(null)
      toast.error('Could not start a project for this home.')
    }
  }, [router])

  const price = result?.lead_price_usd ?? 50

  return (
    <div className="min-h-full">
      <div className="mx-auto max-w-5xl p-8">
        <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-[#1a1a1a]">Find Roofs</h1>
            <p className="mt-1 text-sm text-[#6b7280]">
              Pick an area and see the roofs worth knocking on. Buy a lead and it&apos;s yours
              alone — nobody else is sold it.
            </p>
          </div>
          <a href="/my-leads" className="rounded-xl border border-[#dededc] px-3 py-2 text-xs font-semibold text-[#4b5563] hover:bg-[#f8f8f7]">
            My leads →
          </a>
        </div>

        {SHOW_NEIGHBORHOOD_HEAT && <div className="mb-4 inline-flex rounded-xl border border-[#dededc] bg-[#f8f8f7] p-1 text-sm">
          {([['homes', 'Homes'], ['heat', 'Neighborhood heat']] as const).map(([m, label]) => (
            <button key={m} onClick={() => setMode(m)}
              className={`rounded-lg px-4 py-1.5 font-semibold transition-colors ${mode === m ? 'bg-blue-600 text-white' : 'text-[#6b7280] hover:text-[#1a1a1a]'}`}>
              {label}
            </button>
          ))}
        </div>}

        {mode === 'homes' ? (
          <>
            {/* Area picker */}
            <div className="rounded-2xl border border-[#dededc] bg-[#f8f8f7] p-4">
              <div className="flex flex-wrap items-end gap-3">
                <div className="min-w-[200px] flex-1">
                  <label htmlFor="county" className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[#6b7280]">County</label>
                  <select id="county" value={county} onChange={e => setCounty(e.target.value)}
                    className="w-full rounded-xl border border-[#dededc] bg-[#f8f8f7] px-3 py-2.5 text-sm text-[#1a1a1a] focus:border-blue-400/40 focus:outline-none">
                    {sources.length === 0 && <option value="">Loading…</option>}
                    {sources.map(s => <option key={s.key} value={s.key}>{s.name}</option>)}
                  </select>
                </div>
                <div className="w-[150px]">
                  <label htmlFor="city" className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[#6b7280]">City</label>
                  <input id="city" value={city} onChange={e => setCity(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && search()} placeholder="Any"
                    className="w-full rounded-xl border border-[#dededc] bg-[#f8f8f7] px-3 py-2.5 text-sm text-[#1a1a1a] focus:border-blue-400/40 focus:outline-none" />
                </div>
                <div className="w-[110px]">
                  <label htmlFor="zip" className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[#6b7280]">ZIP</label>
                  <input id="zip" value={zip} onChange={e => setZip(e.target.value)} inputMode="numeric" maxLength={5}
                    onKeyDown={e => e.key === 'Enter' && search()} placeholder="Any"
                    className="w-full rounded-xl border border-[#dededc] bg-[#f8f8f7] px-3 py-2.5 text-sm text-[#1a1a1a] focus:border-blue-400/40 focus:outline-none" />
                </div>
                <label className="flex items-center gap-2 pb-2.5 text-xs text-[#2d2d2d]">
                  <input type="checkbox" checked={ownerOnly} onChange={e => setOwnerOnly(e.target.checked)} className="accent-blue-500" />
                  Owner-occupied only
                </label>
                <button onClick={search} disabled={loading || !county}
                  className="rounded-xl px-5 py-2.5 text-sm font-bold text-white transition-all disabled:opacity-50"
                  style={{ background: '#007fff', boxShadow: '0 4px 14px rgba(59,130,246,0.3)' }}>
                  {loading ? 'Searching…' : 'Find roofs'}
                </button>
              </div>
            </div>

            {result && (
              <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-blue-400/20 bg-blue-500/[0.06] px-4 py-2.5 text-xs leading-relaxed text-[#4b5563]">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="2" strokeLinecap="round" className="mt-0.5 flex-shrink-0"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
                <span>
                  Each lead is ${price} and is sold once. The address and owner stay hidden until you
                  buy — the roof view and the score are there to judge it by.
                  {result.searches_left <= 5 && ` ${result.searches_left} searches left today.`}
                </span>
              </div>
            )}

            {result && (
              <div className="mt-4">
                <div className="mb-2 text-xs text-[#6b7280]">
                  {result.for_sale} for sale in {result.county}
                  {result.owned > 0 && ` · ${result.owned} you own`}
                </div>
                <div className="grid gap-3 lg:grid-cols-2">
                  {result.prospects.map(p => (
                    <div key={p.token}
                      className={`group flex flex-col overflow-hidden rounded-2xl border bg-[#f8f8f7] transition-all duration-200 hover:-translate-y-1 hover:shadow-[0_12px_30px_rgba(59,130,246,0.15)] ${p.owned ? 'border-emerald-300' : 'border-[#dededc] hover:border-blue-400/30'}`}>
                      <div className="flex gap-3 p-3">
                        <RoofView county={county} token={p.token} owned={p.owned} lat={p.lat} lng={p.lng} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start justify-between gap-2">
                            <div className="truncate text-sm font-semibold text-[#1a1a1a]">
                              {p.owned ? p.address : `${p.city || 'This area'}${p.zip ? ` ${p.zip}` : ''}`}
                            </div>
                            <span className={`flex-shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ring-1 ${TIER[p.tier] || TIER.Cool}`}>{p.tier}</span>
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
                            {p.year_built && <span className="rounded bg-blue-50 px-1.5 py-0.5 font-medium text-blue-900">Built {p.year_built}</span>}
                            {p.owned && p.sold_year && <span className="rounded bg-purple-100 px-1.5 py-0.5 font-medium text-purple-900">Sold {p.sold_year}</span>}
                            {p.owner_occupied === true && <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-800">Owner-occupied</span>}
                            {p.owner_occupied === false && <span className="rounded bg-[#eeeeed] px-1.5 py-0.5 text-[#6b7280]">Absentee</span>}
                            <span className="text-[#6b7280]">score {p.score}</span>
                          </div>
                          <p className="mt-1.5 text-[11px] leading-snug text-[#2d2d2d]">{p.why}</p>
                        </div>
                      </div>

                      {p.owned ? (
                        <>
                          <div className="mx-3 rounded-lg border border-[#dededc] bg-white px-3 py-2">
                            <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-[#6b7280]">Homeowner</div>
                            {p.owner ? (
                              <div className="space-y-0.5 text-[11px] text-[#2d2d2d]">
                                <div><span className="text-[#6b7280]">Name:</span> {p.owner}</div>
                                {p.owner_mail && <div><span className="text-[#6b7280]">Mailing:</span> {p.owner_mail}</div>}
                                <div className="text-[#6b7280]">Phone / email: not in public records</div>
                              </div>
                            ) : (
                              <div className="text-[11px] text-[#6b7280]">Owner name isn&apos;t in this county&apos;s records.</div>
                            )}
                          </div>
                          <div className="mt-2 flex flex-wrap items-center gap-2 px-3 pb-3">
                            <button onClick={() => measure(p)} disabled={converting === p.token}
                              className="rounded-lg bg-blue-600 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-blue-500 disabled:opacity-50">
                              {converting === p.token ? 'Starting…' : 'Create project & measure'}
                            </button>
                            {p.lat !== undefined && p.lng !== undefined && (
                              <>
                                <a href={streetViewLink(p.lat, p.lng)} target="_blank" rel="noreferrer"
                                  className="text-[11px] text-[#6b7280] underline decoration-dotted hover:text-[#1a1a1a]">Street view ↗</a>
                                <a href={mapsLink(p.lat, p.lng)} target="_blank" rel="noreferrer"
                                  className="text-[11px] text-[#6b7280] underline decoration-dotted hover:text-[#1a1a1a]">Map ↗</a>
                              </>
                            )}
                            <span className="ml-auto rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-800">Yours</span>
                          </div>
                        </>
                      ) : (
                        <div className="mt-1 flex items-center justify-between gap-2 border-t border-[#dededc] px-3 py-2.5">
                          <span className="text-[11px] text-[#6b7280]">Address &amp; owner revealed on purchase</span>
                          <button onClick={() => setPending(p)}
                            className="rounded-lg px-3 py-1.5 text-[11px] font-bold text-white transition-all"
                            style={{ background: '#007fff', boxShadow: '0 4px 14px rgba(59,130,246,0.3)' }}>
                            Buy for ${price}
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                {result.prospects.length === 0 && (
                  <div className="py-16 text-center text-sm text-[#6b7280]">
                    Nothing left for sale in that area — try another city or ZIP.
                  </div>
                )}
              </div>
            )}

            {!result && !loading && (
              <div className="py-20 text-center">
                <div className="text-sm font-medium text-[#2d2d2d]">Pick an area and search</div>
                <div className="mx-auto mt-1 max-w-md text-xs text-[#6b7280]">
                  You&apos;ll get the roofs most likely due for replacement, each with a satellite view
                  and why it scored the way it did. Buy the ones you want for ${price} and the address,
                  the owner and their mailing address are yours — exclusively.
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="rounded-2xl border border-[#dededc] bg-[#f8f8f7] p-4">
              <div className="flex flex-wrap items-end gap-3">
                <div className="min-w-[240px] flex-1">
                  <label htmlFor="heat-county" className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[#6b7280]">County</label>
                  <select id="heat-county" value={heatCounty} onChange={e => setHeatCounty(e.target.value)}
                    className="w-full rounded-xl border border-[#dededc] bg-[#f8f8f7] px-3 py-2.5 text-sm text-[#1a1a1a] focus:border-blue-400/40 focus:outline-none">
                    {CENSUS_COUNTIES.map(c => <option key={c.key} value={c.key}>{c.name}</option>)}
                  </select>
                </div>
                <button onClick={rankNeighborhoods} disabled={heatLoading}
                  className="rounded-xl px-5 py-2.5 text-sm font-bold text-white transition-all disabled:opacity-50"
                  style={{ background: '#007fff', boxShadow: '0 4px 14px rgba(59,130,246,0.3)' }}>
                  {heatLoading ? 'Ranking…' : 'Rank neighborhoods'}
                </button>
              </div>
            </div>

            {heat && (
              <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-blue-400/20 bg-blue-500/[0.06] px-4 py-2.5 text-xs leading-relaxed text-[#4b5563]">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="2" strokeLinecap="round" className="mt-0.5 flex-shrink-0"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
                <span>{heat.note} <span className="text-[#6b7280]">A &ldquo;neighborhood&rdquo; is a Census tract — the map link shows exactly where it is.</span></span>
              </div>
            )}

            {heat?.available && heat.tracts.length > 0 && (
              <div className="mt-4">
                <div className="mb-2 text-xs text-[#6b7280]">{heat.count} neighborhoods in {heat.county}, ranked by roof opportunity</div>
                <div className="grid gap-2.5">
                  {heat.tracts.map(t => (
                    <div key={t.tract}
                      className="flex items-center gap-3 rounded-xl border border-[#dededc] bg-[#f8f8f7] px-4 py-3 transition-all duration-200 hover:-translate-y-0.5 hover:border-blue-400/30 hover:shadow-[0_8px_22px_rgba(59,130,246,0.12)]">
                      <span className={`flex-shrink-0 rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase ring-1 ${TIER[t.tier] || TIER.Cool}`}>{t.tier}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                          <span className="text-sm font-semibold text-[#1a1a1a]">{t.place || t.tract}</span>
                          {t.place && <span className="text-[11px] text-[#6b7280]">{t.tract}</span>}
                          <span className="text-[11px] text-[#6b7280]">· {t.units.toLocaleString()} homes</span>
                          {t.lat != null && t.lng != null && (
                            <a href={mapAreaLink(t.lat, t.lng)} target="_blank" rel="noreferrer"
                              className="text-[11px] text-blue-600 underline decoration-dotted hover:text-blue-700">📍 See the area ↗</a>
                          )}
                        </div>
                        <div className="mt-0.5 text-[11px] leading-snug text-[#6b7280]">{t.why}</div>
                      </div>
                      <div className="flex flex-shrink-0 gap-3 text-center">
                        <div><div className="text-sm font-bold text-blue-700">{t.pct_pre_1980}%</div><div className="text-[9px] uppercase tracking-wide text-[#9ca3af]">pre-1980</div></div>
                        <div><div className="text-sm font-bold text-emerald-700">{t.pct_owner_occupied}%</div><div className="text-[9px] uppercase tracking-wide text-[#9ca3af]">owner-occ</div></div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {!heat && !heatLoading && (
              <div className="py-20 text-center">
                <div className="text-sm font-medium text-[#2d2d2d]">Rank a county&apos;s neighborhoods</div>
                <div className="mx-auto mt-1 max-w-md text-xs text-[#6b7280]">Free Census data scores every neighborhood by how many homes are older and owner-occupied — so you know exactly where to knock, even where per-home data isn&apos;t public.</div>
              </div>
            )}
          </>
        )}
      </div>

      {pending && (
        <BuyDialog lead={pending} price={price} busy={buying}
          onConfirm={buy} onCancel={() => !buying && setPending(null)} />
      )}
    </div>
  )
}
