'use client'
import React, { useState, useEffect, useRef, useMemo } from 'react'
import { api } from '@/lib/api'
import { useRegisterChatContext } from '@/lib/chat-context'

type Step = 'portal' | 'confirm' | 'requirements' | 'form' | 'review'
type EntryMode = 'checklist' | 'wizard'

const CONFIRM_TTL_MS = 30 * 24 * 60 * 60 * 1000  // skip re-confirmation if confirmed within 30 days

export default function PermitPortalSection({ project, projectId }: { project: any; projectId: string }) {
  const cardStyle = { boxShadow: '0 8px 32px rgba(0,0,0,0.30)', border: '1px solid rgba(255,255,255,0.10)' }

  const [step, setStep] = useState<Step>('portal')
  const [portal, setPortal] = useState<any>(null)
  const [portalLoading, setPortalLoading] = useState(false)
  const [portalError, setPortalError] = useState<string | null>(null)

  // Confirm step
  const [feesTimeline, setFeesTimeline] = useState<{ fees_estimate: string; review_days_estimate: string } | null>(null)
  const [manualFormUrl, setManualFormUrl] = useState('')
  const [showManualOverride, setShowManualOverride] = useState(false)
  const [confirming, setConfirming] = useState(false)

  // Blueprint scan
  const [blueprintScan, setBlueprintScan] = useState<Record<string, string> | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [scanApplied, setScanApplied] = useState(false)

  // Requirements upload
  const [reqNotes, setReqNotes] = useState('')
  const [reqFiles, setReqFiles] = useState<File[]>([])
  const [reqLoading, setReqLoading] = useState(false)
  const [reqError, setReqError] = useState<string | null>(null)
  const [reqSummary, setReqSummary] = useState<string | null>(null)
  const [reqFields, setReqFields] = useState<Record<string, string>>({})

  // Form
  const [formData, setFormData] = useState<any>(null)
  const [formLoading, setFormLoading] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({})

  // Entry mode (checklist vs wizard)
  const [entryMode, setEntryMode] = useState<EntryMode>('checklist')
  const [wizardIdx, setWizardIdx] = useState(0)

  // Voice-to-text
  const [voiceActive, setVoiceActive] = useState<string | null>(null)
  const recognitionRef = useRef<any>(null)
  const voiceSupported = typeof window !== 'undefined' && (
    typeof (window as any).SpeechRecognition !== 'undefined' ||
    typeof (window as any).webkitSpeechRecognition !== 'undefined'
  )

  // Contractor profile
  const [contractorProfile, setContractorProfile] = useState<any>({})
  const [saveProfile, setSaveProfile] = useState(false)
  const [savingProfile, setSavingProfile] = useState(false)
  const [profileSaved, setProfileSaved] = useState(false)

  // PDF download + preflight
  const [generatingPdf, setGeneratingPdf] = useState(false)
  const [downloaded, setDownloaded] = useState(false)
  const [preflightModal, setPreflightModal] = useState<{ open: boolean; missing: Array<{ key: string; label: string; section: string }>; useWebForm: boolean } | null>(null)

  useEffect(() => {
    async function loadProfile() {
      try {
        const { getUser } = await import('@/lib/auth')
        const user = await getUser()
        if (!user) return
        const profile = await api.contractorProfile.get(user.id)
        if (profile && Object.keys(profile).length > 0) {
          setContractorProfile(profile)
          setFieldValues(prev => ({
            ...prev,
            contractor_name: profile.company_name || '',
            license_number: profile.license_number || '',
            contractor_phone: profile.phone || '',
            contractor_email: profile.email || '',
            contractor_address: profile.address || '',
          }))
        }
      } catch {}
    }
    loadProfile()
  }, [])

  async function handleFindPortal() {
    setPortalLoading(true)
    setPortalError(null)
    try {
      const city  = project?.city || ''
      const state = project?.region?.replace('US-', '') || ''
      if (!city) { setPortalError('This project has no city set. Edit the project to add a city.'); setPortalLoading(false); return }
      const result = await api.permits.searchPortal(city, state, project?.blueprint_type || 'residential')
      setPortal(result)
    } catch (err: any) {
      setPortalError(err.message || 'Search failed. Please try again.')
    }
    setPortalLoading(false)
  }

  // Move to confirm step. Fetches fees/timeline in the background.
  async function handleGoToConfirm() {
    setStep('confirm')
    // Kick off fees + timeline lookup (cached on backend)
    if (!feesTimeline) {
      try {
        const city  = project?.city || ''
        const state = project?.region?.replace('US-', '') || ''
        const result = await api.permits.feesTimeline(city, state, project?.blueprint_type || 'residential')
        setFeesTimeline({ fees_estimate: result.fees_estimate, review_days_estimate: result.review_days_estimate })
      } catch {
        // Non-fatal — UI still works without estimates
      }
    }
  }

  async function handleConfirmForm(opts: { useManual?: boolean; manualUrl?: string | null } = {}) {
    setConfirming(true)
    try {
      await api.permits.confirmForm(projectId, {
        formUrl: opts.manualUrl || null,
        useManual: !!opts.useManual,
      })
      // Skip straight to the pre-filled form. The Documents & Notes step is
      // optional — most roofing permits don't need extra uploads — so it's no
      // longer forced; it's reachable from the form via "Add supporting documents".
      await handleFetchForm()
    } catch (err: any) {
      setFormError(err.message || 'Could not save confirmation.')
    }
    setConfirming(false)
  }

  async function handleScanBlueprint() {
    setScanning(true)
    setScanError(null)
    try {
      const result = await api.permits.scanBlueprint(projectId)
      setBlueprintScan(result.fields || {})
    } catch (err: any) {
      // Soft-fail — scan is optional and user can still proceed without it.
      setScanError(err.message || 'Blueprint scan failed — you can still fill the permit manually.')
      setBlueprintScan({})
    }
    setScanning(false)
  }

  async function handleAnalyzeRequirements() {
    setReqLoading(true)
    setReqError(null)
    try {
      const result = await api.permits.analyzeRequirements(projectId, reqNotes, reqFiles)
      setReqFields(result.fields || {})
      setReqSummary(result.summary || null)
      await handleFetchForm(result.fields || {})
    } catch (err: any) {
      setReqError(err.message || 'Failed to analyze requirements. Please try again.')
      setReqLoading(false)
    }
  }

  async function handleFetchForm(requirementsFields: Record<string, string> = reqFields) {
    setFormLoading(true)
    setFormError(null)
    try {
      const data = await api.permits.fetchForm(projectId, requirementsFields, blueprintScan || {})
      setFormData(data)
      const vals: Record<string, string> = { ...fieldValues }
      for (const f of data.fields) {
        if (f.value && !vals[f.key]) vals[f.key] = f.value
      }
      for (const [k, v] of Object.entries(requirementsFields)) {
        if (v) vals[k] = v
      }
      // Fold blueprint scan values in if not already set
      if (blueprintScan) {
        for (const [k, v] of Object.entries(blueprintScan)) {
          if (v && !vals[k]) vals[k] = v
        }
      }
      setFieldValues(vals)
      setScanApplied(true)
      setStep('form')
    } catch (err: any) {
      setFormError(err.message || 'Failed to fetch permit form. Please try again.')
    }
    setFormLoading(false)
    setReqLoading(false)
  }

  async function handleSaveProfile() {
    setSavingProfile(true)
    try {
      const { getUser } = await import('@/lib/auth')
      const user = await getUser()
      if (!user) return
      await api.contractorProfile.save(user.id, {
        company_name:   fieldValues.contractor_name    || '',
        license_number: fieldValues.license_number     || '',
        phone:          fieldValues.contractor_phone   || '',
        email:          fieldValues.contractor_email   || '',
        address:        fieldValues.contractor_address || '',
      })
      setProfileSaved(true)
    } catch {}
    setSavingProfile(false)
  }

  // Voice-to-text via the Web Speech API. Falls back silently on browsers
  // that don't support it (Firefox, older Safari).
  function startVoiceInput(fieldKey: string) {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SR) return
    const rec = new SR()
    rec.lang = 'en-US'
    rec.interimResults = false
    rec.continuous = false
    rec.onresult = (e: any) => {
      const transcript = Array.from(e.results)
        .map((r: any) => r[0].transcript)
        .join(' ')
        .trim()
      setFieldValues(prev => {
        const existing = prev[fieldKey] || ''
        return { ...prev, [fieldKey]: existing ? `${existing} ${transcript}` : transcript }
      })
    }
    rec.onend = () => setVoiceActive(null)
    rec.onerror = () => setVoiceActive(null)
    recognitionRef.current = rec
    setVoiceActive(fieldKey)
    rec.start()
  }

  function stopVoiceInput() {
    try { recognitionRef.current?.stop() } catch {}
    setVoiceActive(null)
  }

  // Pre-flight check before download. Surfaces a confirmation modal if any
  // required fields are blank rather than letting the contractor submit a
  // packet that'll bounce back from the city.
  async function handleDownloadClick(useWebForm: boolean) {
    const fields = (formData?.fields || []).map((f: any) => ({
      ...f, value: fieldValues[f.key] || f.value || '',
    }))
    try {
      const result = await api.permits.preflight(fields)
      if (!result.ok) {
        setPreflightModal({ open: true, missing: result.missing_required, useWebForm })
        return
      }
    } catch {
      // If preflight fails, fall through and let user download anyway
    }
    await actuallyDownloadPdf(useWebForm, fields)
  }

  async function actuallyDownloadPdf(useWebForm: boolean, fields: any[]) {
    setGeneratingPdf(true)
    try {
      const { getCachedSession } = await import('@/lib/supabase')
      const session = await getCachedSession()
      const token = session?.access_token
      const API_BASE = (process.env.NEXT_PUBLIC_API_URL || 'https://build-backend-jcp9.onrender.com').trim()

      const res = await fetch(`${API_BASE}/api/v1/permits/generate-pdf/${projectId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ fields, form_url: formData?.form_url || null, use_web_form: useWebForm }),
      })

      if (!res.ok) throw new Error('PDF generation failed')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `permit_application_${project?.name?.replace(/\s+/g, '_') || 'application'}.pdf`
      a.click()
      URL.revokeObjectURL(url)
      setDownloaded(true)
      setStep('review')
    } catch (err: any) {
      setFormError(err.message || 'PDF generation failed.')
    }
    setGeneratingPdf(false)
  }

  // Group fields by section
  const fieldsBySection: Record<string, any[]> = {}
  if (formData?.fields) {
    for (const f of formData.fields) {
      const sec = f.section || 'General'
      if (!fieldsBySection[sec]) fieldsBySection[sec] = []
      fieldsBySection[sec].push(f)
    }
  }

  // Missing required fields — used by both checklist banner and wizard mode.
  const missingFields = useMemo(() => {
    if (!formData?.fields) return []
    return formData.fields.filter((f: any) =>
      f.required && f.field_type !== 'signature' && !(fieldValues[f.key] || '').trim()
    )
  }, [formData, fieldValues])

  const filledCount = useMemo(() => {
    if (!formData?.fields) return 0
    return formData.fields.filter((f: any) => (fieldValues[f.key] || '').trim()).length
  }, [formData, fieldValues])

  // Publish current permit state to AxisChat so the user can ask questions
  // about specific fields, what they mean, and what's still missing.
  useRegisterChatContext('permit', {
    step,
    project: { city: project?.city, state: project?.region?.replace('US-', ''), type: project?.blueprint_type },
    portal: portal ? { name: portal.portal_name, url: portal.portal_url, found: !!portal.portal_url } : null,
    feesTimeline,
    blueprintScan,
    formFound: !!formData?.form_url,
    fieldSource: formData?.field_source,
    jurisdiction: formData?.jurisdiction
      ? { name: formData.jurisdiction.authority_name, submission_method: formData.jurisdiction.submission_method }
      : null,
    fieldsTotal: formData?.fields?.length || 0,
    fieldsFilled: filledCount,
    missingRequired: missingFields.map((f: any) => ({ label: f.label, section: f.section })),
    sections: formData?.fields
      ? Array.from(new Set(formData.fields.map((f: any) => f.section || 'General')))
      : [],
  })

  const sectionIcons: Record<string, string> = {
    'Property Information': '',
    'Owner Information': '',
    'Contractor Information': '',
    'Project Details': '',
    'Signatures': '',
    'General': '',
  }

  // Color-code autofilled values by source confidence.
  function confidenceBadge(field: any, hasValue: boolean) {
    if (!hasValue) return null
    if (field.status === 'auto_filled' || field.confidence) {
      const c = field.confidence || 'medium'
      if (c === 'high') return (
        <span className="text-[10px] font-semibold bg-emerald-500/10 text-emerald-700 border border-emerald-200 rounded-full px-1.5 py-0.5" title="From your saved profile — high confidence">From profile</span>
      )
      if (c === 'medium') return (
        <span className="text-[10px] font-semibold bg-amber-500/10 text-amber-700 border border-amber-200 rounded-full px-1.5 py-0.5" title="Inferred from your blueprint or uploaded docs — verify">AI inferred · verify</span>
      )
      return (
        <span className="text-[10px] font-semibold bg-white/[0.06] text-slate-300 border border-white/10 rounded-full px-1.5 py-0.5" title="Generic default — verify">Default · verify</span>
      )
    }
    return null
  }

  // Render a single field row (used by both checklist + wizard modes)
  function renderField(f: any, opts: { fullWidth?: boolean } = {}) {
    const hasValue = !!(fieldValues[f.key] && fieldValues[f.key].trim())
    const isLongText = f.key === 'project_description' || f.key === 'legal_description'
    const fullWidth = opts.fullWidth ?? isLongText
    const isContractorField = ['contractor_name','license_number','contractor_phone','contractor_email','contractor_address'].includes(f.key)
    const hasProfileValue = isContractorField && contractorProfile?.company_name
    const showVoice = voiceSupported && f.field_type === 'text' && (f.key === 'project_description' || f.key === 'legal_description')

    return (
      <div key={f.key} className={fullWidth ? 'col-span-2' : ''}>
        <div className="flex items-center gap-1.5 flex-wrap mb-1.5">
          <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
            {f.label}{f.required ? <span className="text-red-400 ml-0.5">*</span> : ''}
          </span>
          {confidenceBadge(f, hasValue)}
          {f.status === 'needs_input' && !hasValue && (
            <span className="text-[10px] font-semibold bg-amber-500/10 text-amber-600 border border-amber-200 rounded-full px-1.5 py-0.5">Required</span>
          )}
          {hasProfileValue && !hasValue && (
            <span className="text-[10px] text-blue-500 font-normal">from saved profile</span>
          )}
        </div>
        {f.field_type === 'signature' ? (
          <div className="border-b-2 border-white/15 h-8 flex items-end pb-1">
            <input type="text" placeholder="Type full name as signature"
              value={fieldValues[f.key] || ''}
              onChange={e => setFieldValues(p => ({...p, [f.key]: e.target.value}))}
              className="w-full text-sm italic text-slate-200 focus:outline-none bg-transparent placeholder-slate-500"
            />
          </div>
        ) : (
          <div className="relative">
            <input
              type={f.field_type === 'date' ? 'date' : 'text'}
              value={fieldValues[f.key] || ''}
              onChange={e => setFieldValues(p => ({...p, [f.key]: e.target.value}))}
              className="w-full bg-white/[0.06] border border-white/12 rounded-xl px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-500/20 transition-all"
              style={showVoice ? { paddingRight: '34px' } : undefined}
              placeholder={f.required ? 'Required' : 'Optional'}
              autoFocus={entryMode === 'wizard'}
            />
            {showVoice && (
              <button
                type="button"
                onClick={() => voiceActive === f.key ? stopVoiceInput() : startVoiceInput(f.key)}
                className={`absolute right-1.5 top-1/2 -translate-y-1/2 w-7 h-7 rounded-lg flex items-center justify-center transition-all ${
                  voiceActive === f.key ? 'bg-rose-500 text-white animate-pulse' : 'bg-white/[0.06] text-slate-500 hover:bg-blue-100 hover:text-blue-600'
                }`}
                title={voiceActive === f.key ? 'Stop' : 'Speak to fill'}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Honest framing: Axis prepares a review-ready DRAFT, it does not file for
          you. Permit rules vary by jurisdiction and a wrong filing is the
          contractor's liability — so this stays unmistakably a "verify first". */}
      <div className="flex items-start gap-3 rounded-2xl border border-amber-400/30 bg-amber-500/10 px-4 py-3">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2" strokeLinecap="round" className="mt-0.5 flex-shrink-0"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>
        <div className="text-xs leading-relaxed text-amber-200/90">
          <strong className="text-amber-100">This is a prepared draft, not a filed permit.</strong> Axis finds the
          likely jurisdiction and pre-fills what it knows — <strong>verify every field</strong>, confirm which
          permits your local authority actually requires, and review the form before you submit. Fields marked
          <span className="mx-1 rounded-full border border-amber-300/40 px-1.5 py-px text-[10px]">verify</span>
          are inferred and need a look.
        </div>
      </div>

      {/* Progress steps */}
      <div className="flex items-center gap-2 bg-white/[0.04] rounded-2xl px-5 py-4" style={cardStyle}>
        {[
          { key: 'portal',       label: 'Find Portal' },
          { key: 'confirm',      label: 'Confirm' },
          { key: 'form',         label: 'Fill Permit' },
          { key: 'review',       label: 'Download' },
        ].map((s, i, arr) => {
          const steps = ['portal', 'confirm', 'form', 'review']
          const currentIdx = steps.indexOf(step)
          const thisIdx    = steps.indexOf(s.key)
          const isActive   = step === s.key
          const isDone     = thisIdx < currentIdx
          return (
            <React.Fragment key={s.key}>
              <div className="flex items-center gap-1.5 min-w-0">
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0 ${
                  isDone ? 'bg-emerald-500 text-white' : isActive ? 'bg-blue-600 text-white' : 'bg-white/[0.06] text-slate-400'
                }`}>
                  {isDone ? '' : i + 1}
                </div>
                <span className={`text-xs font-semibold truncate ${isActive ? 'text-blue-600' : isDone ? 'text-emerald-600' : 'text-slate-400'}`}>
                  {s.label}
                </span>
              </div>
              {i < arr.length - 1 && <div className="flex-1 h-px bg-white/10 min-w-[8px]" />}
            </React.Fragment>
          )
        })}
      </div>

      {/* Step 1: Find Portal */}
      {step === 'portal' && (
        <>
          <div className="bg-white/[0.04] rounded-2xl p-5" style={cardStyle}>
            <h3 className="text-white font-bold text-sm mb-3">Project Location</h3>
            <div className="space-y-1">
              {[
                { label: 'City', value: project?.city || '—' },
                { label: 'State', value: project?.region?.replace('US-', '') || '—' },
                { label: 'Project Type', value: project?.blueprint_type || 'residential' },
              ].map(row => (
                <div key={row.label} className="flex justify-between py-2 border-b last:border-0" style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
                  <span className="text-slate-400 text-sm">{row.label}</span>
                  <span className="text-white text-sm font-semibold capitalize">{row.value}</span>
                </div>
              ))}
            </div>
          </div>

          {!portal ? (
            <div className="bg-white/[0.04] rounded-2xl p-10 text-center" style={cardStyle}>
              <div className="w-16 h-16 bg-blue-500/10 border border-blue-100 rounded-2xl flex items-center justify-center mx-auto mb-5">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="1.5" strokeLinecap="round"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 12l2 2 4-4"/></svg>
              </div>
              <div className="text-white font-bold text-lg mb-2">Find Your Permit Portal</div>
              <div className="text-slate-400 text-sm mb-6 leading-relaxed">
                We'll search for the official {project?.city ? `${project.city}` : 'city'} building permit portal and fetch the exact application form.
              </div>
              <button onClick={handleFindPortal} disabled={portalLoading}
                className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-bold px-6 py-3 rounded-xl text-sm transition-all disabled:opacity-50">
                {portalLoading ? <><svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>Searching .gov sources…</> : 'Find Permit Portal →'}
              </button>
              {portalError && (
                <div className="mt-4 bg-rose-500/10 border border-red-200 rounded-xl px-4 py-3 text-red-600 text-sm">{portalError}</div>
              )}
            </div>
          ) : (
            <div className="bg-white/[0.04] rounded-2xl p-6 space-y-4" style={cardStyle}>
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${portal.portal_url ? 'bg-emerald-500/10 border border-emerald-100' : 'bg-amber-500/10 border border-amber-100'}`}>
                  {portal.portal_url
                    ? <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2" strokeLinecap="round"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg>
                    : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                  }
                </div>
                <div>
                  <div className="text-white font-bold text-sm">{portal.portal_name || (portal.portal_url ? 'Permit Portal Found' : 'Permit Portal Not Found')}</div>
                  <div className="text-slate-400 text-xs">{project?.city}, {project?.region?.replace('US-', '')}</div>
                </div>
              </div>

              {!portal.portal_url && (
                <div className="bg-amber-500/10 border border-amber-200 rounded-xl p-4">
                  <div className="text-xs font-bold text-amber-700 uppercase tracking-wider mb-1">Not Found</div>
                  <p className="text-amber-800 text-sm">No verified .gov permit portal found for this jurisdiction. You can still continue and paste the correct URL on the next step.</p>
                </div>
              )}
              {portal.instructions && (
                <div className="bg-blue-500/10 border border-blue-100 rounded-xl p-4">
                  <div className="text-[10px] font-bold text-blue-600 uppercase tracking-wider mb-1">Portal Instructions</div>
                  <p className="text-slate-200 text-sm leading-relaxed">{portal.instructions}</p>
                </div>
              )}
              <div className="flex items-center gap-3 pt-1">
                {portal.portal_url && (
                  <a href={portal.portal_url} target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 bg-white/[0.06] hover:bg-white/10 text-slate-200 font-semibold px-4 py-2 rounded-xl text-sm transition-all">
                    View Portal
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                  </a>
                )}
                <button onClick={handleGoToConfirm}
                  className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-bold px-5 py-2 rounded-xl text-sm transition-all">
                  Continue →
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Step 2: Confirm — is this the right form? + show fees + escape hatch */}
      {step === 'confirm' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-white font-bold text-sm">Confirm Your Permit</h3>
              <p className="text-slate-400 text-xs mt-0.5">Verify the form we found is the right one for your project before we autofill it.</p>
            </div>
            <button onClick={() => setStep('portal')} className="text-slate-400 text-xs hover:text-slate-300">← Back</button>
          </div>

          {/* Permit summary card */}
          <div className="bg-white/[0.04] rounded-2xl p-5 space-y-3" style={cardStyle}>
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 bg-blue-500/10 border border-blue-100 rounded-xl flex items-center justify-center flex-shrink-0">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="1.75" strokeLinecap="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-white font-bold text-sm">{portal?.portal_name || `${project?.city} Building Department`}</div>
                <div className="text-slate-400 text-xs mt-0.5 capitalize">{project?.blueprint_type || 'residential'} permit · {project?.city}, {project?.region?.replace('US-', '')}</div>
                {portal?.portal_url && (
                  <a href={portal.portal_url} target="_blank" rel="noopener noreferrer" className="text-blue-500 text-xs mt-1 hover:underline truncate block">{portal.portal_url}</a>
                )}
              </div>
            </div>
          </div>

          {/* Fees + timeline */}
          {feesTimeline && (feesTimeline.fees_estimate || feesTimeline.review_days_estimate) && (
            <div className="bg-white/[0.04] rounded-2xl p-5 grid grid-cols-2 gap-4" style={cardStyle}>
              <div>
                <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Estimated Fees</div>
                <div className="text-white font-bold text-lg">{feesTimeline.fees_estimate || '—'}</div>
              </div>
              <div>
                <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Review Timeline</div>
                <div className="text-white font-bold text-lg">{feesTimeline.review_days_estimate || '—'}</div>
              </div>
              <div className="col-span-2 text-[10px] text-slate-400 italic">AI estimate — confirm exact fees with the building department</div>
            </div>
          )}

          {/* Wrong-form escape hatch */}
          {!showManualOverride ? (
            <button
              onClick={() => setShowManualOverride(true)}
              className="w-full text-slate-500 text-xs py-2 hover:text-slate-200 underline"
            >
              This isn't the right permit form →
            </button>
          ) : (
            <div className="bg-white/[0.04] rounded-2xl p-5 space-y-3" style={cardStyle}>
              <div>
                <div className="text-white font-bold text-sm mb-1">Use a different permit form</div>
                <p className="text-slate-400 text-xs mb-2">Paste the URL of the correct permit form (PDF or web page).</p>
                <input
                  type="url"
                  value={manualFormUrl}
                  onChange={e => setManualFormUrl(e.target.value)}
                  placeholder="https://example.gov/permits/application.pdf"
                  className="w-full bg-white/[0.06] border border-white/12 rounded-xl px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-400"
                />
              </div>
              <div className="flex gap-2">
                <button onClick={() => { setShowManualOverride(false); setManualFormUrl('') }} className="text-xs text-slate-400 hover:text-slate-300 px-3 py-2">Cancel</button>
                <button
                  onClick={() => handleConfirmForm({ useManual: true, manualUrl: manualFormUrl || null })}
                  disabled={!manualFormUrl.trim() || confirming}
                  className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm py-2 rounded-xl disabled:opacity-50"
                >
                  {confirming ? 'Saving…' : 'Use this form →'}
                </button>
              </div>
            </div>
          )}

          {/* Confirm button */}
          {!showManualOverride && (
            <button
              onClick={() => handleConfirmForm()}
              disabled={confirming}
              className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-3.5 rounded-xl text-sm transition-all disabled:opacity-50"
            >
              {confirming ? (
                <span className="inline-flex items-center gap-2">
                  <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>
                  Confirming & scanning blueprint…
                </span>
              ) : 'Yes, this is the right permit →'}
            </button>
          )}
        </div>
      )}

      {/* Step 3: Requirements (with optional blueprint scan preview) */}
      {step === 'requirements' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-white font-bold text-sm">Add Documents & Notes</h3>
              <p className="text-slate-400 text-xs mt-0.5">AI extracts data from these to autofill the permit. Optional — skip if you've got everything in your profile.</p>
            </div>
            <button onClick={() => setStep('confirm')} className="text-slate-400 text-xs hover:text-slate-300 transition-colors flex-shrink-0 ml-4">← Back</button>
          </div>

          {/* Blueprint scan preview */}
          {(scanning || blueprintScan !== null) && (
            <div className="bg-white/[0.04] rounded-2xl p-5" style={cardStyle}>
              <div className="flex items-center gap-2 mb-3">
                <div className="w-8 h-8 bg-indigo-50 border border-indigo-100 rounded-lg flex items-center justify-center flex-shrink-0">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="2" strokeLinecap="round"><path d="M3 3h18v18H3z"/><path d="M3 9h18M9 21V9"/></svg>
                </div>
                <div>
                  <div className="text-white font-bold text-sm">From Your Blueprint</div>
                  <div className="text-slate-400 text-[11px]">AI scan — verify before applying</div>
                </div>
              </div>
              {scanning && (
                <div className="flex items-center gap-2 text-indigo-600 text-sm">
                  <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>
                  Reading your blueprint…
                </div>
              )}
              {scanError && !scanning && (
                <div className="text-amber-700 text-xs">{scanError}</div>
              )}
              {!scanning && blueprintScan && Object.keys(blueprintScan).length > 0 && (
                <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                  {Object.entries(blueprintScan).map(([k, v]) => (
                    <div key={k} className="flex justify-between border-b border-white/10 py-1.5">
                      <span className="text-slate-400 text-xs capitalize">{k.replace(/_/g, ' ')}</span>
                      <span className="text-white text-xs font-semibold">{v}</span>
                    </div>
                  ))}
                </div>
              )}
              {!scanning && blueprintScan && Object.keys(blueprintScan).length === 0 && (
                <div className="text-slate-400 text-xs italic">No data extracted — you can fill in manually.</div>
              )}
            </div>
          )}

          {/* Text notes */}
          <div className="bg-white/[0.04] rounded-2xl p-5" style={cardStyle}>
            <label className="text-slate-200 font-semibold text-sm block mb-1.5">
              Notes <span className="text-slate-400 font-normal">(type any relevant info)</span>
            </label>
            <textarea
              value={reqNotes}
              onChange={e => setReqNotes(e.target.value)}
              disabled={reqLoading}
              placeholder={`Owner: John Smith, 123 Main St, Charlotte NC 28202, 704-555-1234\nAPN: 123-456-789 · 2,400 sq ft · Est. cost $280,000`}
              rows={3}
              className="w-full text-sm rounded-xl px-3.5 py-2.5 border text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-400 resize-none disabled:opacity-50"
              style={{ borderColor: 'rgba(255,255,255,0.10)', background: '#f8faff' }}
            />
          </div>

          {/* File upload */}
          <div className="bg-white/[0.04] rounded-2xl p-5" style={cardStyle}>
            <label className="text-slate-200 font-semibold text-sm block mb-1.5">
              Upload Documents <span className="text-slate-400 font-normal">(PDF, image, screenshot — optional)</span>
            </label>
            <label
              className={`flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-xl py-6 px-4 transition-all ${reqLoading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:border-indigo-400 hover:bg-indigo-50/30'}`}
              style={{ borderColor: 'rgba(99,102,241,0.3)', background: '#f8faff' }}
            >
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="1.5" strokeLinecap="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              <div className="text-center">
                <div className="text-slate-200 font-semibold text-sm">Click to upload or drag & drop</div>
                <div className="text-slate-400 text-xs">Property records, survey maps, deed, prior permits, photos</div>
              </div>
              <input
                type="file"
                multiple
                disabled={reqLoading}
                accept=".pdf,.png,.jpg,.jpeg,.webp,image/*,application/pdf"
                className="hidden"
                onChange={e => {
                  const newFiles = Array.from(e.target.files || [])
                  setReqFiles(prev => {
                    const existing = new Set(prev.map(f => f.name + f.size))
                    return [...prev, ...newFiles.filter(f => !existing.has(f.name + f.size))]
                  })
                  e.target.value = ''
                }}
              />
            </label>

            {reqFiles.length > 0 && (
              <div className="mt-3 space-y-2">
                {reqFiles.map((file, i) => (
                  <div key={i} className="flex items-center justify-between bg-white/[0.05] rounded-xl px-3 py-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="min-w-0">
                        <div className="text-slate-200 text-xs font-semibold truncate">{file.name}</div>
                        <div className="text-slate-400 text-[10px]">{(file.size / 1024).toFixed(0)} KB</div>
                      </div>
                    </div>
                    <button
                      disabled={reqLoading}
                      onClick={() => setReqFiles(prev => prev.filter((_, j) => j !== i))}
                      className="text-slate-300 hover:text-red-400 transition-colors flex-shrink-0 ml-2 disabled:opacity-30"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {reqError && (
            <div className="bg-rose-500/10 border border-red-200 rounded-xl px-4 py-3 text-red-600 text-sm flex items-start gap-2">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="flex-shrink-0 mt-0.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              {reqError}
            </div>
          )}

          {(reqLoading || formLoading) && (
            <div className="bg-indigo-50 border border-indigo-100 rounded-xl px-4 py-4 flex items-center gap-3">
              <svg className="animate-spin text-indigo-500 flex-shrink-0" width="18" height="18" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>
              <div>
                <div className="text-indigo-700 font-semibold text-sm">Reading your documents…</div>
                <div className="text-indigo-500 text-xs mt-0.5">Extracting info and fetching the official permit form. This takes 20–40 seconds.</div>
              </div>
            </div>
          )}

          <div className="flex flex-col gap-2">
            {/* When user has added notes/files, primary CTA is "Analyze & Fill".
                When nothing's added, primary CTA becomes "Continue without
                documents" so they're never stuck waiting on uploads. */}
            {(reqFiles.length > 0 || reqNotes.trim()) ? (
              <>
                <button
                  onClick={handleAnalyzeRequirements}
                  disabled={reqLoading || formLoading}
                  className="w-full text-white font-bold py-3.5 rounded-xl text-sm transition-all disabled:opacity-40"
                  style={{ background: (reqLoading || formLoading) ? '#94a3b8' : 'linear-gradient(135deg, #6366f1, #4f46e5)', boxShadow: '0 4px 14px rgba(99,102,241,0.3)' }}
                >
                  {reqLoading || formLoading ? 'Processing…' : 'Analyze & Fill Permit →'}
                </button>
                <button
                  onClick={() => handleFetchForm({})}
                  disabled={reqLoading || formLoading}
                  className="w-full text-slate-400 text-sm py-2 hover:text-slate-300 transition-colors disabled:opacity-40"
                >
                  Skip analysis — continue with project + blueprint data only →
                </button>
              </>
            ) : (
              <button
                onClick={() => handleFetchForm({})}
                disabled={reqLoading || formLoading}
                className="w-full text-white font-bold py-3.5 rounded-xl text-sm transition-all disabled:opacity-40"
                style={{ background: (reqLoading || formLoading) ? '#94a3b8' : 'linear-gradient(135deg, #2563eb, #1d4ed8)', boxShadow: '0 4px 14px rgba(37,99,235,0.3)' }}
              >
                {reqLoading || formLoading ? 'Processing…' : 'Continue without documents →'}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Step 4: Fill form (loading skeleton) */}
      {step === 'form' && !formData && (
        <div className="space-y-4">
          {[1,2,3].map(i => (
            <div key={i} className="bg-white/[0.04] rounded-2xl p-5 animate-pulse" style={cardStyle}>
              <div className="h-4 w-32 bg-white/10 rounded mb-4" />
              <div className="grid grid-cols-2 gap-4">
                {[1,2,3,4].map(j => (
                  <div key={j}><div className="h-3 w-24 bg-white/[0.06] rounded mb-2"/><div className="h-9 bg-white/[0.06] rounded-xl"/></div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Step 4: Fill Form */}
      {step === 'form' && formData && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-white font-bold">Permit Application</h3>
              <p className="text-slate-400 text-xs mt-0.5">
                {formData.form_url ? 'Fields extracted from the official form · ' : 'Standard form · '}
                {filledCount} of {formData.fields?.length || 0} fields filled
              </p>
            </div>
            <div className="flex items-center gap-3">
              <button onClick={() => setStep('requirements')} className="text-blue-300 text-xs hover:text-blue-200 transition-colors" title="Only if this permit requires supporting documents">＋ Add supporting documents</button>
              <button onClick={() => setStep('confirm')} className="text-slate-400 text-sm hover:text-slate-300 transition-colors">← Back</button>
            </div>
          </div>

          {/* Field source banner — tells the contractor whether they're filling
              the official jurisdiction form or our generic fallback */}
          {formData.field_source === 'official_form' ? (
            <div className="bg-emerald-500/10 border border-emerald-200 rounded-2xl p-3 flex items-start gap-2.5">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2" strokeLinecap="round" className="flex-shrink-0 mt-0.5"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg>
              <div className="flex-1">
                <div className="text-emerald-800 font-bold text-xs">Official {project?.city} permit fields</div>
                <p className="text-emerald-700 text-xs mt-0.5">These fields match the city's actual permit form. Fill them all and you have a complete application.</p>
              </div>
            </div>
          ) : (
            <div className="bg-amber-500/10 border border-amber-200 rounded-2xl p-3 flex items-start gap-2.5">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2" strokeLinecap="round" className="flex-shrink-0 mt-0.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              <div className="flex-1">
                <div className="text-amber-800 font-bold text-xs">Standard permit fields — verify with your city</div>
                <p className="text-amber-700 text-xs mt-0.5">We couldn't locate the official {project?.city} permit form, so this covers what most US building departments ask for. Some jurisdictions want extras (lot setbacks, plumbing fixtures, etc.) — confirm with the building department before submitting.</p>
              </div>
            </div>
          )}

          {/* Jurisdiction card */}
          {formData.jurisdiction && (
            formData.jurisdiction.found ? (
              <div className="bg-white/[0.04] rounded-2xl p-4 flex items-start gap-3" style={cardStyle}>
                <div className="w-9 h-9 bg-emerald-500/10 border border-emerald-100 rounded-xl flex items-center justify-center flex-shrink-0 mt-0.5">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2" strokeLinecap="round"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-white font-bold text-sm">{formData.jurisdiction.authority_name}</span>
                    {formData.jurisdiction.submission_method && formData.jurisdiction.submission_method !== 'unknown' && (
                      <span className="text-[10px] font-semibold rounded-full px-2 py-0.5 capitalize bg-blue-500/10 text-blue-600 border border-blue-100">{formData.jurisdiction.submission_method.replace('_', ' ')}</span>
                    )}
                  </div>
                  {formData.jurisdiction.gov_url && (
                    <a href={formData.jurisdiction.gov_url} target="_blank" rel="noopener noreferrer" className="text-blue-500 text-xs mt-0.5 hover:underline truncate block">{formData.jurisdiction.gov_url}</a>
                  )}
                </div>
              </div>
            ) : null
          )}

          {/* Missing fields checklist with mode toggle */}
          {missingFields.length > 0 && (
            <div className="bg-amber-500/10 border border-amber-200 rounded-2xl p-4">
              <div className="flex items-center justify-between gap-3 mb-2">
                <div className="flex items-center gap-2">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2" strokeLinecap="round" className="flex-shrink-0"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                  <span className="text-amber-800 font-bold text-sm">{missingFields.length} required field{missingFields.length > 1 ? 's' : ''} still need input</span>
                </div>
                <button
                  onClick={() => { setEntryMode('wizard'); setWizardIdx(0) }}
                  className="text-xs font-semibold bg-amber-600 hover:bg-amber-700 text-white px-3 py-1.5 rounded-lg whitespace-nowrap"
                >
                  Walk me through it →
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5 mt-2">
                {missingFields.map((f: any) => (
                  <button
                    key={f.key}
                    onClick={() => {
                      const el = document.getElementById(`field-${f.key}`)
                      if (el) {
                        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
                        const input = el.querySelector('input, textarea') as HTMLElement | null
                        input?.focus()
                      }
                    }}
                    className="text-[11px] font-semibold bg-white/[0.04] border border-amber-300 hover:border-amber-500 text-amber-800 rounded-full px-2.5 py-1 transition-colors"
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Wizard mode overlay — one field at a time */}
          {entryMode === 'wizard' && missingFields.length > 0 && (
            (() => {
              const idx = Math.min(wizardIdx, missingFields.length - 1)
              const f = missingFields[idx]
              return (
                <div className="bg-white/[0.04] rounded-2xl p-6" style={cardStyle}>
                  <div className="flex items-center justify-between mb-3">
                    <div className="text-[10px] font-bold text-blue-600 uppercase tracking-wider">Step {idx + 1} of {missingFields.length}</div>
                    <button onClick={() => setEntryMode('checklist')} className="text-xs text-slate-400 hover:text-slate-300">Switch to checklist</button>
                  </div>
                  <div className="text-white font-bold text-lg mb-1">{f.label}</div>
                  <div className="text-slate-400 text-xs mb-4">Section: {f.section}</div>
                  <div id={`field-${f.key}`}>
                    {renderField(f, { fullWidth: true })}
                  </div>
                  <div className="flex items-center justify-between mt-5">
                    <button
                      disabled={idx === 0}
                      onClick={() => setWizardIdx(i => Math.max(0, i - 1))}
                      className="text-sm text-slate-500 hover:text-slate-200 disabled:opacity-40"
                    >
                      ← Previous
                    </button>
                    <div className="flex gap-2">
                      <button
                        onClick={() => {
                          if (idx >= missingFields.length - 1) setEntryMode('checklist')
                          else setWizardIdx(i => i + 1)
                        }}
                        className="text-sm text-slate-500 hover:text-slate-200"
                      >
                        Skip
                      </button>
                      <button
                        onClick={() => {
                          if (idx >= missingFields.length - 1) setEntryMode('checklist')
                          else setWizardIdx(i => i + 1)
                        }}
                        className="bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm px-5 py-2 rounded-xl"
                      >
                        {idx >= missingFields.length - 1 ? 'Done →' : 'Next →'}
                      </button>
                    </div>
                  </div>
                </div>
              )
            })()
          )}

          {/* Checklist mode — full form grouped by section */}
          {entryMode === 'checklist' && Object.entries(fieldsBySection).map(([section, sFields]) => (
            <div key={section} className="bg-white/[0.04] rounded-2xl overflow-hidden" style={cardStyle}>
              <div className="px-5 py-4 border-b flex items-center gap-2" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
                <span className="text-white font-bold text-sm">{section}</span>
              </div>
              <div className="p-5 grid grid-cols-2 gap-x-5 gap-y-4">
                {(sFields as any[]).map((f: any) => (
                  <div key={f.key} id={`field-${f.key}`} className={f.key === 'project_description' || f.key === 'legal_description' ? 'col-span-2' : ''}>
                    {renderField(f)}
                  </div>
                ))}

                {section === 'Contractor Information' && (
                  <div className="col-span-2 mt-2 flex items-center gap-3 bg-blue-500/10 rounded-xl px-4 py-3">
                    <input
                      type="checkbox" id="save-profile" checked={saveProfile}
                      onChange={e => setSaveProfile(e.target.checked)}
                      className="w-4 h-4 rounded accent-blue-600"
                    />
                    <label htmlFor="save-profile" className="text-sm text-slate-200 cursor-pointer flex-1">
                      Save contractor info to my profile — auto-fill on future permit applications
                    </label>
                    {saveProfile && !profileSaved && (
                      <button onClick={handleSaveProfile} disabled={savingProfile}
                        className="text-xs bg-blue-600 hover:bg-blue-700 text-white font-semibold px-3 py-1.5 rounded-lg transition-all disabled:opacity-50">
                        {savingProfile ? 'Saving…' : 'Save Now'}
                      </button>
                    )}
                    {profileSaved && <span className="text-xs text-emerald-600 font-semibold">Saved</span>}
                  </div>
                )}
              </div>
            </div>
          ))}

          <button
            onClick={() => setStep('review')}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3.5 rounded-xl text-sm transition-all"
          >
            Review & Download →
          </button>
        </div>
      )}

      {/* Step 5: Review & Download */}
      {step === 'review' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-white font-bold">Ready to Download</h3>
            <button onClick={() => setStep('form')} className="text-slate-400 text-sm hover:text-slate-300 transition-colors">← Edit</button>
          </div>

          {/* Summary */}
          <div className="bg-white/[0.04] rounded-2xl p-5" style={cardStyle}>
            <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Application Summary</div>
            <div className="space-y-1">
              {(Array.isArray(formData?.fields) ? formData.fields : []).filter((f: any) => fieldValues[f.key]).slice(0, 8).map((f: any) => (
                <div key={f.key} className="flex justify-between py-2 border-b last:border-0" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
                  <span className="text-slate-400 text-sm">{f.label}</span>
                  <span className="text-white text-sm font-semibold truncate max-w-[55%] text-right">{fieldValues[f.key]}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Download options */}
          <div className="bg-white/[0.04] rounded-2xl p-6" style={cardStyle}>
            <div className="text-white font-bold text-sm mb-4">Download Options</div>
            <div className="grid grid-cols-2 gap-4">
              <button
                onClick={() => handleDownloadClick(false)}
                disabled={generatingPdf}
                className="flex flex-col items-center gap-3 p-5 border-2 border-blue-200 hover:border-blue-400 rounded-2xl transition-all hover:bg-blue-500/10 disabled:opacity-50"
              >
                <div className="w-12 h-12 bg-blue-100 rounded-xl flex items-center justify-center">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="1.75" strokeLinecap="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                </div>
                <div className="text-center">
                  <div className="text-white font-bold text-sm">Official Form PDF</div>
                  <div className="text-slate-400 text-xs mt-0.5">Values overlaid on the city's actual form</div>
                </div>
              </button>
              <button
                onClick={() => handleDownloadClick(true)}
                disabled={generatingPdf}
                className="flex flex-col items-center gap-3 p-5 border-2 border-white/10 hover:border-slate-400 rounded-2xl transition-all hover:bg-white/[0.05] disabled:opacity-50"
              >
                <div className="w-12 h-12 bg-white/[0.06] rounded-xl flex items-center justify-center">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth="1.75" strokeLinecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>
                </div>
                <div className="text-center">
                  <div className="text-white font-bold text-sm">Clean Form PDF</div>
                  <div className="text-slate-400 text-xs mt-0.5">Professional formatted version to print</div>
                </div>
              </button>
            </div>
            {generatingPdf && (
              <div className="flex items-center justify-center gap-2 mt-4 text-slate-500 text-sm">
                <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>
                Generating PDF…
              </div>
            )}
          </div>

          {downloaded && (
            <div className="bg-emerald-500/10 border border-emerald-200 rounded-2xl p-4 flex items-center gap-3">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2" strokeLinecap="round"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg>
              <span className="text-emerald-800 font-semibold text-sm">Form downloaded — complete submission using the instructions below.</span>
            </div>
          )}

          {/* Submission method-aware instructions */}
          {(() => {
            const method = formData?.jurisdiction?.submission_method || 'unknown'
            const portalUrl = formData?.jurisdiction?.gov_url || portal?.portal_url
            const email = formData?.jurisdiction?.submission_email
            if (method === 'web_form' && portalUrl) return (
              <div className="bg-blue-500/10 border border-blue-200 rounded-2xl p-5">
                <div className="text-xs font-bold text-blue-700 uppercase tracking-wider mb-2">Submit Online</div>
                <p className="text-blue-800 text-sm leading-relaxed mb-3">This jurisdiction accepts online permit applications. Log in to the permit portal and upload your completed form.</p>
                <a href={portalUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-bold px-5 py-2.5 rounded-xl text-sm transition-all">
                  Open Permit Portal <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                </a>
              </div>
            )
            if (method === 'email') return (
              <div className="bg-purple-500/10 border border-purple-200 rounded-2xl p-5">
                <div className="text-xs font-bold text-purple-700 uppercase tracking-wider mb-2">Submit by Email</div>
                <p className="text-purple-800 text-sm leading-relaxed mb-3">Email your completed permit application PDF to the building department{email ? ` at ${email}` : ''}.</p>
                {email && (
                  <a href={`mailto:${email}`} className="inline-flex items-center gap-2 bg-purple-600 hover:bg-purple-700 text-white font-bold px-5 py-2.5 rounded-xl text-sm transition-all">Email Application</a>
                )}
              </div>
            )
            if (portalUrl) return (
              <div className="bg-amber-500/10 border border-amber-200 rounded-2xl p-5">
                <div className="text-xs font-bold text-amber-700 uppercase tracking-wider mb-2">Next Step: Submit Your Application</div>
                <p className="text-amber-800 text-sm leading-relaxed mb-3">Download your completed form above, then submit it through the official {project?.city} permit portal. Manual action required — this system never submits on your behalf.</p>
                <a href={portalUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 bg-amber-600 hover:bg-amber-700 text-white font-bold px-5 py-2.5 rounded-xl text-sm transition-all">
                  Open Permit Portal <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                </a>
              </div>
            )
            return null
          })()}
        </div>
      )}

      {/* Pre-flight modal */}
      {preflightModal?.open && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setPreflightModal(null)}>
          <div className="bg-white/[0.04] rounded-2xl p-6 max-w-md w-full" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 bg-amber-500/10 border border-amber-200 rounded-xl flex items-center justify-center flex-shrink-0">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              </div>
              <div>
                <div className="text-white font-bold text-base">Hold on — incomplete permit</div>
                <div className="text-slate-400 text-xs">Submitting now will likely get bounced back</div>
              </div>
            </div>
            <p className="text-slate-200 text-sm mb-3">
              <span className="font-bold">{preflightModal.missing.length} required field{preflightModal.missing.length > 1 ? 's are' : ' is'} still empty:</span>
            </p>
            <div className="bg-white/[0.05] rounded-xl p-3 max-h-48 overflow-y-auto mb-4">
              <ul className="space-y-1">
                {preflightModal.missing.map(m => (
                  <li key={m.key} className="text-slate-200 text-sm flex items-start gap-2">
                    <span className="text-amber-500 mt-0.5">•</span>
                    <span><span className="font-semibold">{m.label}</span> <span className="text-slate-400 text-xs">({m.section})</span></span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  const useWebForm = preflightModal.useWebForm
                  setPreflightModal(null)
                  setStep('form')
                  // After step transition, focus the first missing field
                  setTimeout(() => {
                    const first = preflightModal.missing[0]
                    if (first) {
                      const el = document.getElementById(`field-${first.key}`)
                      if (el) {
                        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
                        const input = el.querySelector('input, textarea') as HTMLElement | null
                        input?.focus()
                      }
                    }
                    void useWebForm  // (referenced so TS doesn't drop the var; download retried by user)
                  }, 100)
                }}
                className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm py-2.5 rounded-xl"
              >
                Fix missing fields
              </button>
              <button
                onClick={async () => {
                  const fields = (formData?.fields || []).map((f: any) => ({
                    ...f, value: fieldValues[f.key] || f.value || '',
                  }))
                  const useWebForm = preflightModal.useWebForm
                  setPreflightModal(null)
                  await actuallyDownloadPdf(useWebForm, fields)
                }}
                className="flex-1 bg-white/[0.06] hover:bg-white/10 text-slate-200 font-semibold text-sm py-2.5 rounded-xl"
              >
                Download anyway
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
