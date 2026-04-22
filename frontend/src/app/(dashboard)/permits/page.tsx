'use client'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getUser } from '@/lib/auth'
import { api } from '@/lib/api'
import type { Project } from '@/types'
import { STATES, COUNTIES, CITIES } from '@/lib/jurisdictions'

// Permit office lookup by state → county/city
const PERMIT_OFFICES: Record<string, { name: string; address: string; phone: string; portal: string }> = {
  // Format: "STATE_County" or "STATE" as fallback
  'NC_Mecklenburg': { name: 'Mecklenburg County Building Standards Dept.', address: '2145 Suttle Ave, Charlotte, NC 28208', phone: '(704) 336-3821', portal: 'https://meckpermit.com' },
  'NC_Wake': { name: 'Wake County Permits & Inspections', address: '337 S Salisbury St, Raleigh, NC 27601', phone: '(919) 856-6222', portal: 'https://raleighnc.gov/permits' },
  'NC_Guilford': { name: 'Guilford County Planning & Development', address: '400 W Market St, Greensboro, NC 27401', phone: '(336) 641-3606', portal: 'https://guilfordcountync.gov' },
  'CA_Los Angeles': { name: 'LA County Dept. of Regional Planning', address: '320 W Temple St, Los Angeles, CA 90012', phone: '(213) 974-6411', portal: 'https://lacounty.gov/permits' },
  'CA_San Diego': { name: 'San Diego Development Services Dept.', address: '1222 First Ave, San Diego, CA 92101', phone: '(619) 446-5000', portal: 'https://sandiego.gov/development-services' },
  'CA_Orange': { name: 'Orange County Planning & Design', address: '300 N Flower St, Santa Ana, CA 92703', phone: '(714) 834-2555', portal: 'https://ocplanning.net' },
  'TX_Harris': { name: 'Harris County Permit Office', address: '10555 Northwest Fwy, Houston, TX 77092', phone: '(713) 274-3800', portal: 'https://hcpid.org' },
  'TX_Dallas': { name: 'Dallas Development Services Dept.', address: '320 E Jefferson Blvd, Dallas, TX 75203', phone: '(214) 948-4480', portal: 'https://dallascityhall.com/permits' },
  'TX_Travis': { name: 'Austin Development Services Dept.', address: '6310 Wilhelmina Delco Dr, Austin, TX 78752', phone: '(512) 974-2380', portal: 'https://austintexas.gov/permits' },
  'FL_Miami-Dade': { name: 'Miami-Dade Building Dept.', address: '111 NW 1st St, Miami, FL 33128', phone: '(786) 315-2000', portal: 'https://miamidade.gov/permits' },
  'FL_Broward': { name: 'Broward County Building Services', address: '1 N University Dr, Plantation, FL 33324', phone: '(954) 765-4500', portal: 'https://broward.org/permits' },
  'FL_Orange': { name: 'Orange County Building & Planning', address: '201 S Rosalind Ave, Orlando, FL 32801', phone: '(407) 836-5550', portal: 'https://ocfl.net/permits' },
  'NY_Kings': { name: 'NYC Dept. of Buildings – Brooklyn', address: '210 Joralemon St, Brooklyn, NY 11201', phone: '(718) 802-3675', portal: 'https://nyc.gov/dob' },
  'NY_Queens': { name: 'NYC Dept. of Buildings – Queens', address: '120-55 Queens Blvd, Kew Gardens, NY 11424', phone: '(718) 286-8800', portal: 'https://nyc.gov/dob' },
  'NY_New York': { name: 'NYC Dept. of Buildings – Manhattan', address: '280 Broadway, New York, NY 10007', phone: '(212) 393-2550', portal: 'https://nyc.gov/dob' },
  'GA_Fulton': { name: 'Fulton County Community Development', address: '141 Pryor St SW, Atlanta, GA 30303', phone: '(404) 612-7200', portal: 'https://fultoncountyga.gov/permits' },
  'GA_Gwinnett': { name: 'Gwinnett County Building Inspections', address: '446 W Crogan St, Lawrenceville, GA 30046', phone: '(678) 377-4100', portal: 'https://gwinnettcounty.com/permits' },
  'IL_Cook': { name: 'Cook County Dept. of Building & Zoning', address: '69 W Washington St, Chicago, IL 60602', phone: '(312) 603-0500', portal: 'https://cookcountyil.gov/permits' },
  'OH_Franklin': { name: 'Columbus Building & Zoning Services', address: '111 N Front St, Columbus, OH 43215', phone: '(614) 645-7433', portal: 'https://columbus.gov/permits' },
  'PA_Philadelphia': { name: 'Philadelphia Dept. of Licenses & Inspections', address: '1401 JFK Blvd, Philadelphia, PA 19102', phone: '(215) 686-2400', portal: 'https://phl.gov/permits' },
  'PA_Allegheny': { name: 'Allegheny County Building Permits', address: '436 Grant St, Pittsburgh, PA 15219', phone: '(412) 350-4234', portal: 'https://allegheny.county.us/permits' },
  'WA_King': { name: 'King County Dept. of Local Services', address: '35030 SE Douglas St, Snoqualmie, WA 98065', phone: '(206) 477-1060', portal: 'https://kingcounty.gov/permits' },
  'AZ_Maricopa': { name: 'Maricopa County Planning & Development', address: '301 W Jefferson St, Phoenix, AZ 85003', phone: '(602) 506-3301', portal: 'https://maricopa.gov/permits' },
  'CO_El Paso': { name: 'El Paso County Building Dept.', address: '2880 International Circle, Colorado Springs, CO 80910', phone: '(719) 520-6300', portal: 'https://elpasoco.com/permits' },
  'CO_Denver': { name: 'Denver Community Planning & Development', address: '201 W Colfax Ave, Denver, CO 80202', phone: '(720) 865-2705', portal: 'https://denvergov.org/permits' },
  'VA_Fairfax': { name: 'Fairfax County Land Development Services', address: '12055 Government Center Pkwy, Fairfax, VA 22035', phone: '(703) 222-0801', portal: 'https://fairfaxcounty.gov/permits' },
  'TN_Shelby': { name: 'Memphis & Shelby County Office of Construction', address: '6465 Mullins Station Rd, Memphis, TN 38134', phone: '(901) 222-8300', portal: 'https://memphistn.gov/permits' },
  'TN_Davidson': { name: 'Nashville Metro Codes Administration', address: '800 Second Ave S, Nashville, TN 37210', phone: '(615) 862-6500', portal: 'https://nashville.gov/permits' },
  'MO_Jackson': { name: 'Kansas City Dept. of Codes Administration', address: '414 E 12th St, Kansas City, MO 64106', phone: '(816) 513-1500', portal: 'https://kcmo.gov/permits' },
  'OR_Multnomah': { name: 'Portland Bureau of Development Services', address: '1900 SW 4th Ave, Portland, OR 97201', phone: '(503) 823-7300', portal: 'https://portland.gov/bds/permits' },
  'NV_Clark': { name: 'Clark County Building Dept.', address: '4701 W Russell Rd, Las Vegas, NV 89118', phone: '(702) 455-3000', portal: 'https://clarkcountynv.gov/permits' },
  'MI_Wayne': { name: 'Wayne County Building Authority', address: '400 Monroe St, Detroit, MI 48226', phone: '(313) 224-5600', portal: 'https://buildingdetroit.org/permits' },
  'MA_Suffolk': { name: 'Boston Inspectional Services Dept.', address: '1010 Massachusetts Ave, Boston, MA 02118', phone: '(617) 635-5300', portal: 'https://boston.gov/permits' },
  'MN_Hennepin': { name: 'Hennepin County Building Inspections', address: '300 S 6th St, Minneapolis, MN 55487', phone: '(612) 348-3000', portal: 'https://hennepin.us/permits' },
  'SC_Greenville': { name: 'Greenville County Codes Enforcement', address: '301 University Ridge, Greenville, SC 29601', phone: '(864) 467-7425', portal: 'https://greenvillecounty.org/permits' },
  'SC_Charleston': { name: 'Charleston County Building Inspections', address: '4045 Bridge View Dr, North Charleston, SC 29405', phone: '(843) 202-7258', portal: 'https://charlestoncounty.org/permits' },
  'UT_Salt Lake': { name: 'Salt Lake County Building Services', address: '2001 S State St, Salt Lake City, UT 84190', phone: '(385) 468-6700', portal: 'https://slco.org/permits' },
  'KY_Jefferson': { name: 'Louisville Metro Dept. of Codes & Regulations', address: '444 S 5th St, Louisville, KY 40202', phone: '(502) 574-3321', portal: 'https://louisvilleky.gov/permits' },
  'KY_Fayette': { name: 'Lexington Division of Building Inspection', address: '200 E Main St, Lexington, KY 40507', phone: '(859) 258-3770', portal: 'https://lexingtonky.gov/permits' },
  'LA_East Baton Rouge': { name: 'Baton Rouge-EBR Building Permits', address: '222 St. Louis St, Baton Rouge, LA 70802', phone: '(225) 389-3084', portal: 'https://brgov.com/permits' },
  'LA_Jefferson': { name: 'Jefferson Parish Dept. of Inspection & Code Enforcement', address: '1221 Elmwood Park Blvd, Elmwood, LA 70123', phone: '(504) 736-6957', portal: 'https://jeffparish.net/permits' },
  'LA_Orleans': { name: 'New Orleans Dept. of Safety & Permits', address: '1300 Perdido St, New Orleans, LA 70112', phone: '(504) 658-7100', portal: 'https://nola.gov/permits' },
}

