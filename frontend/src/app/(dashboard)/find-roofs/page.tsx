'use client'

/**
 * Find Roofs — prospecting canvassing tool (free tier).
 * Pulls real residential homes in an area from public parcel data, shows each
 * roof from satellite for the contractor to triage condition by eye, and turns
 * a promising one into a measured project in one click. Honest about limits:
 * free data has address + owner + location; roof age/condition need a paid
 * upgrade, so the score stays modest and the thumbnail does the heavy lifting.
 */
import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import toast from 'react-hot-toast'
import { api } from '@/lib/api'
import { getUser } from '@/lib/auth'

type Prospect = {
  pin: string; address: string; city: string; owner: string
  owner_occupied: boolean | null; year_built: number | null; lat: number; lng: number
  score: number; tier: string; reasons: string[]; confidence: string; why: string
}

// Free, no-key satellite thumbnail from Esri World Imagery (tight crop on the roof).
function roofThumb(lat: number, lng: number, d = 0.0006) {
  const bbox = `${lng - d},${lat - d},${lng + d},${lat + d}`
  return `https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?bbox=${bbox}&bboxSR=4326&imageSR=4326&size=220,160&format=jpg&f=image`
}

const TIER: Record<string, string> = {
  Hot: 'bg-rose-500/15 text-rose-300 ring-rose-400/30',
  Warm: 'bg-amber-500/15 text-amber-300 ring-amber-400/30',
  Cool: 'bg-slate-500/15 text-slate-300 ring-slate-400/30',
}

export default function FindRoofsPage() {
  const router = useRouter()
  const [sources, setSources] = useState<Array<{ key: string; name: string }>>([])
  const [county, setCounty] = useState('')
  const [city, setCity] = useState('')
  const [ownerOnly, setOwnerOnly] = useState(false)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.prospecting.findRoofs>> | null>(null)
  const [converting, setConverting] = useState<string | null>(null)

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
      setResult(await api.prospecting.findRoofs({ county, city: city.trim() || undefined, ownerOccupiedOnly: ownerOnly, limit: 60 }))
    } catch (e) {
      toast.error(e instanceof Error ? e.message.replace(/\[HTTP \d+\]\s*/, '') : 'Search failed')
    } finally { setLoading(false) }
  }, [county, city, ownerOnly])

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
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white">Find Roofs</h1>
          <p className="mt-1 text-sm text-slate-400">Pull real homes in an area, eyeball each roof from satellite, and turn a good one into a measured quote — instead of driving around blind.</p>
        </div>

        {/* Controls */}
        <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[180px]">
              <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-slate-500">County</label>
              <select value={county} onChange={e => setCounty(e.target.value)}
                className="w-full rounded-xl border border-white/12 bg-white/[0.06] px-3 py-2.5 text-sm text-slate-200 focus:border-blue-400/40 focus:outline-none">
                {sources.length === 0 && <option value="">Loading…</option>}
                {sources.map(s => <option key={s.key} value={s.key}>{s.name}</option>)}
              </select>
            </div>
            <div className="min-w-[180px] flex-1">
              <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-slate-500">City / town <span className="font-normal normal-case text-slate-600">(optional)</span></label>
              <input value={city} onChange={e => setCity(e.target.value)} onKeyDown={e => e.key === 'Enter' && search()}
                placeholder="e.g. Leland, Southport, Shallotte"
                className="w-full rounded-xl border border-white/12 bg-white/[0.06] px-3 py-2.5 text-sm text-slate-200 placeholder-slate-500 focus:border-blue-400/40 focus:outline-none" />
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

        {/* Honest note */}
        {result && (
          <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-blue-400/20 bg-blue-500/[0.06] px-4 py-2.5 text-xs leading-relaxed text-blue-100/80">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="2" strokeLinecap="round" className="mt-0.5 flex-shrink-0"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
            <span>{result.note}</span>
          </div>
        )}

        {/* Results */}
        {result && (
          <div className="mt-4">
            <div className="mb-2 text-xs text-slate-500">{result.count} homes in {result.county}{city ? ` · ${city}` : ''}</div>
            <div className="grid gap-3 sm:grid-cols-2">
              {result.prospects.map(p => (
                <div key={p.pin} className="flex gap-3 rounded-2xl border border-white/10 bg-white/[0.04] p-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={roofThumb(p.lat, p.lng)} alt="Roof" loading="lazy"
                    className="h-24 w-32 flex-shrink-0 rounded-lg bg-slate-800 object-cover ring-1 ring-white/10" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <div className="truncate text-sm font-semibold text-white">{p.address}</div>
                      <span className={`flex-shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ring-1 ${TIER[p.tier] || TIER.Cool}`}>{p.tier}</span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px]">
                      {p.year_built && <span className="rounded bg-blue-500/15 px-1.5 py-0.5 font-medium text-blue-200">Built {p.year_built}</span>}
                      {p.owner_occupied === true && <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-emerald-300">Owner-occupied</span>}
                      {p.owner_occupied === false && <span className="rounded bg-slate-500/15 px-1.5 py-0.5 text-slate-400">Absentee</span>}
                      <span className={p.confidence === 'low' ? 'text-slate-500' : 'text-slate-400'}>conf: {p.confidence}</span>
                    </div>
                    {p.why && <div className="mt-1 text-[11px] leading-snug text-slate-400">{p.why}</div>}
                    <div className="mt-2 flex items-center gap-2">
                      <button onClick={() => measure(p)} disabled={converting === p.pin}
                        className="rounded-lg bg-blue-600 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-blue-500 disabled:opacity-50">
                        {converting === p.pin ? 'Starting…' : 'Create project & measure'}
                      </button>
                      <a href={`https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`} target="_blank" rel="noreferrer"
                        className="text-[11px] text-slate-400 underline decoration-dotted hover:text-slate-200">Street view ↗</a>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            {result.count === 0 && <div className="py-16 text-center text-sm text-slate-500">No homes found — try a different city or clear the filters.</div>}
          </div>
        )}

        {!result && !loading && (
          <div className="py-20 text-center">
            <div className="text-sm font-medium text-slate-300">Pick a county and search</div>
            <div className="mx-auto mt-1 max-w-md text-xs text-slate-500">You&apos;ll get real residential homes with a satellite view of each roof. Scan for worn, streaked, or tarped roofs, then create a project to measure and quote.</div>
          </div>
        )}
      </div>
    </div>
  )
}
