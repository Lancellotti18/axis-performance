'use client'
import React, { useState, useEffect } from 'react'
import { api } from '@/lib/api'

export default function PermitPortalSection({ project, projectId }: { project: any; projectId: string }) {
  const cardStyle = { boxShadow: '0 2px 12px rgba(59,130,246,0.08)', border: '1px solid rgba(219,234,254,0.8)' }

  // Step state: 'portal' | 'requirements' | 'form' | 'review'
  const [step, setStep] = useState<'portal' | 'requirements' | 'form' | 'review'>('portal')
  const [portal, setPortal] = useState<any>(null)
  const [portalLoading, setPortalLoading] = useState(false)
  const [portalError, setPortalError] = useState<string | null>(null)

  // Requirements upload state
  const [reqNotes, setReqNotes] = useState('')
  const [reqFiles, setReqFiles] = useState<File[]>([])
  const [reqLoading, setReqLoading] = useState(false)
  const [reqError, setReqError] = useState<string | null>(null)
  const [reqSummary, setReqSummary] = useState<string | null>(null)
  const [reqFields, setReqFields] = useState<Record<string, string>>({})

  // Form state
  const [formData, setFormData] = useState<any>(null)   // { form_url, fields, city, state, jurisdiction }
  const [formLoading, setFormLoading] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({})

  // Contractor profile
  const [contractorProfile, setContractorProfile] = useState<any>({})
  const [saveProfile, setSaveProfile] = useState(false)
  const [savingProfile, setSavingProfile] = useState(false)
  const [profileSaved, setProfileSaved] = useState(false)

  // PDF generation
  const [generatingPdf, setGeneratingPdf] = useState(false)
  const [downloaded, setDownloaded] = useState(false)

  // Load contractor profile on mount
  useEffect(() => {
    async function loadProfile() {
      try {
        const { getUser } = await import('@/lib/auth')
        const user = await getUser()
        if (!user) return
        const profile = await api.contractorProfile.get(user.id)
        if (profile && Object.keys(profile).length > 0) {
          setContractorProfile(profile)
          // Pre-fill contractor fields immediately
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

  async function handleAnalyzeRequirements() {
    setReqLoading(true)
    setReqError(null)
    try {
      const result = await api.permits.analyzeRequirements(projectId, reqNotes, reqFiles)
      setReqFields(result.fields || {})
      setReqSummary(result.summary || null)
      // Proceed directly to fetching + filling the form
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
      const data = await api.permits.fetchForm(projectId, requirementsFields)
      setFormData(data)
      // Merge: requirements fields > auto-filled from project > blank
      const vals: Record<string, string> = { ...fieldValues }
      for (const f of data.fields) {
        if (f.value && !vals[f.key]) vals[f.key] = f.value
      }
      // Requirements fields take highest priority
      for (const [k, v] of Object.entries(requirementsFields)) {
        if (v) vals[k] = v
      }
      setFieldValues(vals)
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

  async function handleDownloadPdf(useWebForm: boolean) {
    setGeneratingPdf(true)
    try {
      // Build field list with current values
      const fields = (formData?.fields || []).map((f: any) => ({
        ...f,
        value: fieldValues[f.key] || f.value || '',
      }))

      // Use raw fetch since response is binary PDF
      const { supabase } = await import('@/lib/supabase')
      const { data: { session } } = await supabase.auth.getSession()
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

  const sectionIcons: Record<string, string> = {
    'Property Information': '',
    'Owner Information': '',
    'Contractor Information': '',
    'Project Details': '',
    'Signatures': '',
    'General': '',
  }

  return (
    <div className="space-y-4">
      {/* Progress steps */}
      <div className="flex items-center gap-2 bg-white rounded-2xl px-5 py-4" style={cardStyle}>
        {[
          { key: 'portal',       label: 'Find Portal' },
          { key: 'requirements', label: 'Requirements' },
          { key: 'form',         label: 'Fill Permit' },
          { key: 'review',       label: 'Download' },
        ].map((s, i) => {
          const steps = ['portal', 'requirements', 'form', 'review']
          const currentIdx = steps.indexOf(step)
          const thisIdx    = steps.indexOf(s.key)
          const isActive   = step === s.key
          const isDone     = thisIdx < currentIdx
          return (
            <React.Fragment key={s.key}>
              <div className="flex items-center gap-1.5 min-w-0">
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0 ${
                  isDone ? 'bg-emerald-500 text-white' : isActive ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-400'
                }`}>
                  {isDone ? '' : i + 1}
                </div>
                <span className={`text-xs font-semibold truncate ${isActive ? 'text-blue-600' : isDone ? 'text-emerald-600' : 'text-slate-400'}`}>
                  {s.label}
                </span>
              </div>
              {i < 3 && <div className="flex-1 h-px bg-slate-200 min-w-[8px]" />}
            </React.Fragment>
          )
        })}
      </div>

      {/* Step 1: Find Portal */}
      {step === 'portal' && (
        <>
          {/* Project location */}
          <div className="bg-white rounded-2xl p-5" style={cardStyle}>
            <h3 className="text-slate-800 font-bold text-sm mb-3">Project Location</h3>
            <div className="space-y-1">
              {[
                { label: 'City', value: project?.city || '—' },
                { label: 'State', value: project?.region?.replace('US-', '') || '—' },
                { label: 'Project Type', value: project?.blueprint_type || 'residential' },
              ].map(row => (
                <div key={row.label} className="flex justify-between py-2 border-b last:border-0" style={{ borderColor: 'rgba(219,234,254,0.6)' }}>
                  <span className="text-slate-400 text-sm">{row.label}</span>
                  <span className="text-slate-800 text-sm font-semibold capitalize">{row.value}</span>
                </div>
              ))}
            </div>
          </div>

          {!portal ? (
            <div className="bg-white rounded-2xl p-10 text-center" style={cardStyle}>
              <div className="w-16 h-16 bg-blue-50 border border-blue-100 rounded-2xl flex items-center justify-center mx-auto mb-5">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="1.5" strokeLinecap="round"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 12l2 2 4-4"/></svg>
              </div>
              <div className="text-slate-800 font-bold text-lg mb-2">Find Your Permit Portal</div>
              <div className="text-slate-400 text-sm mb-6 leading-relaxed">
                We'll search for the official {project?.city ? `${project.city}` : 'city'} building permit portal and fetch the exact application form.
              </div>
              <button onClick={handleFindPortal} disabled={portalLoading}
                className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-bold px-6 py-3 rounded-xl text-sm transition-all disabled:opacity-50">
                {portalLoading ? <><svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>Searching .gov sources…</> : 'Find Permit Portal →'}
              </button>
              {portalError && (
                <div className="mt-4 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-red-600 text-sm">{portalError}</div>
              )}
            </div>
          ) : (
            <div className="bg-white rounded-2xl p-6 space-y-4" style={cardStyle}>
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${portal.portal_url ? 'bg-emerald-50 border border-emerald-100' : 'bg-amber-50 border border-amber-100'}`}>
                  {portal.portal_url
                    ? <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2" strokeLinecap="round"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg>
                    : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                  }
                </div>
                <div>
                  <div className="text-slate-800 font-bold text-sm">{portal.portal_name || (portal.portal_url ? 'Permit Portal Found' : 'Permit Portal Not Found')}</div>
                  <div className="text-slate-400 text-xs">{project?.city}, {project?.region?.replace('US-', '')}</div>
                </div>
              </div>

              {!portal.portal_url && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
                  <div className="text-xs font-bold text-amber-700 uppercase tracking-wider mb-1">Not Found</div>
                  <p className="text-amber-800 text-sm">No verified .gov permit portal found for this jurisdiction. Do not proceed with unverified sources.</p>
                  <a href={`https://www.google.com/search?q=${encodeURIComponent(`${project?.city} ${project?.region?.replace('US-','')} building permit official`)}`}
                    target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 mt-3 text-amber-700 font-semibold text-sm hover:text-amber-900 transition-colors">
                    Search manually →
                  </a>
                </div>
              )}
              {portal.instructions && (
                <div className="bg-blue-50 border border-blue-100 rounded-xl p-4">
                  <div className="text-[10px] font-bold text-blue-600 uppercase tracking-wider mb-1">Portal Instructions</div>
                  <p className="text-slate-700 text-sm leading-relaxed">{portal.instructions}</p>
                </div>
              )}
              {formLoading && (
                <div className="space-y-2 animate-pulse">
                  <div className="h-3 bg-slate-100 rounded-full w-3/4" />
                  <div className="h-3 bg-slate-100 rounded-full w-1/2" />
                  <div className="h-3 bg-slate-100 rounded-full w-2/3" />
                </div>
              )}
              {formError && (
                <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-red-600 text-sm flex items-center justify-between gap-3">
                  <span>{formError}</span>
                  <button onClick={() => handleFetchForm(reqFields)} className="text-red-600 font-bold text-xs underline whitespace-nowrap">Retry</button>
                </div>
              )}
              <div className="flex items-center gap-3 pt-1">
                {portal.portal_url && (
                  <a href={portal.portal_url} target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold px-4 py-2 rounded-xl text-sm transition-all">
                    View Portal
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                  </a>
                )}
                <button onClick={() => setStep('requirements')}
                  className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-bold px-5 py-2 rounded-xl text-sm transition-all">
                  Upload Requirements →
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Step 2: Requirements Upload */}
      {step === 'requirements' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-slate-800 font-bold text-sm">Upload Your Requirements</h3>
              <p className="text-slate-400 text-xs mt-0.5">Add documents, screenshots, or notes — AI reads them and pre-fills the permit. Or skip to fill manually.</p>
            </div>
            <button onClick={() => setStep('portal')} className="text-slate-400 text-xs hover:text-slate-600 transition-colors flex-shrink-0 ml-4">← Back</button>
          </div>

          {/* Text notes */}
          <div className="bg-white rounded-2xl p-5" style={cardStyle}>
            <label className="text-slate-700 font-semibold text-sm block mb-1.5">
              Notes <span className="text-slate-400 font-normal">(type any relevant info)</span>
            </label>
            <textarea
              value={reqNotes}
              onChange={e => setReqNotes(e.target.value)}
              disabled={reqLoading}
              placeholder={`Owner: John Smith, 123 Main St, Charlotte NC 28202, 704-555-1234\nAPN: 123-456-789 · 2,400 sq ft · Est. cost $280,000`}
              rows={3}
              className="w-full text-sm rounded-xl px-3.5 py-2.5 border text-slate-700 placeholder-slate-300 focus:outline-none focus:border-indigo-400 resize-none disabled:opacity-50"
              style={{ borderColor: 'rgba(219,234,254,0.9)', background: '#f8faff' }}
            />
          </div>

          {/* File upload */}
          <div className="bg-white rounded-2xl p-5" style={cardStyle}>
            <label className="text-slate-700 font-semibold text-sm block mb-1.5">
              Upload Documents <span className="text-slate-400 font-normal">(PDF, image, screenshot — optional)</span>
            </label>
            <label
              className={`flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-xl py-6 px-4 transition-all ${reqLoading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:border-indigo-400 hover:bg-indigo-50/30'}`}
              style={{ borderColor: 'rgba(99,102,241,0.3)', background: '#f8faff' }}
            >
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="1.5" strokeLinecap="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              <div className="text-center">
                <div className="text-slate-700 font-semibold text-sm">Click to upload or drag & drop</div>
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
                  <div key={i} className="flex items-center justify-between bg-slate-50 rounded-xl px-3 py-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-base flex-shrink-0">{file.type.includes('pdf') ? '' : ''}</span>
                      <div className="min-w-0">
                        <div className="text-slate-700 text-xs font-semibold truncate">{file.name}</div>
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
            <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-red-600 text-sm flex items-start gap-2">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="flex-shrink-0 mt-0.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              {reqError}
            </div>
          )}

          {/* Loading state with clear message */}
          {reqLoading && (
            <div className="bg-indigo-50 border border-indigo-100 rounded-xl px-4 py-4 flex items-center gap-3">
              <svg className="animate-spin text-indigo-500 flex-shrink-0" width="18" height="18" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>
              <div>
                <div className="text-indigo-700 font-semibold text-sm">Reading your documents…</div>
                <div className="text-indigo-500 text-xs mt-0.5">Extracting info and fetching the official permit form. This takes 20–40 seconds.</div>
              </div>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <button
              onClick={handleAnalyzeRequirements}
              disabled={reqLoading || formLoading || (reqFiles.length === 0 && !reqNotes.trim())}
              className="w-full text-white font-bold py-3.5 rounded-xl text-sm transition-all disabled:opacity-40"
              style={{ background: (reqLoading || formLoading) ? '#94a3b8' : 'linear-gradient(135deg, #6366f1, #4f46e5)', boxShadow: '0 4px 14px rgba(99,102,241,0.3)' }}
            >
              {reqLoading || formLoading ? 'Processing…' : reqFiles.length > 0 || reqNotes.trim() ? 'Analyze & Fill Permit →' : 'Add notes or files above to analyze'}
            </button>
            <button
              onClick={() => handleFetchForm({})}
              disabled={reqLoading || formLoading}
              className="w-full text-slate-400 text-sm py-2 hover:text-slate-600 transition-colors disabled:opacity-40"
            >
              Skip — fill permit from project data only →
            </button>
          </div>
        </div>
      )}

      {/* Step 3 — Fill form (loading skeleton) */}
      {step === 'form' && !formData && (
        <div className="space-y-4">
          {[1,2,3].map(i => (
            <div key={i} className="bg-white rounded-2xl p-5 animate-pulse" style={cardStyle}>
              <div className="h-4 w-32 bg-slate-200 rounded mb-4" />
              <div className="grid grid-cols-2 gap-4">
                {[1,2,3,4].map(j => (
                  <div key={j}><div className="h-3 w-24 bg-slate-100 rounded mb-2"/><div className="h-9 bg-slate-100 rounded-xl"/></div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Step 2: Fill Form */}
      {step === 'form' && formData && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-slate-800 font-bold">Permit Application</h3>
              <p className="text-slate-400 text-xs mt-0.5">
                {formData.form_url ? 'Fields extracted from the official form · ' : 'Standard form · '}
                Fill in all required fields marked with *
              </p>
            </div>
            <button onClick={() => setStep('requirements')} className="text-slate-400 text-sm hover:text-slate-600 transition-colors">← Back</button>
          </div>

          {/* Jurisdiction card */}
          {formData.jurisdiction && (
            formData.jurisdiction.found ? (
              <div className="bg-white rounded-2xl p-4 flex items-start gap-3" style={cardStyle}>
                <div className="w-9 h-9 bg-emerald-50 border border-emerald-100 rounded-xl flex items-center justify-center flex-shrink-0 mt-0.5">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2" strokeLinecap="round"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-slate-800 font-bold text-sm">{formData.jurisdiction.authority_name}</span>
                    {formData.jurisdiction.authority_type && (
                      <span className="text-[10px] font-semibold bg-blue-50 text-blue-600 border border-blue-100 rounded-full px-2 py-0.5 capitalize">{formData.jurisdiction.authority_type}</span>
                    )}
                    {formData.jurisdiction.submission_method && formData.jurisdiction.submission_method !== 'unknown' && (
                      <span className={`text-[10px] font-semibold rounded-full px-2 py-0.5 capitalize ${
                        formData.jurisdiction.submission_method === 'web_form' ? 'bg-emerald-50 text-emerald-600 border border-emerald-100' :
                        formData.jurisdiction.submission_method === 'email' ? 'bg-purple-50 text-purple-600 border border-purple-100' :
                        'bg-amber-50 text-amber-600 border border-amber-100'
                      }`}>{formData.jurisdiction.submission_method.replace('_', ' ')}</span>
                    )}
                  </div>
                  {formData.jurisdiction.gov_url && (
                    <a href={formData.jurisdiction.gov_url} target="_blank" rel="noopener noreferrer" className="text-blue-500 text-xs mt-0.5 hover:underline truncate block">{formData.jurisdiction.gov_url}</a>
                  )}
                </div>
              </div>
            ) : (
              <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 flex items-start gap-3">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2" strokeLinecap="round" className="flex-shrink-0 mt-0.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                <div>
                  <div className="text-amber-800 font-bold text-sm">Permit portal not automatically found</div>
                  <p className="text-amber-700 text-xs mt-0.5">{formData.jurisdiction.error || 'No verified .gov source located.'}</p>
                  {formData.jurisdiction.fallback_search_url && (
                    <a href={formData.jurisdiction.fallback_search_url} target="_blank" rel="noopener noreferrer" className="inline-block mt-1.5 text-xs font-semibold text-amber-700 underline">Search manually →</a>
                  )}
                </div>
              </div>
            )
          )}

          {/* Missing required fields warning */}
          {(() => {
            const missing = (formData.fields || []).filter((f: any) => f.status === 'needs_input' && !fieldValues[f.key])
            if (missing.length === 0) return null
            return (
              <div className="bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3 flex items-start gap-2">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2" strokeLinecap="round" className="flex-shrink-0 mt-0.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                <div>
                  <span className="text-amber-800 font-bold text-xs">{missing.length} required field{missing.length > 1 ? 's' : ''} still need input: </span>
                  <span className="text-amber-700 text-xs">{missing.map((f: any) => f.label).join(', ')}</span>
                </div>
              </div>
            )
          })()}

          {Object.entries(fieldsBySection).map(([section, sFields]) => (
            <div key={section} className="bg-white rounded-2xl overflow-hidden" style={cardStyle}>
              <div className="px-5 py-4 border-b flex items-center gap-2" style={{ borderColor: 'rgba(219,234,254,0.7)' }}>
                <span className="text-base">{sectionIcons[section] || ''}</span>
                <span className="text-slate-800 font-bold text-sm">{section}</span>
              </div>
              <div className="p-5 grid grid-cols-2 gap-x-5 gap-y-4">
                {(sFields as any[]).map((f: any) => {
                  const isContractorField = ['contractor_name','license_number','contractor_phone','contractor_email','contractor_address'].includes(f.key)
                  const hasProfileValue = isContractorField && contractorProfile?.company_name
                  return (
                    <div key={f.key} className={f.key === 'project_description' || f.key === 'legal_description' ? 'col-span-2' : ''}>
                      <div className="flex items-center gap-1.5 flex-wrap mb-1.5">
                        <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                          {f.label}{f.required ? <span className="text-red-400 ml-0.5">*</span> : ''}
                        </span>
                        {f.status === 'auto_filled' && fieldValues[f.key] && (
                          <span className="text-[10px] font-semibold bg-emerald-50 text-emerald-600 border border-emerald-200 rounded-full px-1.5 py-0.5">Auto-filled</span>
                        )}
                        {f.status === 'needs_input' && !fieldValues[f.key] && (
                          <span className="text-[10px] font-semibold bg-amber-50 text-amber-600 border border-amber-200 rounded-full px-1.5 py-0.5">Required</span>
                        )}
                        {hasProfileValue && !fieldValues[f.key] && (
                          <span className="text-[10px] text-blue-500 font-normal">from saved profile</span>
                        )}
                      </div>
                      {f.field_type === 'signature' ? (
                        <div className="border-b-2 border-slate-300 h-8 flex items-end pb-1">
                          <input
                            type="text" placeholder="Type full name as signature"
                            value={fieldValues[f.key] || ''}
                            onChange={e => setFieldValues(p => ({...p, [f.key]: e.target.value}))}
                            className="w-full text-sm italic text-slate-700 focus:outline-none bg-transparent placeholder-slate-300"
                          />
                        </div>
                      ) : (
                        <input
                          type={f.field_type === 'date' ? 'date' : 'text'}
                          value={fieldValues[f.key] || ''}
                          onChange={e => setFieldValues(p => ({...p, [f.key]: e.target.value}))}
                          className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm text-slate-700 focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100 transition-all"
                          placeholder={f.required ? 'Required' : 'Optional'}
                        />
                      )}
                    </div>
                  )
                })}

                {/* Save contractor profile option */}
                {section === 'Contractor Information' && (
                  <div className="col-span-2 mt-2 flex items-center gap-3 bg-blue-50 rounded-xl px-4 py-3">
                    <input
                      type="checkbox" id="save-profile" checked={saveProfile}
                      onChange={e => setSaveProfile(e.target.checked)}
                      className="w-4 h-4 rounded accent-blue-600"
                    />
                    <label htmlFor="save-profile" className="text-sm text-slate-700 cursor-pointer flex-1">
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

      {/* Step 3: Review & Download */}
      {step === 'review' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-slate-800 font-bold">Ready to Download</h3>
            <button onClick={() => setStep('form')} className="text-slate-400 text-sm hover:text-slate-600 transition-colors">← Edit</button>
          </div>

          {/* Summary */}
          <div className="bg-white rounded-2xl p-5" style={cardStyle}>
            <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Application Summary</div>
            <div className="space-y-1">
              {(Array.isArray(formData?.fields) ? formData.fields : []).filter((f: any) => fieldValues[f.key]).slice(0, 8).map((f: any) => (
                <div key={f.key} className="flex justify-between py-2 border-b last:border-0" style={{ borderColor: 'rgba(219,234,254,0.5)' }}>
                  <span className="text-slate-400 text-sm">{f.label}</span>
                  <span className="text-slate-800 text-sm font-semibold truncate max-w-[55%] text-right">{fieldValues[f.key]}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Download options */}
          <div className="bg-white rounded-2xl p-6" style={cardStyle}>
            <div className="text-slate-800 font-bold text-sm mb-4">Download Options</div>
            <div className="grid grid-cols-2 gap-4">
              <button
                onClick={() => handleDownloadPdf(false)}
                disabled={generatingPdf}
                className="flex flex-col items-center gap-3 p-5 border-2 border-blue-200 hover:border-blue-400 rounded-2xl transition-all hover:bg-blue-50 disabled:opacity-50"
              >
                <div className="w-12 h-12 bg-blue-100 rounded-xl flex items-center justify-center">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="1.75" strokeLinecap="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                </div>
                <div className="text-center">
                  <div className="text-slate-800 font-bold text-sm">Official Form PDF</div>
                  <div className="text-slate-400 text-xs mt-0.5">Values overlaid on the city's actual form</div>
                </div>
              </button>
              <button
                onClick={() => handleDownloadPdf(true)}
                disabled={generatingPdf}
                className="flex flex-col items-center gap-3 p-5 border-2 border-slate-200 hover:border-slate-400 rounded-2xl transition-all hover:bg-slate-50 disabled:opacity-50"
              >
                <div className="w-12 h-12 bg-slate-100 rounded-xl flex items-center justify-center">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth="1.75" strokeLinecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>
                </div>
                <div className="text-center">
                  <div className="text-slate-800 font-bold text-sm">Clean Form PDF</div>
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

          {/* Downloaded confirmation */}
          {downloaded && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-4 flex items-center gap-3">
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
              <div className="bg-blue-50 border border-blue-200 rounded-2xl p-5">
                <div className="text-xs font-bold text-blue-700 uppercase tracking-wider mb-2">Submit Online</div>
                <p className="text-blue-800 text-sm leading-relaxed mb-3">This jurisdiction accepts online permit applications. Log in to the permit portal and upload your completed form.</p>
                <a href={portalUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-bold px-5 py-2.5 rounded-xl text-sm transition-all">
                  Open Permit Portal <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                </a>
              </div>
            )
            if (method === 'email') return (
              <div className="bg-purple-50 border border-purple-200 rounded-2xl p-5">
                <div className="text-xs font-bold text-purple-700 uppercase tracking-wider mb-2">Submit by Email</div>
                <p className="text-purple-800 text-sm leading-relaxed mb-3">Email your completed permit application PDF to the building department{email ? ` at ${email}` : ''}.</p>
                {email && (
                  <a href={`mailto:${email}`} className="inline-flex items-center gap-2 bg-purple-600 hover:bg-purple-700 text-white font-bold px-5 py-2.5 rounded-xl text-sm transition-all">Email Application</a>
                )}
              </div>
            )
            if (portalUrl) return (
              <div className="bg-amber-50 border border-amber-200 rounded-2xl p-5">
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
    </div>
  )
}