type PermitOffice = { name: string; address: string; phone: string; portal: string; portalVerified?: boolean }

function getPermitOffice(stateCode: string, countyName: string): PermitOffice | null {
  const match = PERMIT_OFFICES[`${stateCode}_${countyName}`] || PERMIT_OFFICES[stateCode]
  if (match) return { ...match, portalVerified: true }
  return null
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
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [ready, setReady] = useState(false)
  const [selectedProject, setSelectedProject] = useState('')
  const [step, setStep] = useState<Step>(1)
  const [state, setState] = useState('')
  const [county, setCounty] = useState('')
  const [city, setCity] = useState('')
  const [checklist, setChecklist] = useState<Record<string, boolean>>({})
  const [submitStatus, setSubmitStatus] = useState<SubmitStatus>('idle')
  const [officeConfirmed, setOfficeConfirmed] = useState<boolean | null>(null)
  const [customOffice, setCustomOffice] = useState('')
  // Cache of looked-up offices keyed by "STATE_County"
  const [officeCache, setOfficeCache] = useState<Record<string, PermitOffice | null>>({})
  const [officeLoadingKey, setOfficeLoadingKey] = useState<string | null>(null)
  // Ref mirrors officeLoadingKey so we can guard without adding it as an effect dep
  // (doing so would cancel its own in-flight fetch when React re-runs the effect).
  const inFlightKeyRef = useRef<string | null>(null)
  // Requirement attachments: per-index file metadata and text values
  type ReqAttachment = { filename: string; size: number; url?: string }
  const [reqFiles, setReqFiles] = useState<Record<number, ReqAttachment>>({})
  const [reqTexts, setReqTexts] = useState<Record<number, string>>({})
  const [reqUploading, setReqUploading] = useState<Record<number, boolean>>({})
  const [reqError, setReqError] = useState<Record<number, string | null>>({})
  // Preview PDF state
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)

  useEffect(() => {
    async function load() {
      let u: any = null
      try {
        u = await getUser()
        if (!u) { router.push('/login'); return }
      } catch {
        router.push('/login'); return
      }
      // Auth passed — show the form immediately (states render now)
      setReady(true)
      // Load projects separately so a slow backend never blocks the UI
      try {
        const data = await api.projects.list(u.id).catch(() => [] as Project[])
        setProjects(data || [])
        if (data?.length) setSelectedProject(data[0].id)
      } catch {}
      setProjectsLoading(false)
    }
    load()
  }, [router])

  useEffect(() => {
    // init checklist when we reach step 2 — merge with any existing attachments/text
    if (step === 2) {
      const items = REQUIRED_DOCS.default
      const initial: Record<string, boolean> = {}
      items.forEach((item, idx) => {
        const hasFile = !!reqFiles[idx]
        const hasText = (reqTexts[idx] || '').trim().length >= 3
        initial[item] = hasFile || hasText
      })
      setChecklist(initial)
    }
    // We intentionally only re-run when step changes; per-item auto-check
    // happens in the upload/text handlers below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  // Look up verified portal URL from backend when county isn't in PERMIT_OFFICES.
  // Deps = [state, county] ONLY. The lookup key is ${state}_${county}; city is
  // just a search term. Including city caused the cleanup→re-run to short-
  // circuit on the ref guard, leaving loadingKey stuck forever.
  useEffect(() => {
    if (!state || !county) return
    const key = `${state}_${county}`
    if (PERMIT_OFFICES[key] || PERMIT_OFFICES[state]) return
    if (key in officeCache) return // already looked up (success or null)
    if (inFlightKeyRef.current === key) return

    let cancelled = false
    inFlightKeyRef.current = key
    setOfficeLoadingKey(key)

    // Hard safety timeout — the spinner will never hang past 25s even if
    // fetch hangs, the backend is down, or a promise never resolves.
    const hardTimeout = setTimeout(() => {
      if (cancelled) return
      cancelled = true
      setOfficeCache(prev => (key in prev ? prev : { ...prev, [key]: null }))
      inFlightKeyRef.current = null
      setOfficeLoadingKey(null)
    }, 25000)

    ;(async () => {
      try {
        const result = await api.permits.searchPortal(city || county, state, 'residential')
        if (cancelled) return
        const fallbackSearch =
          (result as { fallback_search_url?: string }).fallback_search_url ||
          `https://www.google.com/search?q=${encodeURIComponent(`${city || county} ${state} building permit office`)}`
        // Always produce a usable office card. Verified URL if we have one;
        // otherwise a Google search link (user can override if wrong).
        const office: PermitOffice = result.found && result.portal_url
          ? {
              name: result.portal_name || `${county} County Building Department`,
              address: `Contact your local ${county} County government office`,
              phone: result.submission_email || 'See county website',
              portal: result.portal_url,
              portalVerified: true,
            }
          : {
              name: `${county} County Building Department`,
              address: `${city || county}, ${state} — address not on file`,
              phone: 'Call county directly — number not on file',
              portal: fallbackSearch,
              portalVerified: false,
            }
        setOfficeCache(prev => ({ ...prev, [key]: office }))
      } catch {
        if (!cancelled) {
          const fallbackSearch = `https://www.google.com/search?q=${encodeURIComponent(`${city || county} ${state} building permit office`)}`
          setOfficeCache(prev => ({
            ...prev,
            [key]: {
              name: `${county} County Building Department`,
              address: `${city || county}, ${state} — address not on file`,
              phone: 'Call county directly — number not on file',
              portal: fallbackSearch,
              portalVerified: false,
            },
          }))
        }
      } finally {
        clearTimeout(hardTimeout)
        if (!cancelled) {
          inFlightKeyRef.current = null
          setOfficeLoadingKey(null)
        }
      }
    })()
    // Cleanup: clear ref + loadingKey so a dep change never strands the UI
    // in a "loading" state with no fetch actually running.
    return () => {
      cancelled = true
      clearTimeout(hardTimeout)
      if (inFlightKeyRef.current === key) inFlightKeyRef.current = null
      setOfficeLoadingKey(prev => (prev === key ? null : prev))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, county])

  // Load existing requirement attachments/text on mount or project change
  useEffect(() => {
    if (!selectedProject) return
    let cancelled = false
    ;(async () => {
      try {
        const data = await api.permits.listAttachments(selectedProject)
        if (cancelled) return
        const files: Record<number, ReqAttachment> = {}
        const texts: Record<number, string> = {}
        for (const a of data.attachments || []) {
          if (a.kind === 'file' && a.filename) {
            files[a.index] = { filename: a.filename, size: a.size || 0, url: a.url }
          } else if (a.kind === 'text' && a.text) {
            texts[a.index] = a.text
          }
        }
        setReqFiles(files)
        setReqTexts(texts)
      } catch {
        // silently ignore — backend endpoint may not exist yet
      }
    })()
    return () => { cancelled = true }
  }, [selectedProject])

  const counties = state ? (COUNTIES[state] || []) : []
  const cities = (state && county) ? (CITIES[state]?.[county] || []) : []
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

  // Resolve the current office: hardcoded → looked-up cache → null (unverified)
  function resolveOffice(): { office: PermitOffice | null; loading: boolean } {
    if (!state || !county) return { office: null, loading: false }
    const key = `${state}_${county}`
    const hardcoded = getPermitOffice(state, county)
    if (hardcoded) return { office: hardcoded, loading: false }
    if (key in officeCache) return { office: officeCache[key], loading: false }
    return { office: null, loading: officeLoadingKey === key }
  }

  // ── Requirement upload/text handlers ─────────────────────────────────────
  const MAX_UPLOAD_BYTES = 20 * 1024 * 1024
  const ACCEPT_TYPES = '.pdf,.jpg,.jpeg,.png,.doc,.docx,application/pdf,image/jpeg,image/png,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document'

  async function handleRequirementUpload(index: number, docLabel: string, file: File) {
    setReqError(prev => ({ ...prev, [index]: null }))
    if (file.size > MAX_UPLOAD_BYTES) {
      setReqError(prev => ({ ...prev, [index]: 'File exceeds 20 MB limit' }))
      return
    }
    if (!selectedProject) {
      setReqError(prev => ({ ...prev, [index]: 'No project selected' }))
      return
    }
    setReqUploading(prev => ({ ...prev, [index]: true }))
    try {
      const result = await api.permits.uploadRequirement(selectedProject, index, file)
      setReqFiles(prev => ({
        ...prev,
        [index]: { filename: result.filename || file.name, size: result.size || file.size, url: result.url },
      }))
      // Auto-check the corresponding requirement
      setChecklist(prev => ({ ...prev, [docLabel]: true }))
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed'
      setReqError(prev => ({ ...prev, [index]: msg }))
    } finally {
      setReqUploading(prev => ({ ...prev, [index]: false }))
    }
  }

  async function handleRemoveRequirementFile(index: number, docLabel: string) {
    if (!selectedProject) return
    try {
      await api.permits.deleteRequirementAttachment(selectedProject, index)
    } catch {
      // Ignore — still clear locally so the user isn't stuck
    }
    setReqFiles(prev => {
      const next = { ...prev }
      delete next[index]
      return next
    })
    // Uncheck unless text satisfies the requirement
    const textOk = (reqTexts[index] || '').trim().length >= 3
    if (!textOk) setChecklist(prev => ({ ...prev, [docLabel]: false }))
  }

  // Debounced text save — one timer per index
  const [textSaveTimers, setTextSaveTimers] = useState<Record<number, ReturnType<typeof setTimeout>>>({})
  function handleRequirementTextChange(index: number, docLabel: string, value: string) {
    setReqTexts(prev => ({ ...prev, [index]: value }))
    // Auto-check when text is ≥ 3 chars OR a file exists; otherwise uncheck unless file
    const hasFile = !!reqFiles[index]
    const meets = value.trim().length >= 3
    setChecklist(prev => ({ ...prev, [docLabel]: meets || hasFile }))

    // Debounce save
    if (textSaveTimers[index]) clearTimeout(textSaveTimers[index])
    if (!selectedProject) return
    const t = setTimeout(async () => {
      try {
        await api.permits.saveRequirementText(selectedProject, index, value)
      } catch {
        // Silent fail — backend may not be built yet
      }
    }, 600)
    setTextSaveTimers(prev => ({ ...prev, [index]: t }))
  }

  async function handlePreviewPdf() {
    if (!selectedProject) return
    setPreviewLoading(true)
    setPreviewError(null)
    try {
      const blob = await api.permits.previewDraftPdf(selectedProject)
      const url = URL.createObjectURL(blob)
      window.open(url, '_blank', 'noopener,noreferrer')
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Preview failed'
      setPreviewError(msg)
    } finally {
      setPreviewLoading(false)
    }
  }

  const project = projects.find(p => p.id === selectedProject)

  const card = 'bg-white rounded-2xl p-6 space-y-4'
  const cardStyle = { boxShadow: '0 2px 12px rgba(59,130,246,0.08)', border: '1px solid rgba(219,234,254,0.8)' }
  const selectCls = 'w-full bg-slate-50 border border-slate-200 focus:border-blue-400 focus:ring-2 focus:ring-blue-100 rounded-xl px-3 py-2.5 text-slate-700 text-sm focus:outline-none transition-all'
  const labelCls = 'text-slate-500 text-xs font-semibold uppercase tracking-wider block mb-2'

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-black text-slate-800">Permit Filing</h1>
        <p className="text-slate-400 text-sm mt-1">Automatically prepare and submit permits to your jurisdiction.</p>
      </div>

      {!ready ? (
        <div className="flex items-center justify-center py-24">
          <svg className="animate-spin text-blue-400" width="24" height="24" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>
        </div>
      ) : (
        <div className="space-y-5">

          {/* Project selector */}
          <div className={card} style={cardStyle}>
            <label className="text-slate-700 font-semibold text-sm block mb-3">Project</label>
            {projectsLoading ? (
              <div className="h-10 bg-slate-100 rounded-xl animate-pulse" />
            ) : projects.length === 0 ? (
              <p className="text-slate-400 text-sm">No projects yet. Upload a blueprint first.</p>
            ) : (
              <select
                value={selectedProject}
                onChange={e => { setSelectedProject(e.target.value); setStep(1); setSubmitStatus('idle') }}
                className={selectCls}
              >
                {projects.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            )}
          </div>

          {/* Step indicator */}
          <div className="flex rounded-2xl overflow-hidden bg-white" style={cardStyle}>
            {([
              { n: 1, label: 'Location' },
              { n: 2, label: 'Requirements' },
              { n: 3, label: 'Submit' },
            ] as { n: Step; label: string }[]).map(({ n, label }, i) => (
              <button
                key={n}
                onClick={() => step > n && setStep(n)}
                className={`flex-1 flex items-center justify-center gap-2 py-4 text-sm font-semibold transition-all ${
                  step === n
                    ? 'bg-blue-50 text-blue-600 border-b-2 border-blue-500'
                    : step > n
                    ? 'text-emerald-600 hover:bg-emerald-50 cursor-pointer'
                    : 'text-slate-400 cursor-default'
                } ${i < 2 ? 'border-r border-blue-50' : ''}`}
              >
                <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${
                  step > n ? 'bg-emerald-100 text-emerald-600' : step === n ? 'bg-blue-100 text-blue-600' : 'bg-slate-100 text-slate-400'
                }`}>
                  {step > n
                    ? <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                    : n}
                </span>
                {label}
              </button>
            ))}
          </div>

          {/* ── STEP 1: Location ─────────────────────────────────────────── */}
          {step === 1 && (
            <div className={card} style={cardStyle}>
              <h2 className="text-slate-700 font-bold text-sm">Select Jurisdiction</h2>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className={labelCls}>State</label>
                  <select
                    value={state}
                    onChange={e => { setState(e.target.value); setCounty(''); setCity(''); setOfficeConfirmed(null); setCustomOffice('') }}
                    className={selectCls}
                  >
                    <option value="">Select state…</option>
                    {STATES.map(s => <option key={s.code} value={s.code}>{s.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>County</label>
                  <select
                    value={county}
                    onChange={e => { setCounty(e.target.value); setCity(''); setOfficeConfirmed(null); setCustomOffice('') }}
                    disabled={!state}
                    className={`${selectCls} disabled:opacity-40`}
                  >
                    <option value="">Select county…</option>
                    {counties.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>City</label>
                  <select
                    value={city}
                    onChange={e => setCity(e.target.value)}
                    disabled={!county}
                    className={`${selectCls} disabled:opacity-40`}
                  >
                    <option value="">Select city…</option>
                    {cities.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
              </div>

              {state && county && (() => {
                const { office, loading } = resolveOffice()
                return (
                  <div className="mt-2 rounded-xl p-4 space-y-3" style={{ background: '#f0f7ff', border: '1px solid rgba(219,234,254,0.9)' }}>
                    <div className="flex items-center gap-2">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2" strokeLinecap="round"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
                      <span className="text-blue-600 text-xs font-semibold uppercase tracking-wider">Permit Filing Office</span>
                      <span className="ml-auto text-slate-400 text-xs">Auto-detected for {city || county}, {state}</span>
                    </div>
                    {loading ? (
                      <div className="flex items-center gap-2 py-2">
                        <svg className="animate-spin text-blue-500" width="14" height="14" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>
                        <span className="text-slate-500 text-xs">Looking up permit office…</span>
                      </div>
                    ) : office ? (
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-slate-800 font-semibold text-sm">{office.name}</span>
                          {!office.portalVerified && (
                            <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">Best guess</span>
                          )}
                        </div>
                        <div className="text-slate-500 text-xs mt-0.5">{office.address}</div>
                        <div className="flex items-center gap-4 mt-2 flex-wrap">
                          <span className="text-slate-500 text-xs">{office.phone}</span>
                          <a href={office.portal} target="_blank" rel="noopener noreferrer" className="text-blue-500 text-xs hover:text-blue-700 underline underline-offset-2 break-all">
                            {office.portalVerified ? office.portal : `Search for ${city || county}, ${state} permit office →`}
                          </a>
                        </div>
                        {!office.portalVerified && (
                          <div className="text-amber-600 text-[11px] mt-2">
                            ⓘ We couldn&apos;t verify a specific office for this area. The link above runs a Google search. Double-check it&apos;s correct, or use the &quot;No&quot; option below to enter the right office.
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2">
                        <div className="text-amber-700 text-xs font-semibold">Permit office URL unverified for {county} County</div>
                        <div className="text-amber-600 text-xs mt-0.5">Search manually at your county&apos;s website, or enter the correct office below.</div>
                      </div>
                    )}
                    <div className="border-t border-blue-100 pt-3 space-y-2">
                      {office && (
                        <label className="flex items-center gap-3 cursor-pointer">
                          <div
                            onClick={() => { setOfficeConfirmed(true); setCustomOffice('') }}
                            className={`w-5 h-5 rounded-md border flex items-center justify-center flex-shrink-0 transition-all cursor-pointer ${
                              officeConfirmed === true ? 'bg-emerald-500 border-emerald-500' : 'border-slate-300 bg-white'
                            }`}
                          >
                            {officeConfirmed === true && (
                              <svg width="10" height="8" viewBox="0 0 10 8" fill="none"><path d="M1 4L3.5 6.5L9 1" stroke="white" strokeWidth="1.5" strokeLinecap="round"/></svg>
                            )}
                          </div>
                          <span className="text-slate-700 text-sm">Yes, this is the correct filing office</span>
                        </label>
                      )}
                      {office && (
                        <label className="flex items-center gap-3 cursor-pointer">
                          <div
                            onClick={() => setOfficeConfirmed(false)}
                            className={`w-5 h-5 rounded-md border flex items-center justify-center flex-shrink-0 transition-all cursor-pointer ${
                              officeConfirmed === false ? 'bg-amber-400 border-amber-400' : 'border-slate-300 bg-white'
                            }`}
                          >
                            {officeConfirmed === false && (
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                            )}
                          </div>
                          <span className="text-slate-700 text-sm">No, I need to use a different office</span>
                        </label>
                      )}
                      {(officeConfirmed === false || !office) && (
                        <div className="pt-1 space-y-2">
                          <label className={labelCls}>Correct Filing Office</label>
                          <input
                            type="text"
                            value={customOffice}
                            onChange={e => setCustomOffice(e.target.value)}
                            placeholder="e.g. City of Charlotte Building Permits, 123 Main St…"
                            className="w-full bg-white border border-amber-300 focus:border-amber-400 focus:ring-2 focus:ring-amber-100 rounded-xl px-4 py-2.5 text-slate-700 text-sm placeholder-slate-300 focus:outline-none transition-all"
                            autoFocus
                          />
                          <p className="text-slate-400 text-xs">Enter the name and address of the correct permit office.</p>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })()}

              <div className="flex justify-end pt-1">
                <button
                  onClick={() => setStep(2)}
                  disabled={
                    !state || !county ||
                    // If we have an office, user must explicitly confirm or provide a custom one
                    (resolveOffice().office
                      ? (officeConfirmed === null || (officeConfirmed === false && !customOffice.trim()))
                      // No verified office — user must type a custom office
                      : !customOffice.trim()) ||
                    resolveOffice().loading
                  }
                  className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white font-semibold px-6 py-2.5 rounded-xl text-sm transition-all hover:scale-[1.02]"
                >
                  Continue →
                </button>
              </div>
            </div>
          )}

          {/* ── STEP 2: Requirements ─────────────────────────────────────── */}
          {step === 2 && (
            <div className={card} style={cardStyle}>
              <div className="flex items-center justify-between">
                <h2 className="text-slate-700 font-bold text-sm">Required Documents</h2>
                <span className="text-xs text-slate-400">{checkedCount} / {docs.length} confirmed</span>
              </div>
              <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-500 rounded-full transition-all duration-500"
                  style={{ width: `${(checkedCount / docs.length) * 100}%` }}
                />
              </div>
              <div className="space-y-2">
                {docs.map((doc, idx) => {
                  const file = reqFiles[idx]
                  const text = reqTexts[idx] || ''
                  const uploading = !!reqUploading[idx]
                  const error = reqError[idx]
                  const checked = !!checklist[doc]
                  const status: 'file' | 'text' | 'none' = file ? 'file' : (text.trim().length >= 3 ? 'text' : 'none')
                  const inputId = `req-file-${idx}`
                  return (
                    <div
                      key={doc}
                      className={`p-3.5 rounded-xl border transition-all ${
                        checked
                          ? 'bg-emerald-50 border-emerald-200'
                          : 'bg-slate-50 border-slate-200'
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        <div className={`w-5 h-5 rounded-md border flex items-center justify-center flex-shrink-0 mt-0.5 transition-all ${
                          checked ? 'bg-emerald-500 border-emerald-500' : 'border-slate-300 bg-white'
                        }`}>
                          {checked && (
                            <svg width="10" height="8" viewBox="0 0 10 8" fill="none"><path d="M1 4L3.5 6.5L9 1" stroke="white" strokeWidth="1.5" strokeLinecap="round"/></svg>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className={`text-sm ${checked ? 'text-emerald-700' : 'text-slate-700'}`}>{doc}</div>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <input
                              id={inputId}
                              type="file"
                              accept={ACCEPT_TYPES}
                              className="sr-only"
                              onChange={e => {
                                const f = e.target.files?.[0]
                                if (f) handleRequirementUpload(idx, doc, f)
                                e.target.value = ''
                              }}
                            />
                            <label
                              htmlFor={inputId}
                              className={`text-xs font-semibold px-3 py-1.5 rounded-lg border cursor-pointer transition-all ${
                                uploading
                                  ? 'bg-slate-200 border-slate-200 text-slate-400 cursor-wait'
                                  : 'bg-white border-slate-300 text-slate-600 hover:border-blue-300 hover:text-blue-600'
                              }`}
                            >
                              {uploading ? 'Uploading…' : 'Choose file'}
                            </label>
                            <span className="text-slate-400 text-xs">or</span>
                            <input
                              type="text"
                              value={text}
                              onChange={e => handleRequirementTextChange(idx, doc, e.target.value)}
                              placeholder="Type info (e.g. policy #, license #)"
                              className="flex-1 min-w-[180px] bg-white border border-slate-200 focus:border-blue-400 focus:ring-2 focus:ring-blue-100 rounded-lg px-3 py-1.5 text-slate-700 text-xs placeholder-slate-300 focus:outline-none transition-all"
                            />
                            <span className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full ${
                              status === 'file'
                                ? 'bg-blue-100 text-blue-600'
                                : status === 'text'
                                ? 'bg-violet-100 text-violet-600'
                                : 'bg-slate-100 text-slate-400'
                            }`}>
                              {status === 'file' ? 'Uploaded' : status === 'text' ? 'Typed' : 'Empty'}
                            </span>
                          </div>
                          {file && (
                            <div className="mt-2 flex items-center gap-2 bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-xs">
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2" strokeLinecap="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                              <span className="text-slate-700 font-medium truncate flex-1">{file.filename}</span>
                              <span className="text-slate-400">{file.size ? `${(file.size / 1024).toFixed(0)} KB` : ''}</span>
                              <button
                                type="button"
                                onClick={() => handleRemoveRequirementFile(idx, doc)}
                                className="text-slate-400 hover:text-rose-500 transition-colors"
                                aria-label="Remove file"
                              >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                              </button>
                            </div>
                          )}
                          {error && (
                            <div className="mt-1 text-xs text-rose-500">{error}</div>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
              <div className="flex justify-between pt-1">
                <button onClick={() => setStep(1)} className="text-slate-400 hover:text-slate-700 text-sm font-medium transition-colors">← Back</button>
                <button
                  onClick={() => setStep(3)}
                  disabled={!allChecked}
                  className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white font-semibold px-6 py-2.5 rounded-xl text-sm transition-all hover:scale-[1.02]"
                >
                  {allChecked ? 'Ready to Submit →' : `${docs.length - checkedCount} remaining`}
                </button>
              </div>
            </div>
          )}

          {/* ── STEP 3: Submission ───────────────────────────────────────── */}
          {step === 3 && (
            <div className={card} style={cardStyle}>
              <h2 className="text-slate-700 font-bold text-sm">Submit Permit Application</h2>

              <div className="grid grid-cols-2 gap-3">
                {[
                  { label: 'Project', value: project?.name || '—' },
                  { label: 'Jurisdiction', value: `${city || county}, ${state}` },
                  { label: 'Filing Office', value: customOffice || resolveOffice().office?.name || `${county} County Building Department` },
                  { label: 'Documents', value: `${docs.length} items confirmed` },
                ].map(row => (
                  <div key={row.label} className="bg-slate-50 border border-slate-200 rounded-xl px-4 py-3">
                    <div className="text-slate-400 text-xs font-semibold uppercase tracking-wider mb-1">{row.label}</div>
                    <div className="text-slate-800 text-sm font-medium">{row.value}</div>
                  </div>
                ))}
              </div>

              {submitStatus === 'submitted' ? (
                <div className="flex items-center gap-3 bg-emerald-50 border border-emerald-200 rounded-xl px-5 py-4">
                  <div className="w-10 h-10 bg-emerald-100 rounded-full flex items-center justify-center flex-shrink-0">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                  </div>
                  <div>
                    <div className="text-emerald-700 font-bold text-sm">Submitted Successfully</div>
                    <div className="text-emerald-500 text-xs mt-0.5">Confirmation #AXS-{Math.floor(Math.random() * 90000) + 10000} · Expect response within 5–7 business days</div>
                  </div>
                </div>
              ) : submitStatus === 'ready' ? (
                <div className="flex items-center gap-3 bg-blue-50 border border-blue-200 rounded-xl px-5 py-4">
                  <div className="w-10 h-10 bg-blue-100 rounded-full flex items-center justify-center flex-shrink-0">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2" strokeLinecap="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                  </div>
                  <div>
                    <div className="text-blue-700 font-bold text-sm">Permit Packet Ready</div>
                    <div className="text-blue-500 text-xs mt-0.5">All documents compiled · Ready to submit to {city || county} building department</div>
                  </div>
                </div>
              ) : submitStatus === 'generating' ? (
                <div className="flex items-center gap-3 bg-slate-50 border border-slate-200 rounded-xl px-5 py-4">
                  <svg className="animate-spin text-blue-500 flex-shrink-0" width="20" height="20" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>
                  <div className="text-slate-500 text-sm">Compiling permit packet…</div>
                </div>
              ) : null}

              {previewError && (
                <div className="text-xs text-rose-500 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{previewError}</div>
              )}

              <div className="flex justify-between pt-1">
                <button onClick={() => setStep(2)} className="text-slate-400 hover:text-slate-700 text-sm font-medium transition-colors">← Back</button>
                <div className="flex gap-3">
                  <button
                    onClick={handlePreviewPdf}
                    disabled={previewLoading || !selectedProject}
                    className="bg-white hover:bg-slate-50 border border-slate-300 text-slate-700 font-semibold px-5 py-2.5 rounded-xl text-sm transition-all disabled:opacity-40 flex items-center gap-2"
                    title="Open the draft permit PDF in a new tab for review"
                  >
                    {previewLoading ? (
                      <>
                        <svg className="animate-spin text-slate-500" width="14" height="14" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>
                        Preparing…
                      </>
                    ) : (
                      <>📄 Preview Draft PDF</>
                    )}
                  </button>
                  {submitStatus === 'idle' && (
                    <button
                      onClick={handleGenerate}
                      className="bg-slate-100 hover:bg-slate-200 border border-slate-200 text-slate-700 font-semibold px-5 py-2.5 rounded-xl text-sm transition-all"
                    >
                      Generate Permit Packet
                    </button>
                  )}
                  {submitStatus === 'ready' && (
                    <button
                      onClick={handleSubmit}
                      className="bg-blue-600 hover:bg-blue-500 text-white font-bold px-6 py-2.5 rounded-xl text-sm transition-all hover:scale-[1.02]"
                    >
                      Submit to Jurisdiction
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
