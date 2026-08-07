'use client'

/**
 * Find Roofs — prospecting tool (free tier). Two modes:
 *  • Homes — real addresses from public parcel data, each with a satellite roof
 *    view, a bulleted "why this is Hot/Warm/Cool", the homeowner's name + mailing
 *    address (email/phone aren't in public records), and one-click into a project.
 *  • Neighborhood heat — free Census data ranks a county's neighborhoods by roof
 *    opportunity, each with a real map location so you know where to knock.
 */
import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import toast from 'react-hot-toast'
import { api } from '@/lib/api'
import { getUser } from '@/lib/auth'

type Prospect = {
  pin: string; address: string; city: string; owner: string | null; owner_mail: string | null
  owner_occupied: boolean | null; year_built: number | null; sold_year: number | null
  tax_value: number | null; lat: number; lng: number
  score: number; tier: string; reasons: string[]; confidence: string; why: string
}

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

// Free, no-key satellite thumbnail from Esri World Imagery (tight crop on the roof).
function roofThumb(lat: number, lng: number, d = 0.0006) {
  const bbox = `${lng - d},${lat - d},${lng + d},${lat + d}`
  return `https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?bbox=${bbox}&bboxSR=4326&imageSR=4326&size=240,180&format=jpg&f=image`
}
const mapsLink = (lat: number, lng: number) => `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`
// Area view (no dropped pin) — a tract centroid pin can land in a field; this
// shows the surrounding neighborhood so the contractor recognizes the area.
const mapAreaLink = (lat: number, lng: number) => `https://www.google.com/maps/@${lat},${lng},15z`

const TIER: Record<string, string> = {
  Hot: 'bg-rose-500/15 text-rose-300 ring-rose-400/30',
  Warm: 'bg-amber-500/15 text-amber-300 ring-amber-400/30',
  Cool: 'bg-slate-500/15 text-slate-300 ring-slate-400/30',
}

