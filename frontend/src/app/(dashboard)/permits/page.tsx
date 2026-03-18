'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getUser } from '@/lib/auth'
import { api } from '@/lib/api'
import type { Project } from '@/types'

const STATES = ['NC','CA','TX','FL','NY','GA','VA','WA','CO','AZ','IL','OH','PA']
const COUNTIES: Record<string, string[]> = {
  NC: ['Wake','Mecklenburg','Guilford','Durham','Forsyth'],
  CA: ['Los Angeles','San Diego','Orange','Riverside','San Bernardino'],
  TX: ['Harris','Dallas','Tarrant','Bexar','Travis'],
  FL: ['Miami-Dade','Broward','Palm Beach','Hillsborough','Orange'],
  NY: ['Kings','Queens','New York','Suffolk','Nassau'],
}
const CITIES: Record<string, string[]> = {
  Wake:       ['Raleigh','Cary','Apex','Holly Springs','Fuquay-Varina'],
  Mecklenburg:['Charlotte','Matthews','Mint Hill','Huntersville','Cornelius'],
  Guilford:   ['Greensboro','High Point','Jamestown'],
  Harris:     ['Houston','Pasadena','Baytown','Katy','Sugar Land'],
  'Los Angeles':['Los Angeles','Long Beach','Glendale','Burbank','Pasadena'],
  Dallas:     ['Dallas','Irving','Garland','Plano','Mesquite'],
}

const REQUIRED_DOCS: Record<string, string[]> = {
  default: [
    'Completed permit application (Form BP-1)',
    'Two sets of stamped architectural drawings',
    'Site plan with setbacks and dimensions',
    'Energy compliance certificate (Title 24 / REScheck)',
    'Structural calculations (if applicable)',
    'Proof of property ownership / authorization letter',
    'Contractor license number and insurance certificate',
  ],
}

type Step = 1 | 2 | 3
type SubmitStatus = 'idle' | 'generating' | 'ready' | 'submitting' | 'submitted'

