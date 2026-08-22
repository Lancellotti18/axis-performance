'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { getUser } from '@/lib/auth'
import { api } from '@/lib/api'

// New-project flow (#2): start from the property address (auto-fills city/county/
// state via the Census geocoder) + optional customer, then straight into the
// satellite/roof workflow. No blueprint upload.
type Match = {
  matched_address: string; street: string; city: string; state: string
  zip: string; lat: number; lng: number; county: string; county_fips: string
}

export default function NewProjectPage() {
  const router = useRouter()
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [matches, setMatches] = useState<Match[]>([])
  const [selected, setSelected] = useState<Match | null>(null)
  const [searching, setSearching] = useState(false)
  const [custName, setCustName] = useState('')
  const [custPhone, setCustPhone] = useState('')
  const [custEmail, setCustEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  // Debounced address search. Skips once a match is locked in.
  useEffect(() => {
    if (selected || address.trim().length < 4) { setMatches([]); return }
    const t = setTimeout(async () => {
      setSearching(true)
      try {
        const r = await api.roofing.v2.locationSearch(address.trim(), false)
        setMatches((r.matches || []).slice(0, 6))
      } catch { setMatches([]) } finally { setSearching(false) }
    }, 300)
    return () => clearTimeout(t)
  }, [address, selected])

  async function pick(m: Match) {
    setSelected(m); setAddress(m.matched_address); setMatches([])
    // Enrich with county/FIPS (with_geographies is slower, so only on selection).
    try {
      const r = await api.roofing.v2.locationSearch(m.matched_address, true)
      if (r.matches?.[0]) setSelected(r.matches[0] as Match)
    } catch { /* county stays blank — non-fatal */ }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) { setError('Give the project a name.'); return }
    if (!selected) { setError('Search and select the property address.'); return }
    setSubmitting(true); setError('')
    try {
      const user = await getUser()
      if (!user) { router.push('/login'); return }
      const s = selected
      const project = await api.projects.create({
        name: name.trim(),
        region: s.state ? `US-${s.state}` : 'US-TX',
        blueprint_type: 'residential',
        address: s.street || s.matched_address,
        city: s.city || undefined,
        state: s.state || undefined,
        zip_code: s.zip || undefined,
        county: s.county || undefined,
        lat: s.lat, lng: s.lng,
        customer_name: custName.trim() || undefined,
        customer_phone: custPhone.trim() || undefined,
        customer_email: custEmail.trim() || undefined,
      }, user.id)
      const locationStr = [s.city, s.county, s.state].filter(Boolean).join(', ')
      api.compliance.triggerForProject(project.id, locationStr || undefined).catch(() => {})
      router.push(`/projects/${project.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
      setSubmitting(false)
    }
  }

  const inputCls = 'w-full bg-[#f8f8f7] border border-[#dededc] focus:border-blue-400/40 rounded-xl px-4 py-2.5 text-[#1a1a1a] placeholder-[#9ca3af] focus:outline-none transition-all text-sm'
  const labelCls = 'block text-xs font-semibold text-[#6b7280] uppercase tracking-wider mb-2'
  const cardStyle = { boxShadow: '0 8px 32px rgba(0,0,0,0.30)', border: '1px solid rgba(255,255,255,0.10)' }

  return (
    <div className="relative min-h-full" style={{ background: 'var(--color-surface-1)' }}>
      <div className="pointer-events-none absolute inset-0 opacity-[0.11]" style={{ backgroundImage: 'linear-gradient(rgba(0,127,255,1) 1.5px, transparent 1.5px), linear-gradient(90deg, rgba(0,127,255,1) 1.5px, transparent 1.5px)', backgroundSize: '34px 34px' }} />
      <div className="relative p-8 max-w-2xl mx-auto">
        <div className="flex items-center gap-3 mb-8">
          <Link href="/dashboard" className="text-[#6b7280] hover:text-[#1a1a1a] transition-colors text-sm">← Dashboard</Link>
          <span className="text-[#9ca3af]">/</span>
          <span className="text-[#1a1a1a] text-sm font-semibold">New Project</span>
        </div>

        <h1 className="text-2xl font-black text-[#1a1a1a] mb-1">New project</h1>
        <p className="text-[#6b7280] text-sm mb-6">Name it, drop in the address, and we’ll pull the satellite view next.</p>

        <form onSubmit={submit} className="space-y-5">
          {/* Project + address */}
          <div className="bg-[#f8f8f7] rounded-2xl p-6 space-y-5" style={cardStyle}>
            <div>
              <label className={labelCls}>Project name</label>
              <input type="text" required value={name} onChange={e => setName(e.target.value)} className={inputCls}
                placeholder="e.g. Johnson Reroof — 123 Oak St" />
            </div>

            <div className="relative">
              <label className={labelCls}>Property address</label>
              <input
                type="text" value={address} autoComplete="off"
                onChange={e => { setAddress(e.target.value); setSelected(null) }}
                className={inputCls} placeholder="Start typing the address…" />
              {searching && <div className="absolute right-3 top-9 text-xs text-[#6b7280]">searching…</div>}

              {matches.length > 0 && !selected && (
                <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-xl border border-[#dededc] bg-[#f8f8f7] shadow-2xl">
                  {matches.map((m, i) => (
                    <button key={i} type="button" onClick={() => pick(m)}
                      className="block w-full px-4 py-2.5 text-left text-sm text-[#1a1a1a] hover:bg-blue-600/20">
                      {m.matched_address}
                    </button>
                  ))}
                </div>
              )}

              {selected && (
                <div className="mt-2 flex items-center gap-2 rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
                  <span>✓</span>
                  <span>
                    {[selected.city, selected.county && `${selected.county} County`, selected.state, selected.zip].filter(Boolean).join(' · ')}
                    {!selected.county && <span className="text-emerald-300/70"> · county lookup pending</span>}
                  </span>
                  <button type="button" onClick={() => { setSelected(null); setAddress('') }} className="ml-auto text-emerald-300/80 hover:text-[#1a1a1a]">change</button>
                </div>
              )}
            </div>
          </div>

          {/* Customer (optional but recommended) */}
          <div className="bg-[#f8f8f7] rounded-2xl p-6 space-y-4" style={cardStyle}>
            <div className="flex items-baseline justify-between">
              <label className={labelCls} style={{ marginBottom: 0 }}>Customer</label>
              <span className="text-[11px] text-[#6b7280]">optional, but recommended</span>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <input type="text" value={custName} onChange={e => setCustName(e.target.value)} className={inputCls} placeholder="Name" />
              <input type="tel" value={custPhone} onChange={e => setCustPhone(e.target.value)} className={inputCls} placeholder="Phone" />
              <input type="email" value={custEmail} onChange={e => setCustEmail(e.target.value)} className={inputCls} placeholder="Email" />
            </div>
          </div>

          {error && (
            <div className="bg-rose-500/10 border border-rose-400/30 rounded-xl px-4 py-3 text-rose-300 text-sm">{error}</div>
          )}

          <button type="submit" disabled={submitting || !name.trim() || !selected}
            className="w-full text-white font-bold py-3.5 rounded-xl transition-all disabled:opacity-40 disabled:cursor-not-allowed hover:scale-[1.01]"
            style={{ background: '#007fff', boxShadow: '0 4px 14px rgba(59,130,246,0.3)' }}>
            {submitting ? 'Creating…' : 'Create project & pull satellite'}
          </button>
        </form>
      </div>
    </div>
  )
}
