'use client'

/**
 * RoofIQ — the homeowner-facing Instant Roof Intelligence flow.
 *
 * Multi-step, mobile-first, light theme:
 *   1. ADDRESS  — big input + "use my location"
 *   2. CONFIRM  — satellite tile, tap-to-place pin ("is this your roof?").
 *                 The confirmed pin anchors measurement on the RIGHT building.
 *   3. QUALIFY  — roof age / stories / issues (chip taps, educational lines)
 *   4. CAPTURE  — \"you're almost there\" — contact info BEFORE any reveal
 *   5. RESULT   — full estimate: materials, financing, disclaimer, report link
 *
 * Funnel events fire at each step for the contractor's analytics.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'next/navigation'

import { api } from '@/lib/api'

const API_BASE = (process.env.NEXT_PUBLIC_API_URL || 'https://build-backend-jcp9.onrender.com').trim()

type Step = 'address' | 'confirm' | 'qualify' | 'capture' | 'result'

const MATERIALS = [
  { key: 'arch', label: 'Architectural asphalt', note: 'Most common', mult: 1.0 },
  { key: 'designer', label: 'Premium / designer', note: 'Upgraded look + warranty', mult: 1.25 },
  { key: 'metal', label: 'Standing-seam metal', note: 'Longest lifespan', mult: 1.7 },
] as const

const AGES = [
  { key: '0-5', label: '0–5 yrs', insight: 'Nearly new — you’re planning ahead. Smart.' },
  { key: '5-15', label: '5–15 yrs', insight: 'Mid-life — maintenance now prevents big repairs later.' },
  { key: '15-25', label: '15–25 yrs', insight: 'Entering the replacement window for asphalt shingles.' },
  { key: '25+', label: '25+ yrs', insight: 'Past typical asphalt lifespan — worth a professional look soon.' },
  { key: 'unsure', label: 'Not sure', insight: 'No problem — an inspection pins this down exactly.' },
] as const

const ISSUES = [
  { key: 'leak', label: '💧 Leak' },
  { key: 'storm_damage', label: '⛈ Storm damage' },
  { key: 'missing_shingles', label: '🍂 Missing shingles' },
  { key: 'sagging', label: '📉 Sagging' },
  { key: 'planning', label: '📋 Just planning ahead' },
] as const

const WORK_TYPES = [
  { key: 'replace', label: 'Full replacement' },
  { key: 'repair', label: 'Repair' },
  { key: 'unsure', label: 'Not sure yet' },
] as const

const CONDITIONS: { key: string; label: string; insight?: string }[] = [
  { key: 'no_damage', label: 'No visible damage' },
  { key: 'visible_damage', label: 'Visible damage', insight: 'Good to know — we’ll prioritize a closer look at those areas.' },
  { key: 'unsure', label: 'Not sure' },
]

// Multi-select. "Nothing" / "Not sure" are mutually exclusive with real items.
const ROOFTOP_ITEMS: { key: string; label: string; insight?: string }[] = [
  { key: 'satellite_dish', label: '📡 Satellite dish' },
  { key: 'solar_panels', label: '☀️ Solar panels', insight: 'Solar affects the job — panels are detached and reset around the new roof.' },
  { key: 'hvac', label: '❄️ HVAC unit' },
  { key: 'antenna', label: '📶 Antenna' },
  { key: 'nothing', label: 'Nothing' },
  { key: 'unsure', label: 'Not sure' },
]

const DRAINAGE = [
  { key: 'external_gutters', label: 'External gutters' },
  { key: 'internal_gutters', label: 'Internal gutters' },
  { key: 'none', label: 'None' },
  { key: 'unsure', label: 'Not sure' },
] as const

function monthly(principal: number): number {
  const r = 0.099 / 12, n = 120
  return principal * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1)
}

const inputCls = 'rounded-lg border border-slate-300 bg-white px-3 py-3 text-sm text-slate-900 placeholder:text-slate-400 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20'
const chipCls = (on: boolean) => `rounded-xl border px-3 py-2.5 text-sm font-medium transition ${
  on ? 'border-blue-500 bg-blue-50 text-blue-900 shadow-sm' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
}`

export default function RoofIQPage() {
  const params = useParams<{ key: string }>()
  const search = useSearchParams()
  const widgetKey = params.key
  const embedded = search.get('embed') === '1'

  const [company, setCompany] = useState('')
  const [companyPhone, setCompanyPhone] = useState('')
  const [notFound, setNotFound] = useState(false)
  const [step, setStep] = useState<Step>('address')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // location + imagery
  const [address, setAddress] = useState('')
  const [located, setLocated] = useState<{ lat: number; lng: number; address: string } | null>(null)
  const [imagery, setImagery] = useState<{ url: string; width_px: number; height_px: number; feet_per_pixel: number } | null>(null)
  const [pin, setPin] = useState<{ x: number; y: number }>({ x: 0.5, y: 0.5 })
  const [confirmed, setConfirmed] = useState(false)
  const imgRef = useRef<HTMLImageElement>(null)

  // qualification
  const [age, setAge] = useState<string>('')
  const [stories, setStories] = useState<number>(0)
  const [issues, setIssues] = useState<string[]>([])
  const [qualifyPage, setQualifyPage] = useState<1 | 2>(1)
  const [workType, setWorkType] = useState<string>('')
  const [condition, setCondition] = useState<string>('')
  const [rooftopItems, setRooftopItems] = useState<string[]>([])
  const [chimneySky, setChimneySky] = useState<boolean | null>(null)
  const [attic, setAttic] = useState<boolean | null>(null)
  const [drainage, setDrainage] = useState<string>('')

  const toggleRooftop = useCallback((k: string) => {
    setRooftopItems(prev => {
      if (k === 'nothing' || k === 'unsure') return prev.includes(k) ? [] : [k]
      const base = prev.filter(x => x !== 'nothing' && x !== 'unsure')
      return base.includes(k) ? base.filter(x => x !== k) : [...base, k]
    })
  }, [])

  // quote + contact
  const [quote, setQuote] = useState<Awaited<ReturnType<typeof api.instantQuote.quote>> | null>(null)
  const quoteRef = useRef<typeof quote>(null)
  useEffect(() => { quoteRef.current = quote }, [quote])
  const [material, setMaterial] = useState<typeof MATERIALS[number]['key']>('arch')
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [reportUrl, setReportUrl] = useState<string | null>(null)
  const [website, setWebsite] = useState('')   // honeypot — humans never see or fill this
  const [factorsOpen, setFactorsOpen] = useState(false)

  const sessionId = useMemo(() => `s-${Math.random().toString(36).slice(2, 12)}`, [])
  const track = useCallback((event: string) => { void api.instantQuote.trackEvent(widgetKey, sessionId, event) }, [widgetKey, sessionId])

  useEffect(() => {
    if (!widgetKey) return
    api.instantQuote.widgetConfig(widgetKey)
      .then(c => { setCompany(c.company_name); setCompanyPhone(c.phone); track('view') })
      .catch(() => setNotFound(true))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widgetKey])

  // ---- step 1 → 2: locate ----
  const locate = useCallback(async (geo?: { lat: number; lng: number }) => {
    if (!geo && address.trim().length < 6) { setError('Enter your full address, including the city.'); return }
    setBusy(true); setError(null)
    try {
      const r = await api.instantQuote.locate(widgetKey, geo ? { lat: geo.lat, lng: geo.lng } : { address: address.trim() })
      if (!r.found || r.lat == null) { setError(r.message || 'Address not found.'); return }
      setLocated({ lat: r.lat, lng: r.lng as number, address: r.address || address.trim() })
      setImagery(r.imagery || null)
      setPin({ x: 0.5, y: 0.5 })
      setConfirmed(false)
      track('address_entered')
      setStep(r.imagery ? 'confirm' : 'qualify')   // no tile? skip confirm gracefully
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/\[HTTP \d+\]\s*/, '') : 'Something went wrong — try again.')
    } finally {
      setBusy(false)
    }
  }, [address, widgetKey, track])

  const useMyLocation = useCallback(() => {
    if (!navigator.geolocation) { setError('Location not available — type your address instead.'); return }
    setBusy(true)
    navigator.geolocation.getCurrentPosition(
      pos => { setAddress('My location'); void locate({ lat: pos.coords.latitude, lng: pos.coords.longitude }) },
      () => { setBusy(false); setError('Couldn’t get your location — type your address instead.') },
      { timeout: 8000 },
    )
  }, [locate])

  // pin lat/lng from the tapped fraction (same conversion the app uses)
  const pinLatLng = useCallback(() => {
    if (!located || !imagery) return located
    const mpp = imagery.feet_per_pixel * 0.3048
    const eastM = (pin.x - 0.5) * imagery.width_px * mpp
    const northM = (0.5 - pin.y) * imagery.height_px * mpp
    return {
      lat: located.lat + northM / 111320,
      lng: located.lng + eastM / (111320 * Math.cos((located.lat * Math.PI) / 180)),
      address: located.address,
    }
  }, [located, imagery, pin])

  // ---- step 2 → 3 ----
  const confirmRoof = useCallback(() => {
    setConfirmed(true)
    track('roof_confirmed')
    setStep('qualify')
  }, [track])

  // ---- step 3 → 4: measurement runs SILENTLY while they enter contact info.
  // Fully gated by design: no numbers (and no measurement hiccups) are shown
  // until after capture — the reveal happens on the result screen.
  const quotePromiseRef = useRef<Promise<void> | null>(null)
  const finishQualify = useCallback(() => {
    track('qualified')
    setStep('capture')
    const at = pinLatLng() || located
    quotePromiseRef.current = api.instantQuote.quote(widgetKey, at?.address || address, at?.lat, at?.lng)
      .then(q => setQuote(q))
      .catch(() => { /* result screen handles a missing quote gracefully */ })
  }, [track, pinLatLng, located, widgetKey, address])

  // ---- step 4 → 5: capture, then reveal ----
  const unlock = useCallback(async () => {
    if (name.trim().length < 2) { setError('Please enter your name.'); return }
    if (!phone.trim() && !email.trim()) { setError('A phone number or email is needed to send your report.'); return }
    setBusy(true); setError(null)
    try {
      // Make sure the background measurement finished before we submit + reveal.
      if (quotePromiseRef.current) await quotePromiseRef.current
      const q = quoteRef.current
      const res = await api.instantQuote.submitLead(widgetKey, {
        name: name.trim(), phone: phone.trim() || undefined, email: email.trim() || undefined,
        address: located?.address || address,
        lat: located?.lat, lng: located?.lng,
        squares_estimate: q?.squares, roof_sqft: q?.roof_sqft,
        price_low: q?.price_low, price_high: q?.price_high,
        quote_source: q?.source,
        roof_age: age || undefined, stories: stories || undefined, issues,
        work_type: workType || undefined,
        condition: condition || undefined,
        rooftop_items: rooftopItems.length ? rooftopItems : undefined,
        chimney_skylights: chimneySky ?? undefined,
        attic: attic ?? undefined,
        drainage: drainage || undefined,
        roof_confirmed: confirmed,
        imagery_url: imagery?.url,
        website: website || undefined,
        notes: [
          workType ? `Work: ${workType}` : null,
          condition ? `Condition: ${condition}` : null,
          age ? `Roof age: ${age}` : null,
          stories ? `${stories} stories` : null,
          issues.length ? `Issues: ${issues.join(', ')}` : null,
          rooftopItems.length ? `On roof: ${rooftopItems.join(', ')}` : null,
          chimneySky != null ? `Chimney/skylights: ${chimneySky ? 'yes' : 'no'}` : null,
          attic != null ? `Attic: ${attic ? 'yes' : 'no'}` : null,
          drainage ? `Drainage: ${drainage}` : null,
        ].filter(Boolean).join(' · '),
      })
      setReportUrl(res.report_url || null)
      track('lead_captured')
      setStep('result')
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/\[HTTP \d+\]\s*/, '') : 'Could not send — please call instead.')
    } finally {
      setBusy(false)
    }
  }, [name, phone, email, located, address, age, stories, issues, workType, condition, rooftopItems, chimneySky, attic, drainage, confirmed, imagery, widgetKey, track])

  const money = (v?: number | null) => v == null ? '—' : v.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
  const stepIndex = ['address', 'confirm', 'qualify', 'capture', 'result'].indexOf(step)

  if (notFound) {
    return <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6 text-slate-600">This quote tool isn&apos;t available. Please contact the contractor directly.</main>
  }

  return (
    <main
      className={`min-h-screen text-slate-900 ${embedded ? 'p-3' : 'flex items-start justify-center p-4 pt-8 sm:items-center sm:p-8'}`}
      style={{ background: 'radial-gradient(1100px 420px at 50% -8%, #dcebff 0%, rgba(220,235,255,0) 62%), linear-gradient(170deg, #f8fafc 0%, #eef4fb 55%, #f8fafc 100%)' }}
    >
      <div className="w-full max-w-xl">
        {/* Header */}
        <div className="mb-5 text-center">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl text-3xl shadow-[0_8px_24px_-8px_rgba(37,99,235,0.5)] ring-1 ring-white/60"
            style={{ background: 'linear-gradient(150deg, #eff6ff 0%, #dbeafe 100%)' }}>🏠</div>
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.28em] text-blue-600/80">Instant Roof Intelligence</div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{company || '…'}</h1>
          <p className="mt-1.5 text-sm text-slate-500">Hi there 👋 Let&apos;s get you a free roof estimate — it takes about a minute.</p>
          <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5">
            {['🆓 100% free', '⏱️ ~60 seconds', '🔒 No spam, ever'].map(t => (
              <span key={t} className="rounded-full bg-white/70 px-2.5 py-1 text-[11px] font-medium text-slate-600 ring-1 ring-slate-200/70 backdrop-blur">{t}</span>
            ))}
          </div>
        </div>

        {/* Progress dots */}
        <div className="mb-4 flex items-center justify-center gap-1.5">
          {[0, 1, 2, 3, 4].map(i => (
            <span key={i} className={`h-1.5 rounded-full transition-all ${i <= stepIndex ? 'w-6 bg-blue-600' : 'w-1.5 bg-slate-300'}`} />
          ))}
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_10px_40px_-12px_rgba(15,40,80,0.15)] sm:p-6">

          {/* ── 1. ADDRESS ── */}
          {step === 'address' && (
            <>
              <div className="mb-3 text-center">
                <div className="text-base font-semibold text-slate-800">Where&apos;s your home? 🛰️</div>
                <p className="mt-0.5 text-xs text-slate-500">Pop in your address and we&apos;ll pull up your roof from above.</p>
              </div>
              <div className="mt-2 flex gap-2">
                <input
                  type="text" value={address} onChange={e => setAddress(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') void locate() }}
                  placeholder="123 Main St, Springfield, IL"
                  className={`min-w-0 flex-1 ${inputCls}`}
                />
                <button onClick={() => void locate()} disabled={busy}
                  className="shrink-0 rounded-lg px-4 py-3 text-sm font-semibold text-white transition hover:scale-[1.02] disabled:opacity-50"
                  style={{ background: 'linear-gradient(180deg, #3B82F6 0%, #1E40AF 100%)', boxShadow: '0 6px 20px rgba(59,130,246,0.35)' }}
                >{busy ? 'Finding…' : 'Continue →'}</button>
              </div>
              <button onClick={useMyLocation} disabled={busy}
                className="mt-2.5 flex w-full items-center justify-center gap-1 rounded-lg border border-slate-200 bg-slate-50 py-2 text-xs font-semibold text-blue-600 transition hover:bg-slate-100 disabled:opacity-50">
                📍 Use my current location
              </button>
              <p className="mt-3 text-center text-[11px] text-slate-400">No calls unless you want one · your info stays with {company || 'your local roofer'}</p>
            </>
          )}

          {/* ── 2. CONFIRM ── */}
          {step === 'confirm' && imagery && (
            <>
              <div className="text-sm font-semibold">Is this your roof?</div>
              <p className="mt-0.5 text-xs text-slate-500">{located?.address} — <strong>tap your roof</strong> so the measurement locks onto exactly the right building.</p>
              <div className="relative mt-3 overflow-hidden rounded-xl ring-1 ring-slate-200">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  ref={imgRef}
                  src={`${API_BASE}${imagery.url}`}
                  alt="Satellite view of your home"
                  className="block w-full cursor-crosshair select-none"
                  draggable={false}
                  onClick={e => {
                    const r = imgRef.current?.getBoundingClientRect()
                    if (!r) return
                    setPin({
                      x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
                      y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
                    })
                  }}
                />
                {/* pin */}
                <div className="pointer-events-none absolute" style={{ left: `${pin.x * 100}%`, top: `${pin.y * 100}%`, transform: 'translate(-50%, -100%)' }}>
                  <div className="text-3xl drop-shadow-lg">📍</div>
                </div>
                <div className="pointer-events-none absolute animate-ping rounded-full border-2 border-blue-400"
                  style={{ left: `${pin.x * 100}%`, top: `${pin.y * 100}%`, width: 28, height: 28, transform: 'translate(-50%, -50%)' }} />
              </div>
              <div className="mt-3 flex gap-2">
                <button onClick={confirmRoof}
                  className="flex-1 rounded-lg bg-emerald-600 py-3 text-sm font-semibold text-white shadow-[0_6px_18px_rgba(5,150,105,0.3)] hover:bg-emerald-500"
                >✓ Yes, that&apos;s my roof</button>
                <button onClick={() => setStep('address')}
                  className="rounded-lg bg-slate-100 px-4 text-sm text-slate-600 ring-1 ring-slate-200 hover:bg-slate-200">Wrong address</button>
              </div>
            </>
          )}

          {/* ── 3. QUALIFY — two quick chip screens ── */}
          {step === 'qualify' && (
            <>
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold">Tell us about your roof 🏡</div>
                <div className="font-mono text-[10px] uppercase tracking-wide text-slate-400">Step {qualifyPage} of 2</div>
              </div>
              <p className="mt-0.5 text-xs text-slate-500">A few quick taps sharpen your estimate — no wrong answers.</p>

              {/* sub-progress */}
              <div className="mt-2 flex gap-1.5">
                {[1, 2].map(p => (
                  <span key={p} className={`h-1 flex-1 rounded-full transition-all ${p <= qualifyPage ? 'bg-blue-500' : 'bg-slate-200'}`} />
                ))}
              </div>

              {/* ---- page 1: work + condition + age + stories ---- */}
              {qualifyPage === 1 && (
                <>
                  <div className="mt-4">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">What work do you need?</div>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {WORK_TYPES.map(w => (
                        <button key={w.key} onClick={() => setWorkType(w.key)} className={chipCls(workType === w.key)}>{w.label}</button>
                      ))}
                    </div>
                  </div>

                  <div className="mt-4">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">What condition is the roof in?</div>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {CONDITIONS.map(c => (
                        <button key={c.key} onClick={() => setCondition(c.key)} className={chipCls(condition === c.key)}>{c.label}</button>
                      ))}
                    </div>
                    {condition && CONDITIONS.find(c => c.key === condition)?.insight &&
                      <p className="mt-1.5 text-[11px] text-blue-700/80">💡 {CONDITIONS.find(c => c.key === condition)?.insight}</p>}
                  </div>

                  <div className="mt-4">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">How old is the roof?</div>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {AGES.map(a => (
                        <button key={a.key} onClick={() => setAge(a.key)} className={chipCls(age === a.key)}>{a.label}</button>
                      ))}
                    </div>
                    {age && <p className="mt-1.5 text-[11px] text-blue-700/80">💡 {AGES.find(a => a.key === age)?.insight}</p>}
                  </div>

                  <div className="mt-4">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">How many stories?</div>
                    <div className="mt-1.5 flex gap-1.5">
                      {[1, 2, 3].map(n => (
                        <button key={n} onClick={() => setStories(n)} className={chipCls(stories === n)}>{n === 3 ? '3+' : n}</button>
                      ))}
                    </div>
                  </div>

                  <button onClick={() => setQualifyPage(2)}
                    className="mt-5 w-full rounded-lg py-3 text-sm font-semibold text-white transition hover:scale-[1.01]"
                    style={{ background: 'linear-gradient(180deg, #3B82F6 0%, #1E40AF 100%)', boxShadow: '0 6px 20px rgba(59,130,246,0.35)' }}
                  >Continue →</button>
                </>
              )}

              {/* ---- page 2: issues + rooftop items + chimney/skylights + attic + drainage ---- */}
              {qualifyPage === 2 && (
                <>
                  <div className="mt-4">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Anything going on with it?</div>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {ISSUES.map(i => (
                        <button key={i.key}
                          onClick={() => setIssues(prev => prev.includes(i.key) ? prev.filter(x => x !== i.key) : [...prev, i.key])}
                          className={chipCls(issues.includes(i.key))}>{i.label}</button>
                      ))}
                    </div>
                  </div>

                  <div className="mt-4">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Anything on the roof? <span className="font-normal normal-case text-slate-400">(select any)</span></div>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {ROOFTOP_ITEMS.map(r => (
                        <button key={r.key} onClick={() => toggleRooftop(r.key)} className={chipCls(rooftopItems.includes(r.key))}>{r.label}</button>
                      ))}
                    </div>
                    {rooftopItems.includes('solar_panels') &&
                      <p className="mt-1.5 text-[11px] text-blue-700/80">💡 {ROOFTOP_ITEMS.find(r => r.key === 'solar_panels')?.insight}</p>}
                  </div>

                  <div className="mt-4 grid grid-cols-2 gap-3">
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Chimneys or skylights?</div>
                      <div className="mt-1.5 flex gap-1.5">
                        <button onClick={() => setChimneySky(true)} className={chipCls(chimneySky === true)}>Yes</button>
                        <button onClick={() => setChimneySky(false)} className={chipCls(chimneySky === false)}>No</button>
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Does it have an attic?</div>
                      <div className="mt-1.5 flex gap-1.5">
                        <button onClick={() => setAttic(true)} className={chipCls(attic === true)}>Yes</button>
                        <button onClick={() => setAttic(false)} className={chipCls(attic === false)}>No</button>
                      </div>
                    </div>
                  </div>

                  <div className="mt-4">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">What drainage does it have?</div>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {DRAINAGE.map(d => (
                        <button key={d.key} onClick={() => setDrainage(d.key)} className={chipCls(drainage === d.key)}>{d.label}</button>
                      ))}
                    </div>
                  </div>

                  <div className="mt-5 flex gap-2">
                    <button onClick={() => setQualifyPage(1)}
                      className="rounded-lg bg-slate-100 px-4 py-3 text-sm font-semibold text-slate-600 ring-1 ring-slate-200 hover:bg-slate-200">← Back</button>
                    <button onClick={() => void finishQualify()}
                      className="flex-1 rounded-lg py-3 text-sm font-semibold text-white transition hover:scale-[1.01]"
                      style={{ background: 'linear-gradient(180deg, #3B82F6 0%, #1E40AF 100%)', boxShadow: '0 6px 20px rgba(59,130,246,0.35)' }}
                    >Measure my roof →</button>
                  </div>
                </>
              )}
            </>
          )}

          {/* ── 4. CAPTURE — "you're almost there" (fully gated reveal) ── */}
          {step === 'capture' && (
            <>
              <div className="text-center">
                <div className="text-2xl">🛰</div>
                <div className="mt-1 text-sm font-semibold">You&apos;re almost there, {located ? 'your report is being generated' : 'one last step'}.</div>
                <p className="mx-auto mt-1 max-w-sm text-xs text-slate-500">
                  We&apos;re analyzing satellite and solar data for <strong className="text-slate-700">{located?.address}</strong> right now.
                  Just a few details so we can personalize your report and send your copy.
                </p>
              </div>

              {/* subtle working indicator — never a failure message pre-capture */}
              <div className="mx-auto mt-3 flex w-fit items-center gap-2 rounded-full bg-blue-50 px-3 py-1.5 text-[11px] font-medium text-blue-700 ring-1 ring-blue-100">
                <span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
                Analyzing roof geometry…
              </div>

              <div className="mt-4 grid gap-2">
                {/* honeypot — visually hidden, tab-skipped; bots auto-fill it */}
                <input type="text" value={website} onChange={e => setWebsite(e.target.value)} name="website"
                  autoComplete="off" tabIndex={-1} aria-hidden="true"
                  className="absolute -left-[9999px] h-0 w-0 opacity-0" />
                <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Your name" className={inputCls} />
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <input type="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="Phone" className={inputCls} />
                  <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" className={inputCls} />
                </div>
                {error && <p className="text-xs text-rose-600">{error}</p>}
                <button onClick={() => void unlock()} disabled={busy}
                  className="rounded-lg bg-emerald-600 py-3 text-sm font-semibold text-white shadow-[0_6px_18px_rgba(5,150,105,0.3)] hover:bg-emerald-500 disabled:opacity-50"
                >{busy ? 'Finalizing your report…' : '📄 Generate my report'}</button>
                <p className="text-center text-[10px] text-slate-400">
                  Free · no obligation · {company || 'the contractor'} will follow up with a precise proposal
                </p>
              </div>
            </>
          )}

          {/* ── 5. RESULT ── */}
          {step === 'result' && (
            <>
              <div className="text-center">
                <div className="text-2xl">🎉</div>
                <div className="mt-1 text-sm font-semibold">Here&apos;s your estimate, {name.split(' ')[0]}</div>
                <div className="text-xs text-slate-500">{located?.address}</div>
              </div>

              {!quote?.measured && (
                <div className="mt-3 rounded-xl border border-blue-200 bg-blue-50 p-4 text-center">
                  <div className="text-sm font-semibold text-slate-800">Your roof needs a professional touch 🛠</div>
                  <p className="mt-1 text-xs leading-relaxed text-slate-600">
                    Satellite data couldn&apos;t fully resolve this roof automatically (tree cover and
                    coverage gaps do this). The good news: <strong>{company || 'the contractor'} will complete
                    your measurement personally — free</strong> — and your report will be updated with exact numbers.
                  </p>
                </div>
              )}

              {quote?.measured && (() => {
                const mult = MATERIALS.find(m => m.key === material)?.mult ?? 1
                const lo = (quote.price_low ?? 0) * mult
                const hi = (quote.price_high ?? 0) * mult
                return (
                  <>
                    <div className="mt-3">
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Roof material</div>
                      <div className="mt-1.5 grid grid-cols-3 gap-1.5">
                        {MATERIALS.map(m => (
                          <button key={m.key} onClick={() => setMaterial(m.key)}
                            className={`rounded-lg border px-2 py-2 text-center transition ${
                              material === m.key ? 'border-blue-500 bg-blue-50 text-blue-900 shadow-sm' : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'
                            }`}>
                            <div className="text-[11px] font-semibold leading-tight">{m.label}</div>
                            <div className="mt-0.5 text-[9px] text-slate-400">{m.note}</div>
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-3">
                      <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-center">
                        <div className="text-xl font-bold">{quote.roof_sqft?.toLocaleString()} ft²</div>
                        <div className="mt-0.5 text-[10px] uppercase tracking-wide text-slate-500">Measured roof area</div>
                      </div>
                      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-center">
                        <div className="text-xl font-bold text-emerald-700">{money(lo)}–{money(hi)}</div>
                        <div className="mt-0.5 text-[10px] uppercase tracking-wide text-emerald-600/80">Estimated range</div>
                        <div className="mt-1 text-[10px] text-slate-500">or from <strong className="text-emerald-700">{money(monthly(lo))}/mo</strong>*</div>
                      </div>
                    </div>
                  </>
                )
              })()}

              {/* disclaimer */}
              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
                <div className="text-[11px] font-semibold text-amber-900">ⓘ This is a rough, AI-powered educational estimate — not an official quote.</div>
                <p className="mt-1 text-[11px] leading-relaxed text-amber-900/70">
                  Built from satellite imagery and regional pricing. {company || 'The contractor'} provides an exact written proposal after a free on-site review.
                </p>
                <button onClick={() => setFactorsOpen(o => !o)} className="mt-1 text-[11px] font-semibold text-amber-800 hover:underline">
                  {factorsOpen ? 'Hide' : 'What can change the price?'}
                </button>
                {factorsOpen && (
                  <ul className="mt-1.5 space-y-0.5 text-[11px] text-amber-900/70">
                    <li>• Roof steepness &amp; height · tear-off layers · decking condition</li>
                    <li>• Material &amp; color choice · chimneys/skylights/valleys · local code &amp; permits</li>
                  </ul>
                )}
                <p className="mt-1 text-[10px] text-amber-900/50">*Financing example: 9.9% APR, 120 mo, subject to credit approval.</p>
              </div>

              {/* What happens next — explicit, professional */}
              <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">What happens next</div>
                <ul className="mt-1.5 space-y-1 text-xs text-slate-600">
                  <li>✓ Your details are with <strong>{company || 'the contractor'}</strong> — they&apos;ll reach out to schedule your <strong>free, precise on-site quote</strong>.</li>
                  <li>✓ Serious about moving forward? Calling now gets you on the schedule fastest.</li>
                  <li>✓ Your report link below is yours to keep and share.</li>
                </ul>
              </div>

              <div className="mt-4 grid gap-2">
                {reportUrl && (
                  <a href={reportUrl} target="_blank" rel="noreferrer"
                    className="rounded-lg py-3 text-center text-sm font-semibold text-white transition hover:scale-[1.01]"
                    style={{ background: 'linear-gradient(180deg, #3B82F6 0%, #1E40AF 100%)', boxShadow: '0 6px 20px rgba(59,130,246,0.35)' }}
                  >📄 View my full Roof Intelligence Report</a>
                )}
                {companyPhone && (
                  <a href={`tel:${companyPhone}`}
                    className="rounded-lg bg-emerald-600 py-3 text-center text-sm font-semibold text-white hover:bg-emerald-500"
                  >📅 Book my free inspection — call {companyPhone}</a>
                )}
              </div>
            </>
          )}

          {error && step !== 'capture' && <p className="mt-3 text-xs text-rose-600">{error}</p>}
        </div>

        {!embedded && (
          <p className="mt-4 text-center text-[10px] text-slate-400">Measurements powered by Axis Performance aerial + solar data.</p>
        )}
      </div>
    </main>
  )
}