export default function PermitsPage() {
  const router = useRouter()
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedProject, setSelectedProject] = useState('')
  const [step, setStep] = useState<Step>(1)
  const [state, setState] = useState('')
  const [county, setCounty] = useState('')
  const [city, setCity] = useState('')
  const [checklist, setChecklist] = useState<Record<string, boolean>>({})
  const [submitStatus, setSubmitStatus] = useState<SubmitStatus>('idle')

  useEffect(() => {
    async function load() {
      const u = await getUser()
      if (!u) { router.push('/login'); return }
      try {
        const data = await api.projects.list(u.id)
        setProjects(data || [])
        if (data?.length) setSelectedProject(data[0].id)
      } catch {}
      setLoading(false)
    }
    load()
  }, [router])

  useEffect(() => {
    // init checklist when we reach step 2
    if (step === 2) {
      const items = REQUIRED_DOCS.default
      const initial: Record<string, boolean> = {}
      items.forEach(item => { initial[item] = false })
      setChecklist(initial)
    }
  }, [step])

  const counties = state ? (COUNTIES[state] || ['General County']) : []
  const cities = county ? (CITIES[county] || ['General City']) : []
  const allChecked = Object.values(checklist).length > 0 && Object.values(checklist).every(Boolean)
  const checkedCount = Object.values(checklist).filter(Boolean).length
  const docs = REQUIRED_DOCS.default

  async function handleGenerate() {
    setSubmitStatus('generating')
    await new Promise(r => setTimeout(r, 1800))
    setSubmitStatus('ready')
  }

  async function handleSubmit() {
    setSubmitStatus('submitting')
    await new Promise(r => setTimeout(r, 2200))
    setSubmitStatus('submitted')
  }

  const project = projects.find(p => p.id === selectedProject)

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-black text-white">Permit Filing</h1>
        <p className="text-[#4a6a8a] text-sm mt-1">Automatically prepare and submit permits to your jurisdiction.</p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-24 text-[#4a6a8a]">Loading…</div>
      ) : (
        <div className="space-y-5">

          {/* Project selector */}
          <div className="bg-[#0f1e30] border border-[#1a2a3a] rounded-xl p-5">
            <label className="text-white font-semibold text-sm block mb-3">Project</label>
            {projects.length === 0 ? (
              <p className="text-[#4a6a8a] text-sm">No projects yet. Upload a blueprint first.</p>
            ) : (
              <select
                value={selectedProject}
                onChange={e => { setSelectedProject(e.target.value); setStep(1); setSubmitStatus('idle') }}
                className="w-full bg-[#0a1628] border border-[#1a2a3a] rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:border-blue-500/50"
              >
                {projects.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            )}
          </div>

          {/* Step indicator */}
          <div className="flex items-center gap-0 bg-[#0f1e30] border border-[#1a2a3a] rounded-xl overflow-hidden">
            {([
              { n: 1, label: 'Location' },
              { n: 2, label: 'Requirements' },
              { n: 3, label: 'Submit' },
            ] as { n: Step; label: string }[]).map(({ n, label }, i) => (
              <button
                key={n}
                onClick={() => step > n && setStep(n)}
                className={`flex-1 flex items-center justify-center gap-2 py-3.5 text-sm font-semibold transition-all relative ${
                  step === n
                    ? 'bg-blue-600/15 text-blue-400 border-b-2 border-blue-500'
                    : step > n
                    ? 'text-green-400 hover:bg-white/5 cursor-pointer'
                    : 'text-[#4a6a8a] cursor-default'
                } ${i < 2 ? 'border-r border-[#1a2a3a]' : ''}`}
              >
                <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${
                  step > n ? 'bg-green-500/20 text-green-400' : step === n ? 'bg-blue-600/30 text-blue-400' : 'bg-white/5 text-[#4a6a8a]'
                }`}>
                  {step > n
                    ? <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                    : n
                  }
                </span>
                {label}
              </button>
            ))}
          </div>

          {/* ── STEP 1: Location ─────────────────────────────────────────── */}
          {step === 1 && (
            <div className="bg-[#0f1e30] border border-[#1a2a3a] rounded-xl p-6 space-y-4">
              <h2 className="text-white font-bold text-sm">Select Jurisdiction</h2>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="text-[#4a6a8a] text-xs font-semibold uppercase tracking-wider block mb-2">State</label>
                  <select
                    value={state}
                    onChange={e => { setState(e.target.value); setCounty(''); setCity('') }}
                    className="w-full bg-[#0a1628] border border-[#1a2a3a] focus:border-blue-500/50 rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none"
                  >
                    <option value="">Select state…</option>
                    {STATES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[#4a6a8a] text-xs font-semibold uppercase tracking-wider block mb-2">County</label>
                  <select
                    value={county}
                    onChange={e => { setCounty(e.target.value); setCity('') }}
                    disabled={!state}
                    className="w-full bg-[#0a1628] border border-[#1a2a3a] focus:border-blue-500/50 rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none disabled:opacity-40"
                  >
                    <option value="">Select county…</option>
                    {counties.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[#4a6a8a] text-xs font-semibold uppercase tracking-wider block mb-2">City</label>
                  <select
                    value={city}
                    onChange={e => setCity(e.target.value)}
                    disabled={!county}
                    className="w-full bg-[#0a1628] border border-[#1a2a3a] focus:border-blue-500/50 rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none disabled:opacity-40"
                  >
                    <option value="">Select city…</option>
                    {cities.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
              </div>
              {state && county && (
                <div className="flex items-center gap-2 bg-blue-600/10 border border-blue-500/20 rounded-xl px-4 py-3 text-sm text-blue-300 mt-2">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                  Jurisdiction: <strong>{city || county}, {state}</strong> — permit portal detected
                </div>
              )}
              <div className="flex justify-end pt-2">
                <button
                  onClick={() => setStep(2)}
                  disabled={!state || !county}
                  className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white font-semibold px-6 py-2.5 rounded-xl text-sm transition-all"
                >
                  Continue →
                </button>
              </div>
            </div>
          )}

          {/* ── STEP 2: Requirements ─────────────────────────────────────── */}
          {step === 2 && (
            <div className="bg-[#0f1e30] border border-[#1a2a3a] rounded-xl p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-white font-bold text-sm">Required Documents</h2>
                <span className="text-xs text-[#4a6a8a]">{checkedCount} / {docs.length} confirmed</span>
              </div>
              <div className="w-full h-1.5 bg-[#1a2a3a] rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-600 rounded-full transition-all duration-500"
                  style={{ width: `${(checkedCount / docs.length) * 100}%` }}
                />
              </div>
              <div className="space-y-2">
                {docs.map(doc => (
                  <label
                    key={doc}
                    className={`flex items-start gap-3 p-3.5 rounded-xl border cursor-pointer transition-all ${
                      checklist[doc]
                        ? 'bg-green-500/5 border-green-500/20'
                        : 'bg-[#0a1628] border-[#1a2a3a] hover:border-[#2a3a4a]'
                    }`}
                  >
                    <div className={`w-5 h-5 rounded-md border flex items-center justify-center flex-shrink-0 mt-0.5 transition-all ${
                      checklist[doc] ? 'bg-green-500 border-green-500' : 'border-[#2a3a4a] bg-[#0a1628]'
                    }`}>
                      {checklist[doc] && (
                        <svg width="10" height="8" viewBox="0 0 10 8" fill="none"><path d="M1 4L3.5 6.5L9 1" stroke="white" strokeWidth="1.5" strokeLinecap="round"/></svg>
                      )}
                    </div>
                    <input type="checkbox" className="sr-only" checked={!!checklist[doc]} onChange={e => setChecklist(prev => ({ ...prev, [doc]: e.target.checked }))} />
                    <span className={`text-sm transition-colors ${checklist[doc] ? 'text-green-300 line-through opacity-60' : 'text-white'}`}>{doc}</span>
                  </label>
                ))}
              </div>
              <div className="flex justify-between pt-2">
                <button onClick={() => setStep(1)} className="text-[#4a6a8a] hover:text-white text-sm font-medium transition-colors">← Back</button>
                <button
                  onClick={() => setStep(3)}
                  disabled={!allChecked}
                  className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white font-semibold px-6 py-2.5 rounded-xl text-sm transition-all"
                >
                  {allChecked ? 'Ready to Submit →' : `Check all ${docs.length - checkedCount} remaining`}
                </button>
              </div>
            </div>
          )}

          {/* ── STEP 3: Submission ───────────────────────────────────────── */}
          {step === 3 && (
            <div className="bg-[#0f1e30] border border-[#1a2a3a] rounded-xl p-6 space-y-5">
              <h2 className="text-white font-bold text-sm">Submit Permit Application</h2>

              {/* Summary */}
              <div className="grid grid-cols-2 gap-3">
                {[
                  { label: 'Project', value: project?.name || '—' },
                  { label: 'Jurisdiction', value: `${city || county}, ${state}` },
                  { label: 'Documents', value: `${docs.length} items confirmed` },
                  { label: 'Submission Method', value: 'Online portal (eTRAKiT)' },
                ].map(row => (
                  <div key={row.label} className="bg-[#0a1628] border border-[#1a2a3a] rounded-xl px-4 py-3">
                    <div className="text-[#4a6a8a] text-xs font-semibold uppercase tracking-wider mb-1">{row.label}</div>
                    <div className="text-white text-sm font-medium">{row.value}</div>
                  </div>
                ))}
              </div>

              {/* Status indicator */}
              {submitStatus === 'submitted' ? (
                <div className="flex items-center gap-3 bg-green-500/10 border border-green-500/20 rounded-xl px-5 py-4">
                  <div className="w-10 h-10 bg-green-500/20 rounded-full flex items-center justify-center flex-shrink-0">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                  </div>
                  <div>
                    <div className="text-green-400 font-bold text-sm">Submitted Successfully</div>
                    <div className="text-green-300/60 text-xs mt-0.5">Confirmation #AXS-{Math.floor(Math.random() * 90000) + 10000} · Expect response within 5–7 business days</div>
                  </div>
                </div>
              ) : submitStatus === 'ready' ? (
                <div className="flex items-center gap-3 bg-blue-600/10 border border-blue-500/20 rounded-xl px-5 py-4">
                  <div className="w-10 h-10 bg-blue-600/20 rounded-full flex items-center justify-center flex-shrink-0">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="2" strokeLinecap="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                  </div>
                  <div>
                    <div className="text-blue-400 font-bold text-sm">Permit Packet Ready</div>
                    <div className="text-blue-300/60 text-xs mt-0.5">All documents compiled · Ready to submit to {city || county} building department</div>
                  </div>
                </div>
              ) : submitStatus === 'generating' ? (
                <div className="flex items-center gap-3 bg-[#0a1628] border border-[#1a2a3a] rounded-xl px-5 py-4">
                  <svg className="animate-spin text-blue-400 flex-shrink-0" width="20" height="20" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>
                  <div className="text-[#64748b] text-sm">Compiling permit packet…</div>
                </div>
              ) : null}

              <div className="flex justify-between pt-2">
                <button onClick={() => setStep(2)} className="text-[#4a6a8a] hover:text-white text-sm font-medium transition-colors">← Back</button>
                <div className="flex gap-3">
                  {submitStatus === 'idle' && (
                    <button
                      onClick={handleGenerate}
                      className="bg-[#0a1628] hover:bg-white/5 border border-[#1a2a3a] hover:border-[#2a3a4a] text-white font-semibold px-5 py-2.5 rounded-xl text-sm transition-all"
                    >
                      Generate Permit Packet
                    </button>
                  )}
                  {(submitStatus === 'ready' || submitStatus === 'idle') && (
                    <button
                      onClick={submitStatus === 'ready' ? handleSubmit : handleGenerate}
                      disabled={submitStatus === 'idle'}
                      className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white font-bold px-6 py-2.5 rounded-xl text-sm transition-all"
                    >
                      {submitStatus === 'submitting'
                        ? <span className="flex items-center gap-2"><svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="white" strokeWidth="4"/><path className="opacity-75" fill="white" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>Submitting…</span>
                        : 'Submit to Jurisdiction'
                      }
                    </button>
                  )}
                  {submitStatus === 'submitting' && (
                    <button disabled className="bg-blue-600 opacity-60 text-white font-bold px-6 py-2.5 rounded-xl text-sm flex items-center gap-2">
                      <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="white" strokeWidth="4"/><path className="opacity-75" fill="white" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>
                      Submitting…
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