export default function FindRoofsPage() {
  const router = useRouter()
  const [mode, setMode] = useState<'homes' | 'heat'>('homes')

  // Homes mode
  const [sources, setSources] = useState<Array<{ key: string; name: string }>>([])
  const [county, setCounty] = useState('')
  const [ownerOnly, setOwnerOnly] = useState(false)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.prospecting.findRoofs>> | null>(null)
  const [converting, setConverting] = useState<string | null>(null)

  // Heat mode
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
      setResult(await api.prospecting.findRoofs({ county, ownerOccupiedOnly: ownerOnly, limit: 60 }))
    } catch (e) {
      toast.error(e instanceof Error ? e.message.replace(/\[HTTP \d+\]\s*/, '') : 'Search failed')
    } finally { setLoading(false) }
  }, [county, ownerOnly])

  const rankNeighborhoods = useCallback(async () => {
    setHeatLoading(true); setHeat(null)
    try {
      setHeat(await api.prospecting.censusHeat(heatCounty))
    } catch (e) {
      toast.error(e instanceof Error ? e.message.replace(/\[HTTP \d+\]\s*/, '') : 'Failed to load neighborhoods')
    } finally { setHeatLoading(false) }
  }, [heatCounty])

  const measure = useCallback(async (p: Prospect) => {
    setConverting(p.pin)
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

  return (
    <div className="min-h-full" style={{ background: '#040810' }}>
      <div className="mx-auto max-w-5xl p-8">
        <div className="mb-5">
          <h1 className="text-2xl font-bold text-white">Find Roofs</h1>
          <p className="mt-1 text-sm text-slate-400">Find where the work is — rank neighborhoods, then pull real homes with a satellite view, the reasons they&apos;re a lead, and the homeowner&apos;s details.</p>
        </div>

        {/* Mode toggle */}
        <div className="mb-4 inline-flex rounded-xl border border-white/10 bg-white/[0.04] p-1 text-sm">
          {([['homes', 'Homes'], ['heat', 'Neighborhood heat']] as const).map(([m, label]) => (
            <button key={m} onClick={() => setMode(m)}
              className={`rounded-lg px-4 py-1.5 font-semibold transition-colors ${mode === m ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}>
              {label}
            </button>
          ))}
        </div>

        {mode === 'homes' ? (
          <>
            {/* Homes controls */}
            <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
              <div className="flex flex-wrap items-end gap-3">
                <div className="min-w-[240px] flex-1">
                  <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-slate-500">County</label>
                  <select value={county} onChange={e => setCounty(e.target.value)}
                    className="w-full rounded-xl border border-white/12 bg-white/[0.06] px-3 py-2.5 text-sm text-slate-200 focus:border-blue-400/40 focus:outline-none">
                    {sources.length === 0 && <option value="">Loading…</option>}
                    {sources.map(s => <option key={s.key} value={s.key}>{s.name}</option>)}
                  </select>
                </div>
                <label className="flex items-center gap-2 pb-2.5 text-xs text-slate-300">
                  <input type="checkbox" checked={ownerOnly} onChange={e => setOwnerOnly(e.target.checked)} className="accent-blue-500" />
                  Owner-occupied only
                </label>
                <button onClick={search} disabled={loading || !county}
                  className="rounded-xl px-5 py-2.5 text-sm font-bold text-white transition-all disabled:opacity-50"
                  style={{ background: 'linear-gradient(135deg, #3b82f6, #1d4ed8)', boxShadow: '0 4px 14px rgba(59,130,246,0.3)' }}>
                  {loading ? 'Searching…' : 'Find roofs'}
                </button>
              </div>
            </div>

            {result && (
              <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-blue-400/20 bg-blue-500/[0.06] px-4 py-2.5 text-xs leading-relaxed text-blue-100/80">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="2" strokeLinecap="round" className="mt-0.5 flex-shrink-0"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
                <span>{result.note}</span>
              </div>
            )}

            {result && (
              <div className="mt-4">
                <div className="mb-2 text-xs text-slate-500">{result.count} homes in {result.county}</div>
                <div className="grid gap-3 lg:grid-cols-2">
                  {result.prospects.map(p => (
                    <div key={p.pin}
                      className="group flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/[0.04] transition-all duration-200 hover:-translate-y-1 hover:border-blue-400/30 hover:shadow-[0_12px_30px_rgba(59,130,246,0.15)]">
                      <div className="flex gap-3 p-3">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={roofThumb(p.lat, p.lng)} alt="Roof" loading="lazy"
                          className="h-28 w-36 flex-shrink-0 rounded-lg bg-slate-800 object-cover ring-1 ring-white/10" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start justify-between gap-2">
                            <div className="truncate text-sm font-semibold text-white">{p.address}</div>
                            <span className={`flex-shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ring-1 ${TIER[p.tier] || TIER.Cool}`}>{p.tier}</span>
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
                            {p.year_built && <span className="rounded bg-blue-500/15 px-1.5 py-0.5 font-medium text-blue-200">Built {p.year_built}</span>}
                            {p.sold_year && <span className="rounded bg-purple-500/15 px-1.5 py-0.5 font-medium text-purple-200">Sold {p.sold_year}</span>}
                            {p.owner_occupied === true && <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-emerald-300">Owner-occupied</span>}
                            {p.owner_occupied === false && <span className="rounded bg-slate-500/15 px-1.5 py-0.5 text-slate-400">Absentee</span>}
                            <span className={p.confidence === 'low' ? 'text-slate-500' : 'text-slate-400'}>conf: {p.confidence}</span>
                          </div>
                          {/* Why this tier — bullet points */}
                          {p.reasons.length > 0 && (
                            <ul className="mt-1.5 space-y-0.5">
                              {p.reasons.map((r, i) => (
                                <li key={i} className="flex gap-1.5 text-[11px] leading-snug text-slate-300">
                                  <span className="mt-[3px] h-1 w-1 flex-shrink-0 rounded-full bg-blue-400/70" />
                                  <span>{r}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </div>

                      {/* Homeowner contact */}
                      <div className="mx-3 rounded-lg border border-white/8 bg-black/20 px-3 py-2">
                        <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">Homeowner</div>
                        {p.owner ? (
                          <div className="space-y-0.5 text-[11px] text-slate-300">
                            <div><span className="text-slate-500">Name:</span> {p.owner}</div>
                            {p.owner_mail && <div><span className="text-slate-500">Mailing:</span> {p.owner_mail}</div>}
                            <div className="text-slate-500">Phone / email: <span className="text-slate-400">not in public records</span></div>
                          </div>
                        ) : (
                          <div className="text-[11px] text-slate-500">Owner name isn&apos;t in this county&apos;s free records.</div>
                        )}
                      </div>

                      <div className="mt-2 flex items-center gap-2 px-3 pb-3">
                        <button onClick={() => measure(p)} disabled={converting === p.pin}
                          className="rounded-lg bg-blue-600 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-blue-500 disabled:opacity-50">
                          {converting === p.pin ? 'Starting…' : 'Create project & measure'}
                        </button>
                        <a href={mapsLink(p.lat, p.lng)} target="_blank" rel="noreferrer"
                          className="text-[11px] text-slate-400 underline decoration-dotted hover:text-slate-200">Street view ↗</a>
                      </div>
                    </div>
                  ))}
                </div>
                {result.count === 0 && <div className="py-16 text-center text-sm text-slate-500">No homes found — try a different county or clear the filter.</div>}
              </div>
            )}

            {!result && !loading && (
              <div className="py-20 text-center">
                <div className="text-sm font-medium text-slate-300">Pick a county and search</div>
                <div className="mx-auto mt-1 max-w-md text-xs text-slate-500">You&apos;ll get real homes with a satellite view of each roof, why each one is a lead, and the homeowner&apos;s details. Scan for worn roofs, then create a project to measure and quote.</div>
              </div>
            )}
          </>
        ) : (
          <>
            {/* Heat controls */}
            <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
              <div className="flex flex-wrap items-end gap-3">
                <div className="min-w-[240px] flex-1">
                  <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-slate-500">County</label>
                  <select value={heatCounty} onChange={e => setHeatCounty(e.target.value)}
                    className="w-full rounded-xl border border-white/12 bg-white/[0.06] px-3 py-2.5 text-sm text-slate-200 focus:border-blue-400/40 focus:outline-none">
                    {CENSUS_COUNTIES.map(c => <option key={c.key} value={c.key}>{c.name}</option>)}
                  </select>
                </div>
                <button onClick={rankNeighborhoods} disabled={heatLoading}
                  className="rounded-xl px-5 py-2.5 text-sm font-bold text-white transition-all disabled:opacity-50"
                  style={{ background: 'linear-gradient(135deg, #3b82f6, #1d4ed8)', boxShadow: '0 4px 14px rgba(59,130,246,0.3)' }}>
                  {heatLoading ? 'Ranking…' : 'Rank neighborhoods'}
                </button>
              </div>
            </div>

            {heat && (
              <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-blue-400/20 bg-blue-500/[0.06] px-4 py-2.5 text-xs leading-relaxed text-blue-100/80">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="2" strokeLinecap="round" className="mt-0.5 flex-shrink-0"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
                <span>{heat.note} <span className="text-blue-100/60">A &ldquo;neighborhood&rdquo; is a Census tract — the map link shows exactly where it is.</span></span>
              </div>
            )}

            {heat?.available && heat.tracts.length > 0 && (
              <div className="mt-4">
                <div className="mb-2 text-xs text-slate-500">{heat.count} neighborhoods in {heat.county}, ranked by roof opportunity</div>
                <div className="grid gap-2.5">
                  {heat.tracts.map(t => (
                    <div key={t.tract}
                      className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 transition-all duration-200 hover:-translate-y-0.5 hover:border-blue-400/30 hover:shadow-[0_8px_22px_rgba(59,130,246,0.12)]">
                      <span className={`flex-shrink-0 rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase ring-1 ${TIER[t.tier] || TIER.Cool}`}>{t.tier}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                          <span className="text-sm font-semibold text-white">{t.place || t.tract}</span>
                          {t.place && <span className="text-[11px] text-slate-500">{t.tract}</span>}
                          <span className="text-[11px] text-slate-500">· {t.units.toLocaleString()} homes</span>
                          {t.lat != null && t.lng != null && (
                            <a href={mapAreaLink(t.lat, t.lng)} target="_blank" rel="noreferrer"
                              className="text-[11px] text-blue-300 underline decoration-dotted hover:text-blue-200">📍 See the area ↗</a>
                          )}
                        </div>
                        <div className="mt-0.5 text-[11px] leading-snug text-slate-400">{t.why}</div>
                      </div>
                      <div className="flex flex-shrink-0 gap-3 text-center">
                        <div><div className="text-sm font-bold text-blue-300">{t.pct_pre_1980}%</div><div className="text-[9px] uppercase tracking-wide text-slate-600">pre-1980</div></div>
                        <div><div className="text-sm font-bold text-emerald-300">{t.pct_owner_occupied}%</div><div className="text-[9px] uppercase tracking-wide text-slate-600">owner-occ</div></div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {!heat && !heatLoading && (
              <div className="py-20 text-center">
                <div className="text-sm font-medium text-slate-300">Rank a county&apos;s neighborhoods</div>
                <div className="mx-auto mt-1 max-w-md text-xs text-slate-500">Free Census data scores every neighborhood by how many homes are older and owner-occupied — so you know exactly where to knock, even where per-home data isn&apos;t public.</div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
