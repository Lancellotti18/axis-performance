'use client'
import React from 'react'
import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useRouter, useParams } from 'next/navigation'
import Link from 'next/link'
import { api } from '@/lib/api'
import type { ComplianceCheck, ComplianceItem, ComplianceSeverity } from '@/types'
import Blueprint3DViewer from './Blueprint3DViewer'
import RoofingSection from './RoofingSection'

type Tab = 'overview' | 'materials' | 'cost' | 'view3d' | 'photos' | 'compliance' | 'permits' | 'roofing'
type SortMode = 'lowest_price' | 'best_value'

// Labor split by trade (fractions of total labor cost)
const LABOR_TRADE_SPLIT: Record<string, number> = {
  'Framing & Rough Carpentry': 0.222,
  'Drywall & Painting':        0.167,
  'Electrical':                0.111,
  'Plumbing':                  0.111,
  'Roofing':                   0.067,
  'Flooring':                  0.067,
  'Finishing & Trim':          0.089,
  'Concrete & Foundation':     0.089,
  'Windows & Doors':           0.044,
  'Insulation':                0.033,
}

function formatMoney(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}
function formatMoneyExact(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(n)
}

const CATEGORY_META: Record<string, { label: string; icon: string; color: string }> = {
  lumber:        { label: 'Lumber & Framing',      icon: '🪵', color: 'bg-amber-50 text-amber-700 border-amber-200' },
  sheathing:     { label: 'Sheathing & Subfloor',  icon: '📐', color: 'bg-yellow-50 text-yellow-700 border-yellow-200' },
  drywall:       { label: 'Drywall',               icon: '🧱', color: 'bg-gray-50 text-gray-700 border-gray-200' },
  insulation:    { label: 'Insulation',            icon: '🌡️', color: 'bg-orange-50 text-orange-700 border-orange-200' },
  roofing:       { label: 'Roofing',               icon: '🏠', color: 'bg-red-50 text-red-700 border-red-200' },
  concrete:      { label: 'Concrete & Foundation', icon: '⚙️', color: 'bg-slate-50 text-slate-700 border-slate-200' },
  flooring:      { label: 'Flooring',              icon: '🪟', color: 'bg-teal-50 text-teal-700 border-teal-200' },
  doors_windows: { label: 'Doors & Windows',       icon: '🚪', color: 'bg-cyan-50 text-cyan-700 border-cyan-200' },
  electrical:    { label: 'Electrical',            icon: '⚡', color: 'bg-yellow-50 text-yellow-800 border-yellow-300' },
  plumbing:      { label: 'Plumbing',              icon: '🔧', color: 'bg-blue-50 text-blue-700 border-blue-200' },
  finishing:     { label: 'Finishing Materials',   icon: '🎨', color: 'bg-purple-50 text-purple-700 border-purple-200' },
}

const SEVERITY: Record<ComplianceSeverity, { badge: string; dot: string; label: string }> = {
  required:    { badge: 'bg-red-50 text-red-600 border border-red-200',       dot: 'bg-red-500',    label: 'Required' },
  recommended: { badge: 'bg-yellow-50 text-yellow-600 border border-yellow-200', dot: 'bg-yellow-500', label: 'Recommended' },
  info:        { badge: 'bg-blue-50 text-blue-600 border border-blue-200',    dot: 'bg-blue-500',   label: 'Info' },
}
const RISK_BANNER: Record<string, string> = {
  low:    'bg-emerald-50 border-emerald-200 text-emerald-700',
  medium: 'bg-amber-50 border-amber-200 text-amber-700',
  high:   'bg-red-50 border-red-200 text-red-700',
}

function PermitPortalSection({ project, projectId }: { project: any; projectId: string }) {
  const cardStyle = { boxShadow: '0 2px 12px rgba(59,130,246,0.08)', border: '1px solid rgba(219,234,254,0.8)' }

  // Step state: 'portal' | 'form' | 'review'
  const [step, setStep] = useState<'portal' | 'form' | 'review'>('portal')
  const [portal, setPortal] = useState<any>(null)
  const [portalLoading, setPortalLoading] = useState(false)
  const [portalError, setPortalError] = useState<string | null>(null)

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

  async function handleFetchForm() {
    setFormLoading(true)
    setFormError(null)
    try {
      const data = await api.permits.fetchForm(projectId)
      setFormData(data)
      // Merge auto-filled values
      const vals: Record<string, string> = { ...fieldValues }
      for (const f of data.fields) {
        if (f.value && !vals[f.key]) vals[f.key] = f.value
      }
      setFieldValues(vals)
      setStep('form')
    } catch (err: any) {
      setFormError(err.message || 'Failed to fetch permit form. Please try again.')
    }
    setFormLoading(false)
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
      const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

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
    'Property Information': '🏠',
    'Owner Information': '👤',
    'Contractor Information': '🔨',
    'Project Details': '📐',
    'Signatures': '✍️',
    'General': '📋',
  }

  return (
    <div className="space-y-4">
      {/* Progress steps */}
      <div className="flex items-center gap-3 bg-white rounded-2xl px-5 py-4" style={cardStyle}>
        {[
          { key: 'portal', label: 'Find Portal' },
          { key: 'form',   label: 'Fill Application' },
          { key: 'review', label: 'Download & Submit' },
        ].map((s, i) => {
          const isActive = step === s.key
          const isDone = (step === 'form' && s.key === 'portal') || (step === 'review' && s.key !== 'review')
          return (
            <React.Fragment key={s.key}>
              <div className="flex items-center gap-2">
                <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${
                  isDone ? 'bg-emerald-500 text-white' : isActive ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-400'
                }`}>
                  {isDone ? '✓' : i + 1}
                </div>
                <span className={`text-sm font-semibold ${isActive ? 'text-blue-600' : isDone ? 'text-emerald-600' : 'text-slate-400'}`}>
                  {s.label}
                </span>
              </div>
              {i < 2 && <div className="flex-1 h-px bg-slate-200" />}
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
                  <button onClick={handleFetchForm} className="text-red-600 font-bold text-xs underline whitespace-nowrap">Retry</button>
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
                <button onClick={handleFetchForm} disabled={formLoading}
                  className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-bold px-5 py-2 rounded-xl text-sm transition-all disabled:opacity-50">
                  {formLoading ? <><svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>Analyzing Form…</> : 'Prepare Application →'}
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Step 2 — Fill form (loading skeleton) */}
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
            <button onClick={() => setStep('portal')} className="text-slate-400 text-sm hover:text-slate-600 transition-colors">← Back</button>
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
                <span className="text-base">{sectionIcons[section] || '📋'}</span>
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
                          <span className="text-[10px] font-semibold bg-emerald-50 text-emerald-600 border border-emerald-200 rounded-full px-1.5 py-0.5">✓ Auto-filled</span>
                        )}
                        {f.status === 'needs_input' && !fieldValues[f.key] && (
                          <span className="text-[10px] font-semibold bg-amber-50 text-amber-600 border border-amber-200 rounded-full px-1.5 py-0.5">⚠ Required</span>
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
                    {profileSaved && <span className="text-xs text-emerald-600 font-semibold">✓ Saved</span>}
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
              {(formData?.fields || []).filter((f: any) => fieldValues[f.key]).slice(0, 8).map((f: any) => (
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

export default function ProjectPage() {
  const router = useRouter()
  const params = useParams()
  const projectId = params.id as string

  const [project, setProject]         = useState<any>(null)
  const [analysis, setAnalysis]       = useState<any>(null)
  const [estimate, setEstimate]       = useState<any>(null)
  const [compliance, setCompliance]   = useState<ComplianceCheck | null>(null)
  const [tab, setTab]                 = useState<Tab>('overview')
  const [loading, setLoading]         = useState(true)
  const [blueprintStatus, setBlueprintStatus] = useState('pending')
  const [markup, setMarkup]           = useState(15)
  const [expandedItem, setExpandedItem] = useState<string | null>(null)
  const [complianceFilter, setComplianceFilter] = useState<ComplianceSeverity | 'all'>('all')
  const [sortMode, setSortMode]       = useState<SortMode>('lowest_price')
  const [expandedMaterial, setExpandedMaterial] = useState<string | null>(null)
  const [categoryFilter, setCategoryFilter] = useState<string>('all')
  const [editingMaterial, setEditingMaterial] = useState<string | null>(null)  // material id being edited
  const [editDraft, setEditDraft] = useState<any>({})  // draft values for editing
  const [materialChanges, setMaterialChanges] = useState<Record<string, any>>({})  // pending changes keyed by id
  const [savingMaterials, setSavingMaterials] = useState(false)
  const [searchingPrices, setSearchingPrices] = useState<string | null>(null)  // item id searching
  const [addingMaterial, setAddingMaterial] = useState(false)
  const [newMaterial, setNewMaterial] = useState({ item_name: '', category: 'lumber', quantity: 0, unit: 'each', unit_cost: 0 })
  // Materials compliance check
  const [matCheckLoading, setMatCheckLoading] = useState(false)
  const [matCheckResult, setMatCheckResult] = useState<any>(null)
  const [matCheckError, setMatCheckError] = useState<string | null>(null)
  const [refreshingPrices, setRefreshingPrices] = useState(false)
  const [refreshPricesResult, setRefreshPricesResult] = useState<string | null>(null)

  // Photos tab
  const [photos, setPhotos] = useState<any[]>([])
  const [photosLoading, setPhotosLoading] = useState(false)
  const [photoPhase, setPhotoPhase] = useState<'all' | 'before' | 'during' | 'after'>('all')
  const [uploadingPhoto, setUploadingPhoto] = useState(false)
  const [selectedPhoto, setSelectedPhoto] = useState<any>(null)
  // Job costing (actual spend per category, stored in localStorage)
  const [actualCosts, setActualCosts] = useState<Record<string, number>>({})
  // Blueprint signed URL for display
  const [blueprintViewUrl, setBlueprintViewUrl] = useState<string | null>(null)
  const [blueprintFileType, setBlueprintFileType] = useState<string>('')
  // Proposal modal
  const [showProposal, setShowProposal] = useState(false)
  // Photo-to-Measurements
  const [photoMeasureLoading, setPhotoMeasureLoading] = useState(false)
  const [photoMeasureResult, setPhotoMeasureResult] = useState<any>(null)
  const [photoMeasureError, setPhotoMeasureError] = useState<string | null>(null)
  // Hail/Wind Risk Score
  const [riskScore, setRiskScore] = useState<any>(null)
  const [riskScoreLoading, setRiskScoreLoading] = useState(false)
  const [riskScoreError, setRiskScoreError] = useState<string | null>(null)
  // Aerial Roof Report
  const [aerialAddress, setAerialAddress] = useState('')
  const [aerialLoading, setAerialLoading] = useState(false)
  const [aerialResult, setAerialResult] = useState<any>(null)
  const [aerialError, setAerialError] = useState<string | null>(null)
  // Quote Request modal
  const [quoteModal, setQuoteModal] = useState<{ vendor: string; url: string; items: any[] } | null>(null)
  const [quoteForm, setQuoteForm] = useState({ name: '', company: '', phone: '', email: '', branch: '', notes: '' })
  const [quoteGenerated, setQuoteGenerated] = useState(false)
  const [quoteCopied, setQuoteCopied] = useState(false)
  // 3D Model
  const [sceneData, setSceneData] = useState<any>(null)
  const [scene3dLoading, setScene3dLoading] = useState(false)
  const [scene3dError, setScene3dError] = useState<string | null>(null)

  const loadData = useCallback(async () => {
    try {
      const proj = await api.projects.get(projectId)
      setProject(proj)
      if (proj.city) setAerialAddress(`${proj.city}, ${proj.region?.replace('US-', '') || ''}`)
      const blueprints = proj.blueprints || []
      if (blueprints.length > 0) {
        const bp = blueprints[0]
        setBlueprintStatus(bp.status)
        if (bp.id) {
          // Backend proxy URL — streams the file server-side with service role auth
          setBlueprintViewUrl(api.blueprints.viewUrl(bp.id))
          setBlueprintFileType(bp.file_type || '')
        }
        if (bp.status === 'complete') {
          const [analysisData, estimateData] = await Promise.all([
            api.analyses.getByBlueprint(bp.id).catch(() => null),
            api.estimates.get(projectId).catch(() => null),
          ])
          setAnalysis(analysisData)
          setEstimate(estimateData)
          if (estimateData?.markup_pct) setMarkup(estimateData.markup_pct)
        }
      }
      const complianceData = await api.compliance.getForProject(projectId).catch(() => null)
      if (complianceData) setCompliance(complianceData)
      // Load photos
      try {
        const photoData = await api.photos.list(projectId)
        setPhotos(photoData || [])
      } catch {}
    } catch (err) { console.error(err) }
    setLoading(false)
  }, [projectId])

  useEffect(() => { loadData() }, [loadData])
  useEffect(() => {
    if (blueprintStatus !== 'processing' && blueprintStatus !== 'pending') return
    const interval = setInterval(loadData, 4000)
    return () => clearInterval(interval)
  }, [blueprintStatus, loadData])
  useEffect(() => {
    if (!projectId) return
    const saved = localStorage.getItem(`job_costs_${projectId}`)
    if (saved) { try { setActualCosts(JSON.parse(saved)) } catch {} }
  }, [projectId])

  async function handleMarkupUpdate() {
    try { await api.estimates.update(projectId, { markup_pct: markup }); await loadData() } catch {}
  }

  async function handleSaveMaterials() {
    if (Object.keys(materialChanges).length === 0) return
    setSavingMaterials(true)
    try {
      await Promise.all(
        Object.entries(materialChanges).map(([id, changes]) =>
          api.materials.update(projectId, id, changes)
        )
      )
      setMaterialChanges({})
      await loadData()
    } catch (err) { console.error(err) }
    setSavingMaterials(false)
  }

  async function handleDeleteMaterial(id: string) {
    try {
      await api.materials.delete(projectId, id)
      await loadData()
    } catch (err) { console.error(err) }
  }

  async function handleAddMaterial() {
    if (!newMaterial.item_name.trim()) return
    try {
      await api.materials.add(projectId, {
        ...newMaterial,
        total_cost: newMaterial.quantity * newMaterial.unit_cost,
      })
      setAddingMaterial(false)
      setNewMaterial({ item_name: '', category: 'lumber', quantity: 0, unit: 'each', unit_cost: 0 })
      await loadData()
    } catch (err) { console.error(err) }
  }

  async function handleSearchPrices(material: any, overrides?: { item_name?: string; category?: string }) {
    setSearchingPrices(material.id)
    try {
      const itemName = overrides?.item_name || material.item_name
      const category = overrides?.category || material.category
      const result = await api.materials.searchPrices({
        item_name: itemName,
        category: category,
        unit_cost: material.unit_cost,
        region: project?.region || 'US-TX',
        city: project?.city || '',
      })
      if (result?.options) {
        // Update vendor_options in local estimate state immediately
        setEstimate((prev: any) => {
          if (!prev) return prev
          return {
            ...prev,
            material_estimates: (prev.material_estimates || []).map((m: any) =>
              m.id === material.id ? { ...m, vendor_options: result.options, item_name: itemName } : m
            ),
          }
        })
      }
    } catch (err) { console.error(err) }
    setSearchingPrices(null)
  }

  async function handleRefreshAllPrices() {
    setRefreshingPrices(true)
    setRefreshPricesResult(null)
    try {
      const result = await api.materials.refreshAllPrices(projectId)
      setRefreshPricesResult(`Updated ${result.updated} item${result.updated !== 1 ? 's' : ''}`)
      // Reload estimate from DB to get updated prices
      const estimateData = await api.estimates.get(projectId).catch(() => null)
      if (estimateData) setEstimate(estimateData)
    } catch (err: any) {
      setRefreshPricesResult('Refresh failed — try again')
    }
    setRefreshingPrices(false)
    setTimeout(() => setRefreshPricesResult(null), 4000)
  }

  async function handleMaterialsComplianceCheck() {
    setMatCheckLoading(true)
    setMatCheckError(null)
    setMatCheckResult(null)
    try {
      const result = await api.compliance.checkMaterials(projectId)
      setMatCheckResult(result)
      // Auto-scroll to compliance tab if not already there
      setTab('compliance')
    } catch (err: any) {
      setMatCheckError(err.message || 'Compliance check failed.')
    }
    setMatCheckLoading(false)
  }

  async function handlePhotoMeasure() {
    setPhotoMeasureLoading(true)
    setPhotoMeasureError(null)
    setPhotoMeasureResult(null)
    try {
      const result = await api.photos.measure(projectId)
      setPhotoMeasureResult(result)
    } catch (err: any) {
      setPhotoMeasureError(err.message || 'Measurement analysis failed.')
    }
    setPhotoMeasureLoading(false)
  }

  async function handleRiskScore() {
    setRiskScoreLoading(true)
    setRiskScoreError(null)
    try {
      const result = await api.projects.getRiskScore(projectId)
      setRiskScore(result)
    } catch (err: any) {
      setRiskScoreError(err.message || 'Risk assessment failed.')
    }
    setRiskScoreLoading(false)
  }

  async function handleAerialReport() {
    if (!aerialAddress.trim()) return
    setAerialLoading(true)
    setAerialError(null)
    setAerialResult(null)
    try {
      const result = await api.roofing.aerialReport(projectId, aerialAddress)
      setAerialResult(result)
    } catch (err: any) {
      setAerialError(err.message || 'Aerial report failed.')
    }
    setAerialLoading(false)
  }

  function openQuoteModal(vendor: string, url: string) {
    const allItems = estimate?.material_estimates || []
    setQuoteModal({ vendor, url, items: allItems })
    setQuoteForm({ name: '', company: '', phone: '', email: '', branch: '', notes: '' })
    setQuoteGenerated(false)
    setQuoteCopied(false)
  }

  function generateQuoteText() {
    if (!quoteModal) return ''
    const itemLines = quoteModal.items.map((m: any) =>
      `  • ${m.item_name}  —  Qty: ${m.quantity} ${m.unit}  |  Est. unit cost: $${Number(m.unit_cost || 0).toFixed(2)}`
    ).join('\n')
    return `MATERIAL QUOTE REQUEST
${'─'.repeat(50)}
Distributor: ${quoteModal.vendor}
Date: ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}

CONTACT INFORMATION
Company: ${quoteForm.company || '___________________'}
Name: ${quoteForm.name || '___________________'}
Phone: ${quoteForm.phone || '___________________'}
Email: ${quoteForm.email || '___________________'}
Preferred Branch: ${quoteForm.branch || '___________________'}

PROJECT DETAILS
Project: ${project?.name || 'Construction Project'}
Location: ${[project?.city, project?.region?.replace('US-', '')].filter(Boolean).join(', ') || '___________________'}
Type: ${project?.blueprint_type || 'Residential'}

ITEMS REQUESTED
${itemLines}

NOTES
${quoteForm.notes || '(none)'}

─────────────────────────────────────────────────────
Please provide pricing and availability for the above items.
Thank you for your time.`
  }

  const photoInputRef = useRef<HTMLInputElement>(null)

  async function handlePhotoUpload(phase: 'before' | 'during' | 'after', files: FileList | null) {
    if (!files || files.length === 0) return
    setUploadingPhoto(true)
    try {
      for (const file of Array.from(files)) {
        const { upload_url, key, public_url } = await api.photos.getUploadUrl(projectId, `${Date.now()}_${file.name}`, file.type)
        // Upload directly to Supabase storage
        await fetch(upload_url, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } })
        // Register in DB
        await api.photos.register(projectId, { storage_key: key, filename: file.name, phase })
      }
      // Reload photos
      const updated = await api.photos.list(projectId)
      setPhotos(updated || [])
    } catch (err) { console.error(err) }
    setUploadingPhoto(false)
  }

  async function handleDeletePhoto(photo: any) {
    try {
      await api.photos.delete(projectId, photo.id)
      setPhotos(prev => prev.filter(p => p.id !== photo.id))
    } catch {}
  }

  async function handleGenerate3D() {
    setScene3dLoading(true)
    setScene3dError(null)
    try {
      const result = await api.model3d.parse(projectId)
      setSceneData(result)
    } catch (err: any) {
      setScene3dError(err.message || '3D generation failed. Please try again.')
    }
    setScene3dLoading(false)
  }

  useEffect(() => {
    if (tab !== 'view3d' || sceneData || scene3dLoading) return
    api.model3d.get(projectId)
      .then(r => {
        if (r?.scene_data) {
          setSceneData(r.scene_data)
        } else if (hasBlueprint) {
          handleGenerate3D()
        }
      })
      .catch(() => {
        if (hasBlueprint) handleGenerate3D()
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  function updateActualCost(category: string, value: number) {
    const updated = { ...actualCosts, [category]: value }
    setActualCosts(updated)
    localStorage.setItem(`job_costs_${projectId}`, JSON.stringify(updated))
  }

  const isProcessing = blueprintStatus === 'processing' || blueprintStatus === 'pending'
  const hasBlueprint = project?.blueprints?.length > 0
  const requiredCount = compliance?.items?.filter(i => i.severity === 'required').length ?? 0
  const recommendedCount = compliance?.items?.filter(i => i.severity === 'recommended').length ?? 0

  // ── Materials grouped by category ─────────────────────────────────────────
  const materials: any[] = estimate?.material_estimates || []
  const categoriesInData = Array.from(new Set(materials.map(m => m.category)))

  const filteredMaterials = categoryFilter === 'all'
    ? materials
    : materials.filter(m => m.category === categoryFilter)

  const byCategory: Record<string, any[]> = {}
  for (const m of filteredMaterials) {
    if (!byCategory[m.category]) byCategory[m.category] = []
    byCategory[m.category].push(m)
  }

  // ── Cost totals ────────────────────────────────────────────────────────────
  const categoryTotals: Record<string, number> = {}
  for (const m of materials) {
    categoryTotals[m.category] = (categoryTotals[m.category] || 0) + (m.total_cost || 0)
  }

  // ── Compliance grouped ─────────────────────────────────────────────────────
  const complianceByCategory: Record<string, ComplianceItem[]> = {}
  if (compliance?.items) {
    const filtered = complianceFilter === 'all' ? compliance.items : compliance.items.filter(i => i.severity === complianceFilter)
    for (const item of filtered) {
      if (!complianceByCategory[item.category]) complianceByCategory[item.category] = []
      complianceByCategory[item.category].push(item)
    }
  }

  if (loading) return (
    <div className="flex items-center justify-center h-full" style={{ background: 'linear-gradient(135deg, #eef6ff 0%, #ffffff 100%)' }}>
      <div className="flex flex-col items-center gap-3">
        <svg className="animate-spin text-blue-500" width="28" height="28" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>
        <span className="text-slate-500 text-sm">Loading project…</span>
      </div>
    </div>
  )

  const cardStyle = { boxShadow: '0 2px 12px rgba(59,130,246,0.08)', border: '1px solid rgba(219,234,254,0.8)' }
  const isRoofing = project?.blueprint_type === 'roofing'
  const TABS: { id: Tab; label: string; badge?: number }[] = [
    { id: 'overview',   label: 'Overview' },
    ...(isRoofing ? [{ id: 'roofing' as Tab, label: '🏠 Roof' }] : []),
    { id: 'materials',  label: 'Materials', badge: materials.length || undefined },
    { id: 'cost',       label: 'Cost Estimate' },
    { id: 'view3d',     label: '3D View' },
    { id: 'photos' as Tab,     label: '📸 Photos', badge: photos.length || undefined },
    { id: 'compliance', label: 'Compliance', badge: (requiredCount + (matCheckResult?.violations?.length ?? 0)) || undefined },
    { id: 'permits',    label: 'Permits' },
  ]

  return (
    <div className="flex flex-col h-full" style={{ background: 'linear-gradient(135deg, #eef6ff 0%, #ffffff 100%)' }}>

      {/* Header */}
      <div className="bg-white border-b px-6 py-4 flex items-center gap-4 flex-shrink-0" style={{ borderColor: 'rgba(219,234,254,0.9)' }}>
        <Link href="/projects" className="text-slate-400 hover:text-slate-700 transition-colors">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
        </Link>
        <div className="w-px h-5 bg-slate-200" />
        <div className="flex-1 min-w-0">
          <h1 className="text-slate-800 font-bold text-base truncate">{project?.name || 'Project'}</h1>
          {project?.region && <p className="text-slate-400 text-xs mt-0.5">{project.region} · {project.blueprint_type}</p>}
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full border ${
            blueprintStatus === 'complete' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' :
            blueprintStatus === 'failed'   ? 'bg-red-50 text-red-600 border-red-200' :
            'bg-amber-50 text-amber-700 border-amber-200'
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${blueprintStatus === 'complete' ? 'bg-emerald-500' : blueprintStatus === 'failed' ? 'bg-red-500' : 'bg-amber-400 animate-pulse'}`} />
            {blueprintStatus === 'complete' ? 'Analysis Complete' : blueprintStatus === 'failed' ? 'Failed' : 'Processing…'}
          </span>
          <Link href="/permits" className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-semibold px-4 py-2 rounded-xl text-sm transition-all">
            Submit Permit
          </Link>
        </div>
      </div>

      {!hasBlueprint ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="text-5xl mb-4">📐</div>
            <div className="text-slate-700 font-semibold mb-2">No blueprint uploaded</div>
            <Link href="/projects/new" className="text-blue-600 text-sm hover:text-blue-800">Upload a blueprint →</Link>
          </div>
        </div>
      ) : isProcessing ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="max-w-md text-center bg-white rounded-2xl p-10" style={cardStyle}>
            <div className="w-20 h-20 bg-blue-50 border border-blue-100 rounded-full flex items-center justify-center mx-auto mb-6">
              <svg className="animate-spin text-blue-500" width="36" height="36" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>
            </div>
            <h2 className="text-xl font-bold text-slate-800 mb-2">Analyzing Blueprint</h2>
            <p className="text-slate-500 text-sm leading-relaxed">Detecting rooms, walls, electrical, plumbing — then fetching real-time pricing for every material. This takes 60–120 seconds.</p>
            <div className="mt-6 h-1.5 bg-slate-100 rounded-full overflow-hidden">
              <div className="h-full bg-blue-500 rounded-full animate-pulse" style={{ width: '65%' }} />
            </div>
            <p className="text-slate-400 text-xs mt-3">Auto-refreshing…</p>
          </div>
        </div>
      ) : blueprintStatus === 'failed' ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center bg-white rounded-2xl p-10" style={cardStyle}>
            <div className="text-5xl mb-4">⚠️</div>
            <div className="text-slate-800 font-semibold mb-2">Analysis Failed</div>
            <div className="text-slate-500 text-sm">The AI could not process this blueprint. Please try re-uploading.</div>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">

          {/* Tab bar */}
          <div className="flex border-b bg-white px-6 flex-shrink-0" style={{ borderColor: 'rgba(219,234,254,0.9)' }}>
            {TABS.map(t => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex items-center gap-1.5 px-4 py-3.5 text-sm font-semibold border-b-2 transition-all -mb-px ${
                  tab === t.id ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-800'
                }`}
              >
                {t.label}
                {t.badge ? <span className="w-5 h-5 bg-blue-600 text-white text-[10px] font-bold rounded-full flex items-center justify-center">{t.badge > 99 ? '99+' : t.badge}</span> : null}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-y-auto p-6">

            {/* ── ROOFING ──────────────────────────────────────────────── */}
            {tab === 'roofing' && project?.blueprints?.[0] && (
              <div className="max-w-5xl">
                <RoofingSection
                  blueprintId={project.blueprints[0].id}
                  projectId={projectId}
                />
              </div>
            )}

            {/* ── OVERVIEW ──────────────────────────────────────────────── */}
            {tab === 'overview' && (
              <div className="grid grid-cols-12 gap-6 max-w-6xl">
                <div className="col-span-7 space-y-4">
                  {/* Blueprint preview */}
                  <div className="bg-white rounded-2xl overflow-hidden" style={cardStyle}>
                    <div className="flex items-center justify-between px-5 py-3.5 border-b" style={{ borderColor: 'rgba(219,234,254,0.7)' }}>
                      <span className="text-slate-800 font-semibold text-sm">Blueprint</span>
                      <div className="flex items-center gap-3">
                        {analysis?.confidence && (
                          <span className="text-xs text-slate-400">Quality: <span className="text-emerald-600 font-semibold">{Math.round(analysis.confidence * 100)}%</span></span>
                        )}
                        {blueprintViewUrl && (
                          <a
                            href={blueprintViewUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-blue-500 hover:text-blue-700 font-semibold flex items-center gap-1"
                          >
                            Open full size
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                          </a>
                        )}
                      </div>
                    </div>
                    {blueprintViewUrl ? (
                      <iframe
                        key={blueprintViewUrl}
                        src={blueprintViewUrl}
                        className="w-full border-0 block"
                        style={{ height: '560px' }}
                        title="Blueprint"
                      />
                    ) : (
                      <div className="flex items-center justify-center" style={{ height: '420px', background: 'linear-gradient(135deg, #eff6ff, #dbeafe)' }}>
                        <div className="text-center">
                          <svg className="animate-spin mx-auto mb-3 text-blue-400" width="28" height="28" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>
                          <p className="text-blue-400 text-sm">Loading blueprint…</p>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Stats */}
                  {analysis && (
                    <div className="grid grid-cols-4 gap-3">
                      {[
                        { label: 'Total Sqft',  value: `${(analysis.total_sqft || 0).toLocaleString()}` },
                        { label: 'Rooms',       value: analysis.rooms?.length || 0 },
                        { label: 'Materials',   value: materials.length },
                        { label: 'Est. Cost',   value: estimate?.grand_total ? formatMoney(estimate.grand_total) : '—' },
                      ].map(c => (
                        <div key={c.label} className="bg-white rounded-xl p-4" style={cardStyle}>
                          <div className="text-xl font-black text-slate-800">{c.value}</div>
                          <div className="text-slate-400 text-xs mt-0.5">{c.label}</div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Compliance banner */}
                  {compliance?.status === 'complete' && compliance.risk_level && (
                    <div className={`flex items-start gap-3 rounded-xl border px-5 py-4 ${RISK_BANNER[compliance.risk_level]}`}>
                      <span className="text-lg mt-0.5">⚖️</span>
                      <div>
                        <div className="font-bold text-sm mb-0.5 capitalize">Compliance Risk: {compliance.risk_level}</div>
                        <p className="text-xs opacity-80 leading-relaxed">{compliance.summary}</p>
                        <div className="flex gap-4 mt-2 text-xs opacity-60">
                          <span>{requiredCount} required actions</span>
                          <span>{recommendedCount} recommendations</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Right col */}
                <div className="col-span-5 space-y-4">
                  <div className="bg-white rounded-2xl p-5" style={cardStyle}>
                    <h3 className="text-slate-800 font-bold text-sm mb-4">Project Summary</h3>
                    <div className="space-y-1">
                      {[
                        { label: 'Type',          value: project?.blueprint_type || 'Residential' },
                        { label: 'Region',        value: project?.region || '—' },
                        { label: 'City',          value: project?.city || '—' },
                        { label: 'Total Area',    value: analysis?.total_sqft ? `${analysis.total_sqft.toLocaleString()} sqft` : '—' },
                        { label: 'Rooms',         value: analysis?.rooms?.length || '—' },
                        { label: 'Materials',     value: materials.length || '—' },
                        { label: 'Est. Cost',     value: estimate?.grand_total ? formatMoney(estimate.grand_total) : '—' },
                        { label: 'Labor Hours',   value: estimate?.labor_hours ? `${estimate.labor_hours.toFixed(0)} hrs` : '—' },
                        { label: 'Uploaded',      value: new Date(project?.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) },
                      ].map(row => (
                        <div key={row.label} className="flex justify-between items-center py-2 border-b last:border-0" style={{ borderColor: 'rgba(219,234,254,0.6)' }}>
                          <span className="text-slate-400 text-sm">{row.label}</span>
                          <span className="text-slate-800 text-sm font-semibold">{row.value}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Hail / Wind Risk Score */}
                  <div className="bg-white rounded-2xl p-5" style={cardStyle}>
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-slate-800 font-bold text-sm">Storm Risk Score</h3>
                      <button
                        onClick={handleRiskScore}
                        disabled={riskScoreLoading || !project?.city}
                        title={!project?.city ? 'Add a city to the project first' : ''}
                        className="flex items-center gap-1.5 text-white text-xs font-bold px-3 py-1.5 rounded-xl transition-all disabled:opacity-40"
                        style={{ background: riskScoreLoading ? '#94a3b8' : 'linear-gradient(135deg, #0ea5e9, #0369a1)', boxShadow: '0 3px 10px rgba(14,165,233,0.25)' }}
                      >
                        {riskScoreLoading ? <><svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg> Analyzing…</> : '🌩 Get Score'}
                      </button>
                    </div>
                    {riskScoreError && <div className="text-red-600 text-xs bg-red-50 rounded-xl px-3 py-2">{riskScoreError}</div>}
                    {!riskScore && !riskScoreError && !riskScoreLoading && (
                      <div className="text-slate-400 text-xs text-center py-4">Hail, wind, and storm risk assessment for {project?.city || 'this location'}.</div>
                    )}
                    {riskScore && (() => {
                      const colorMap: Record<string, string> = {
                        emerald: 'bg-emerald-50 border-emerald-200 text-emerald-700',
                        amber:   'bg-amber-50 border-amber-200 text-amber-700',
                        red:     'bg-red-50 border-red-200 text-red-700',
                      }
                      const barMap: Record<string, string> = {
                        emerald: 'bg-emerald-500',
                        amber:   'bg-amber-500',
                        red:     'bg-red-500',
                      }
                      const c = riskScore.risk_color || 'amber'
                      return (
                        <div>
                          <div className={`flex items-center gap-3 rounded-xl border px-4 py-3 mb-3 ${colorMap[c] || colorMap.amber}`}>
                            <div className="text-2xl font-black">{riskScore.overall_risk}<span className="text-sm font-semibold">/10</span></div>
                            <div>
                              <div className="font-bold text-sm">{riskScore.risk_label}</div>
                              <div className="text-xs opacity-70">{project?.city} storm exposure</div>
                            </div>
                          </div>
                          <div className="space-y-2 mb-3">
                            {[
                              { label: 'Hail', score: riskScore.hail_risk },
                              { label: 'Wind', score: riskScore.wind_risk },
                              { label: 'Flood', score: riskScore.flood_risk },
                            ].map(r => (
                              <div key={r.label} className="flex items-center gap-2">
                                <span className="text-slate-500 text-xs w-10">{r.label}</span>
                                <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                                  <div className={`h-full rounded-full ${barMap[c] || barMap.amber}`} style={{ width: `${(r.score / 10) * 100}%` }} />
                                </div>
                                <span className="text-slate-600 text-xs font-semibold w-6 text-right">{r.score}</span>
                              </div>
                            ))}
                          </div>
                          {riskScore.summary && <p className="text-slate-600 text-xs leading-relaxed mb-2">{riskScore.summary}</p>}
                          {riskScore.scoring_rationale && (
                            <div className="bg-slate-50 rounded-xl px-3 py-2.5 mb-2">
                              <div className="text-slate-500 text-[10px] font-bold uppercase tracking-wider mb-1">Why This Score</div>
                              <p className="text-slate-600 text-xs leading-relaxed">{riskScore.scoring_rationale}</p>
                            </div>
                          )}
                          {riskScore.significance && (
                            <div className="bg-blue-50 rounded-xl px-3 py-2.5 mb-2">
                              <div className="text-blue-500 text-[10px] font-bold uppercase tracking-wider mb-1">What This Means For You</div>
                              <p className="text-blue-700 text-xs leading-relaxed">{riskScore.significance}</p>
                            </div>
                          )}
                          {riskScore.recommendation && <p className="text-blue-600 text-xs font-semibold mb-2">{riskScore.recommendation}</p>}
                          {riskScore.insurance_note && <p className="text-slate-500 text-xs italic mb-2">{riskScore.insurance_note}</p>}
                          {riskScore.recent_events?.length > 0 && (
                            <div className="mt-3 space-y-1.5">
                              <div className="text-slate-500 text-[10px] font-bold uppercase tracking-wider">Recent Events</div>
                              {riskScore.recent_events.slice(0, 4).map((ev: any, i: number) => (
                                <div key={i} className="bg-slate-50 rounded-lg px-3 py-2">
                                  <div className="text-slate-700 text-xs font-semibold">{ev.year} — {ev.type}</div>
                                  <div className="text-slate-500 text-[10px]">{ev.severity}</div>
                                  {ev.impact && <div className="text-slate-400 text-[10px]">{ev.impact}</div>}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )
                    })()}
                  </div>

                  {/* Aerial Roof Report */}
                  <div className="bg-white rounded-2xl p-5" style={cardStyle}>
                    <h3 className="text-slate-800 font-bold text-sm mb-1">Aerial Roof Report</h3>
                    <p className="text-slate-400 text-xs mb-3">Enter a property address to pull real roof measurements from Google Solar satellite imagery.</p>
                    <div className="flex gap-2 mb-3">
                      <input
                        value={aerialAddress}
                        onChange={e => setAerialAddress(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && handleAerialReport()}
                        placeholder="123 Main St, City, TX"
                        className="flex-1 border rounded-xl px-3 py-2 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-blue-300"
                        style={{ borderColor: 'rgba(219,234,254,0.9)' }}
                      />
                      <button
                        onClick={handleAerialReport}
                        disabled={aerialLoading || !aerialAddress.trim()}
                        className="flex items-center gap-1.5 text-white text-xs font-bold px-3 py-2 rounded-xl transition-all disabled:opacity-40"
                        style={{ background: aerialLoading ? '#94a3b8' : 'linear-gradient(135deg, #7c3aed, #5b21b6)', boxShadow: '0 3px 10px rgba(124,58,237,0.25)' }}
                      >
                        {aerialLoading ? <><svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg> Analyzing…</> : '🛰 Pull Report'}
                      </button>
                    </div>
                    {aerialError && <div className="text-red-600 text-xs bg-red-50 rounded-xl px-3 py-2 mb-2">{aerialError}</div>}
                    {aerialResult && (() => {
                      const isSatellite = aerialResult.source === 'Google Solar API'
                      const confidence = Math.round((aerialResult.confidence || 0) * 100)
                      return (
                        <div>
                          {/* Source badge */}
                          <div className={`flex items-center gap-2 rounded-xl px-3 py-2 mb-3 ${isSatellite ? 'bg-emerald-50 border border-emerald-200' : 'bg-amber-50 border border-amber-200'}`}>
                            <span className="text-lg">{isSatellite ? '🛰' : '📋'}</span>
                            <div>
                              <div className={`text-xs font-bold ${isSatellite ? 'text-emerald-700' : 'text-amber-700'}`}>
                                {isSatellite ? 'Google Solar Satellite Imagery' : 'Property Records Estimate'}
                              </div>
                              <div className={`text-[10px] ${isSatellite ? 'text-emerald-600' : 'text-amber-600'}`}>
                                {isSatellite
                                  ? `${confidence}% confidence — measured from aerial imagery`
                                  : `${confidence}% confidence — estimated from public records. Physical inspection recommended.`}
                              </div>
                            </div>
                          </div>
                          {/* Metrics */}
                          <div className="grid grid-cols-2 gap-2 mb-3">
                            {[
                              { label: 'Roof Sqft',  value: `${(aerialResult.total_sqft || 0).toLocaleString()}` },
                              { label: 'Squares',    value: `${aerialResult.squares || 0}` },
                              { label: 'Pitch',      value: aerialResult.pitch || '—' },
                              { label: 'Segments',   value: aerialResult.roof_segments || '—' },
                            ].map(s => (
                              <div key={s.label} className="bg-purple-50 rounded-xl p-3">
                                <div className="text-purple-800 font-black text-lg">{s.value}</div>
                                <div className="text-purple-400 text-xs">{s.label}</div>
                              </div>
                            ))}
                          </div>
                          {aerialResult.stories && (
                            <div className="text-slate-500 text-xs mb-2">Stories: {aerialResult.stories} &nbsp;·&nbsp; House sqft: {aerialResult.house_sqft?.toLocaleString() || '—'}</div>
                          )}
                          <p className="text-slate-400 text-[10px] leading-relaxed mt-2">
                            {isSatellite
                              ? 'Roof measurements were derived from Google Solar satellite imagery using high-resolution aerial analysis of the building footprint and roof geometry. Data is provided for estimation purposes and should be verified prior to material procurement.'
                              : 'Measurements are estimates based on publicly available property records. Figures may vary from actual roof area. A physical inspection is recommended before ordering materials.'}
                          </p>
                        </div>
                      )
                    })()}
                  </div>

                  {analysis?.rooms?.length > 0 && (
                    <div className="bg-white rounded-2xl p-5" style={cardStyle}>
                      <h3 className="text-slate-800 font-bold text-sm mb-3">Rooms Detected</h3>
                      <div className="space-y-1">
                        {analysis.rooms.slice(0, 6).map((room: any, i: number) => (
                          <div key={i} className="flex justify-between items-center py-2 border-b last:border-0" style={{ borderColor: 'rgba(219,234,254,0.6)' }}>
                            <span className="text-slate-700 text-sm">{room.name}</span>
                            <span className="text-blue-600 text-sm font-semibold">{room.sqft?.toLocaleString()} sqft</span>
                          </div>
                        ))}
                        {analysis.rooms.length > 6 && (
                          <button onClick={() => setTab('materials')} className="text-blue-500 text-xs mt-1 hover:text-blue-700">
                            +{analysis.rooms.length - 6} more rooms
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── MATERIALS ─────────────────────────────────────────────── */}
            {tab === 'materials' && (
              <div className="max-w-5xl">
                {/* Header + controls */}
                <div className="flex items-center justify-between mb-5">
                  <div>
                    <h2 className="text-slate-800 font-bold text-lg">Materials List</h2>
                    <p className="text-slate-400 text-xs mt-0.5">{materials.length} items across {categoriesInData.length} categories</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {/* Refresh All Prices button */}
                    <button
                      onClick={handleRefreshAllPrices}
                      disabled={refreshingPrices || materials.length === 0}
                      title="Re-fetch live prices for all materials from Home Depot, Lowe's, and more"
                      className="flex items-center gap-2 text-white font-bold px-4 py-2 rounded-xl text-sm transition-all disabled:opacity-40 hover:scale-[1.02]"
                      style={{ background: refreshingPrices ? '#94a3b8' : 'linear-gradient(135deg, #0ea5e9, #0369a1)', boxShadow: '0 4px 14px rgba(14,165,233,0.25)' }}
                    >
                      {refreshingPrices ? (
                        <><svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg> Refreshing…</>
                      ) : refreshPricesResult ? refreshPricesResult : '🔄 Refresh All Prices'}
                    </button>
                    {/* Check Code Compliance button */}
                    <button
                      onClick={handleMaterialsComplianceCheck}
                      disabled={matCheckLoading || !project?.city}
                      title={!project?.city ? 'Add a city to the project first' : 'Cross-reference materials against local building codes'}
                      className="flex items-center gap-2 text-white font-bold px-4 py-2 rounded-xl text-sm transition-all disabled:opacity-40 hover:scale-[1.02]"
                      style={{ background: matCheckLoading ? '#94a3b8' : 'linear-gradient(135deg, #7c3aed, #5b21b6)', boxShadow: '0 4px 14px rgba(124,58,237,0.25)' }}
                    >
                      {matCheckLoading ? (
                        <><svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg> Checking…</>
                      ) : '⚖ Check Code Compliance'}
                    </button>
                    {Object.keys(materialChanges).length > 0 && (
                      <button
                        onClick={handleSaveMaterials}
                        disabled={savingMaterials}
                        className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold px-4 py-2 rounded-xl transition-all disabled:opacity-50"
                      >
                        {savingMaterials ? 'Saving…' : `Save Changes (${Object.keys(materialChanges).length})`}
                      </button>
                    )}
                    <button
                      onClick={() => setAddingMaterial(v => !v)}
                      className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold px-4 py-2 rounded-xl transition-all"
                    >
                      + Add Item
                    </button>
                    <button
                      onClick={() => api.reports.download(projectId, 'csv').then(({ download_url }) => window.open(download_url)).catch(() => {})}
                      className="flex items-center gap-2 bg-white border text-slate-600 text-sm font-medium px-4 py-2 rounded-xl transition-all hover:border-blue-300 hover:text-blue-600"
                      style={{ borderColor: 'rgba(219,234,254,0.9)' }}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                      Export CSV
                    </button>
                  </div>
                </div>

                {/* Category filter pills */}
                <div className="flex gap-2 flex-wrap mb-5">
                  <button
                    onClick={() => setCategoryFilter('all')}
                    className={`text-xs px-3 py-1.5 rounded-full font-semibold border transition-all ${categoryFilter === 'all' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-500 border-slate-200 hover:border-blue-300'}`}
                  >
                    All ({materials.length})
                  </button>
                  {categoriesInData.map(cat => {
                    const meta = CATEGORY_META[cat] || { label: cat, icon: '📦', color: '' }
                    const count = materials.filter(m => m.category === cat).length
                    return (
                      <button
                        key={cat}
                        onClick={() => setCategoryFilter(cat)}
                        className={`text-xs px-3 py-1.5 rounded-full font-semibold border transition-all ${categoryFilter === cat ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-500 border-slate-200 hover:border-blue-300'}`}
                      >
                        {meta.icon} {meta.label} ({count})
                      </button>
                    )
                  })}
                </div>

                {addingMaterial && (
                  <div className="bg-white rounded-2xl p-5 mb-4 border-2 border-dashed border-blue-200" style={cardStyle}>
                    <div className="text-sm font-bold text-slate-700 mb-3">Add New Material</div>
                    <div className="grid grid-cols-5 gap-3">
                      <input placeholder="Item name" value={newMaterial.item_name} onChange={e => setNewMaterial(p => ({...p, item_name: e.target.value}))}
                        className="col-span-2 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
                      <select value={newMaterial.category} onChange={e => setNewMaterial(p => ({...p, category: e.target.value}))}
                        className="bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-blue-400">
                        {Object.entries(CATEGORY_META).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                      </select>
                      <input type="number" placeholder="Qty" value={newMaterial.quantity || ''} onChange={e => setNewMaterial(p => ({...p, quantity: Number(e.target.value)}))}
                        className="bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
                      <input type="number" placeholder="Unit cost $" value={newMaterial.unit_cost || ''} onChange={e => setNewMaterial(p => ({...p, unit_cost: Number(e.target.value)}))}
                        className="bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-blue-400" />
                    </div>
                    <div className="flex gap-2 mt-3">
                      <button onClick={handleAddMaterial} className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold px-4 py-2 rounded-xl transition-all">Add</button>
                      <button onClick={() => setAddingMaterial(false)} className="bg-slate-100 hover:bg-slate-200 text-slate-600 text-sm font-semibold px-4 py-2 rounded-xl transition-all">Cancel</button>
                    </div>
                  </div>
                )}

                {!materials.length ? (
                  <div className="bg-white rounded-2xl p-12 text-center text-slate-400" style={cardStyle}>No materials estimated yet.</div>
                ) : (
                  <div className="space-y-6">
                    {Object.entries(byCategory).map(([cat, items]) => {
                      const meta = CATEGORY_META[cat] || { label: cat, icon: '📦', color: 'bg-slate-50 text-slate-700 border-slate-200' }
                      const catTotal = items.reduce((s, m) => s + (m.total_cost || 0), 0)
                      return (
                        <div key={cat} className="bg-white rounded-2xl overflow-hidden" style={cardStyle}>
                          {/* Category header */}
                          <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: 'rgba(219,234,254,0.7)' }}>
                            <div className="flex items-center gap-3">
                              <span className="text-xl">{meta.icon}</span>
                              <span className="text-slate-800 font-bold text-sm">{meta.label}</span>
                              <span className={`text-xs px-2 py-0.5 rounded-full border font-semibold ${meta.color}`}>{items.length} items</span>
                            </div>
                            <span className="text-slate-800 font-black text-sm">{formatMoney(catTotal)}</span>
                          </div>

                          {/* Items */}
                          <div className="divide-y" style={{ borderColor: 'rgba(219,234,254,0.5)' }}>
                            {items.map((m, i) => {
                              const vendors: any[] = (() => {
                                try {
                                  return typeof m.vendor_options === 'string'
                                    ? JSON.parse(m.vendor_options)
                                    : (m.vendor_options || [])
                                } catch { return [] }
                              })()
                              const sortedVendors = sortMode === 'lowest_price'
                                ? [...vendors].sort((a, b) => a.price - b.price)
                                : vendors
                              const matKey = m.id || `${cat}-${i}`
                              const isExpanded = expandedMaterial === matKey
                              const isEditing = editingMaterial === matKey

                              return (
                                <div key={matKey} className="group">
                                  {/* Material row */}
                                  <div
                                    className="w-full flex items-center gap-4 px-5 py-3.5 hover:bg-blue-50/40 transition-colors cursor-pointer"
                                    onClick={() => setExpandedMaterial(isExpanded ? null : matKey)}
                                  >
                                    <div className="flex-1 min-w-0">
                                      {isEditing ? (
                                        <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                                          <input
                                            value={editDraft.item_name ?? m.item_name}
                                            onChange={e => setEditDraft((p: any) => ({...p, item_name: e.target.value}))}
                                            className="bg-white border border-blue-300 rounded-lg px-2 py-1 text-sm focus:outline-none focus:border-blue-500 w-40"
                                          />
                                          <input type="number"
                                            value={editDraft.quantity ?? m.quantity}
                                            onChange={e => setEditDraft((p: any) => ({...p, quantity: Number(e.target.value)}))}
                                            className="bg-white border border-blue-300 rounded-lg px-2 py-1 text-sm focus:outline-none focus:border-blue-500 w-20"
                                            placeholder="Qty"
                                          />
                                          <input type="number"
                                            value={editDraft.unit_cost ?? m.unit_cost}
                                            onChange={e => setEditDraft((p: any) => ({...p, unit_cost: Number(e.target.value)}))}
                                            className="bg-white border border-blue-300 rounded-lg px-2 py-1 text-sm focus:outline-none focus:border-blue-500 w-24"
                                            placeholder="Unit cost"
                                          />
                                          <button
                                            onClick={e => { e.stopPropagation(); setMaterialChanges((p: any) => ({...p, [m.id]: editDraft})); setEditingMaterial(null) }}
                                            className="text-xs bg-blue-600 text-white px-2 py-1 rounded-lg hover:bg-blue-700"
                                          >Save</button>
                                          <button
                                            onClick={e => { e.stopPropagation(); setEditingMaterial(null) }}
                                            className="text-xs bg-slate-100 text-slate-600 px-2 py-1 rounded-lg hover:bg-slate-200"
                                          >Cancel</button>
                                        </div>
                                      ) : (
                                        <>
                                          <div className="text-slate-800 text-sm font-semibold">{(materialChanges[m.id]?.item_name) ?? m.item_name}</div>
                                          <div className="text-slate-400 text-xs mt-0.5">{(materialChanges[m.id]?.quantity ?? m.quantity)?.toLocaleString()} {m.unit}</div>
                                        </>
                                      )}
                                    </div>
                                    {!isEditing && (
                                      <div className="text-right flex-shrink-0">
                                        <div className="text-slate-800 font-bold text-sm">{formatMoneyExact(materialChanges[m.id]?.unit_cost ?? m.unit_cost)} / {m.unit}</div>
                                        <div className="text-blue-600 font-black text-sm">{formatMoney(m.total_cost)}</div>
                                      </div>
                                    )}
                                    {vendors.length > 0 && !isEditing && (
                                      <div className="text-xs text-blue-500 font-semibold flex-shrink-0 flex items-center gap-1">
                                        {vendors.length} sources
                                        <svg className={`transition-transform ${isExpanded ? 'rotate-180' : ''}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="6 9 12 15 18 9"/></svg>
                                      </div>
                                    )}
                                    <div className="flex items-center gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                                      <button
                                        onClick={e => { e.stopPropagation(); setEditingMaterial(matKey); setEditDraft({ item_name: m.item_name, quantity: m.quantity, unit_cost: m.unit_cost }) }}
                                        className="p-1.5 rounded-lg hover:bg-blue-50 text-slate-400 hover:text-blue-600 transition-all"
                                        title="Edit"
                                      >
                                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                                      </button>
                                      <button
                                        onClick={e => { e.stopPropagation(); handleDeleteMaterial(m.id) }}
                                        className="p-1.5 rounded-lg hover:bg-red-50 text-slate-400 hover:text-red-500 transition-all"
                                        title="Delete"
                                      >
                                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
                                      </button>
                                    </div>
                                  </div>

                                  {/* Vendor options expanded */}
                                  {isExpanded && vendors.length > 0 && (
                                    <div className="px-5 pb-4 bg-slate-50/60">
                                      <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3 pt-3">Where to Buy</div>
                                      <div className="grid gap-2">
                                        {sortedVendors.map((v: any, vi: number) => {
                                          const isQuoteOnly = v.quote_only === true || v.price === null || v.price === undefined
                                          const buyUrl = v.url && v.url.startsWith('http')
                                            ? v.url
                                            : `https://www.google.com/search?q=${encodeURIComponent(`${m.item_name} ${v.vendor} buy`)}`
                                          // Retail entries: show price tag on first; trade distributors: show "Trade" badge
                                          const isFirstRetail = !isQuoteOnly && vi === 0
                                          return (
                                            <div
                                              key={vi}
                                              className={`flex items-center justify-between rounded-xl px-4 py-3 border ${isQuoteOnly ? 'bg-slate-50' : 'bg-white'}`}
                                              style={{ borderColor: isQuoteOnly ? 'rgba(203,213,225,0.8)' : 'rgba(219,234,254,0.9)' }}
                                            >
                                              <div className="flex items-center gap-2 min-w-0">
                                                {isFirstRetail && (
                                                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full flex-shrink-0 bg-emerald-100 text-emerald-700">
                                                    LOWEST
                                                  </span>
                                                )}
                                                {isQuoteOnly && (
                                                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full flex-shrink-0 bg-amber-100 text-amber-700">
                                                    TRADE
                                                  </span>
                                                )}
                                                <div className="min-w-0">
                                                  <div className="text-slate-700 text-sm font-semibold truncate">{v.vendor}</div>
                                                  {v.note && <div className="text-slate-400 text-xs">{v.note}</div>}
                                                </div>
                                              </div>
                                              <div className="flex items-center gap-2 flex-shrink-0 ml-3">
                                                {isQuoteOnly ? (
                                                  <span className="text-slate-400 text-xs font-semibold italic">Call for pricing</span>
                                                ) : (
                                                  <span className="text-slate-800 font-black text-sm">{formatMoneyExact(v.price)}</span>
                                                )}
                                                <a
                                                  href={buyUrl}
                                                  target="_blank"
                                                  rel="noopener noreferrer"
                                                  onClick={e => e.stopPropagation()}
                                                  className={`flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-lg transition-all whitespace-nowrap ${isQuoteOnly ? 'bg-amber-500 hover:bg-amber-600 text-white' : 'bg-blue-600 hover:bg-blue-700 text-white'}`}
                                                >
                                                  {isQuoteOnly ? 'Get Quote' : 'Buy Now'}
                                                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                                                </a>
                                              </div>
                                            </div>
                                          )
                                        })}
                                      </div>
                                    </div>
                                  )}

                                  {/* Search for Live Prices */}
                                  {isExpanded && (
                                    <div className="px-5 pb-3 bg-slate-50/60">
                                      <button
                                        onClick={e => {
                                          e.stopPropagation()
                                          const overrides = editingMaterial === m.id ? {
                                            item_name: editDraft.item_name || m.item_name,
                                            category: editDraft.category || m.category,
                                          } : undefined
                                          handleSearchPrices(m, overrides)
                                        }}
                                        disabled={searchingPrices === m.id}
                                        className="flex items-center gap-2 text-xs font-semibold text-blue-600 hover:text-blue-800 bg-blue-50 hover:bg-blue-100 px-3 py-1.5 rounded-lg transition-all border border-blue-200 disabled:opacity-50"
                                      >
                                        {searchingPrices === m.id ? (
                                          <>
                                            <svg className="animate-spin" width="11" height="11" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>
                                            Searching nearby prices…
                                          </>
                                        ) : (
                                          <>
                                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                                            Search for Live Prices
                                          </>
                                        )}
                                      </button>
                                    </div>
                                  )}
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}

            {/* ── COST ──────────────────────────────────────────────────── */}
            {tab === 'cost' && (
              <div className="max-w-3xl">
                {!estimate ? (
                  <div className="bg-white rounded-2xl p-12 text-center text-slate-400" style={cardStyle}>No cost estimate available.</div>
                ) : (() => {
                  const matTotal   = estimate.materials_total || 0
                  const laborTotal = estimate.labor_total || 0
                  const overhead   = (matTotal + laborTotal) * 0.10
                  const markupAmt  = (matTotal + laborTotal + overhead) * ((estimate.markup_pct || 15) / 100)
                  const grand      = matTotal + laborTotal + overhead + markupAmt

                  const laborByTrade = Object.entries(LABOR_TRADE_SPLIT).map(([trade, pct]) => ({
                    trade,
                    cost: Math.round(laborTotal * pct),
                  })).sort((a, b) => b.cost - a.cost)

                  return (
                    <div className="space-y-5">
                      {/* Grand total hero */}
                      <div className="bg-blue-600 rounded-2xl p-8 text-center text-white" style={{ boxShadow: '0 8px 32px rgba(37,99,235,0.3)' }}>
                        <div className="text-blue-100 text-sm mb-1">Total Estimated Project Cost</div>
                        <div className="text-5xl font-black mb-2">{formatMoney(grand)}</div>
                        <div className="flex justify-center gap-6 text-blue-200 text-sm mt-3">
                          <span>Materials: {formatMoney(matTotal)}</span>
                          <span>·</span>
                          <span>Labor: {formatMoney(laborTotal)}</span>
                          <span>·</span>
                          <span>{estimate.region}</span>
                        </div>
                      </div>

                      {/* ── Materials by category ── */}
                      <div className="bg-white rounded-2xl overflow-hidden" style={cardStyle}>
                        <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: 'rgba(219,234,254,0.7)' }}>
                          <span className="text-slate-800 font-bold">Materials Cost by Category</span>
                          <span className="text-blue-600 font-black">{formatMoney(matTotal)}</span>
                        </div>
                        {Object.entries(categoryTotals)
                          .sort((a, b) => b[1] - a[1])
                          .map(([cat, total]) => {
                            const meta = CATEGORY_META[cat] || { label: cat, icon: '📦', color: '' }
                            const pct  = matTotal > 0 ? (total / matTotal) * 100 : 0
                            return (
                              <div key={cat} className="px-5 py-3.5 border-b last:border-0" style={{ borderColor: 'rgba(219,234,254,0.5)' }}>
                                <div className="flex justify-between items-center mb-1.5">
                                  <span className="text-slate-600 text-sm flex items-center gap-2">
                                    <span>{meta.icon}</span>{meta.label}
                                  </span>
                                  <div className="flex items-center gap-3">
                                    <span className="text-slate-400 text-xs">{pct.toFixed(1)}%</span>
                                    <span className="text-slate-800 font-bold text-sm w-20 text-right">{formatMoney(total as number)}</span>
                                  </div>
                                </div>
                                <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                                  <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
                                </div>
                              </div>
                            )
                          })}
                        <div className="px-5 py-3 flex justify-between items-center bg-blue-50/60 border-t" style={{ borderColor: 'rgba(219,234,254,0.7)' }}>
                          <span className="text-slate-600 text-sm font-bold">Materials Subtotal</span>
                          <span className="text-slate-800 font-black">{formatMoney(matTotal)}</span>
                        </div>
                      </div>

                      {/* ── Labor by trade ── */}
                      <div className="bg-white rounded-2xl overflow-hidden" style={cardStyle}>
                        <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: 'rgba(219,234,254,0.7)' }}>
                          <div>
                            <span className="text-slate-800 font-bold">Labor by Trade</span>
                            <span className="text-slate-400 text-xs ml-2">({estimate.labor_hours?.toFixed(0) || '—'} hrs estimated)</span>
                          </div>
                          <span className="text-purple-600 font-black">{formatMoney(laborTotal)}</span>
                        </div>
                        {laborByTrade.map(({ trade, cost }) => {
                          const pct = laborTotal > 0 ? (cost / laborTotal) * 100 : 0
                          return (
                            <div key={trade} className="px-5 py-3.5 border-b last:border-0" style={{ borderColor: 'rgba(219,234,254,0.5)' }}>
                              <div className="flex justify-between items-center mb-1.5">
                                <span className="text-slate-600 text-sm">👷 {trade}</span>
                                <div className="flex items-center gap-3">
                                  <span className="text-slate-400 text-xs">{pct.toFixed(1)}%</span>
                                  <span className="text-slate-800 font-bold text-sm w-20 text-right">{formatMoney(cost)}</span>
                                </div>
                              </div>
                              <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                                <div className="h-full bg-purple-400 rounded-full transition-all" style={{ width: `${pct}%` }} />
                              </div>
                            </div>
                          )
                        })}
                        <div className="px-5 py-3 flex justify-between items-center bg-purple-50/60 border-t" style={{ borderColor: 'rgba(219,234,254,0.7)' }}>
                          <span className="text-slate-600 text-sm font-bold">Labor Subtotal</span>
                          <span className="text-slate-800 font-black">{formatMoney(laborTotal)}</span>
                        </div>
                      </div>

                      {/* ── Job Costing: Actual vs Estimated ── */}
                      <div className="bg-white rounded-2xl overflow-hidden" style={cardStyle}>
                        <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: 'rgba(219,234,254,0.7)' }}>
                          <div>
                            <span className="text-slate-800 font-bold">Job Costing — Actual vs Estimated</span>
                            <span className="text-slate-400 text-xs ml-2">Track your real spend per category</span>
                          </div>
                          {(() => {
                            const totalActual = Object.values(actualCosts).reduce((s, v) => s + v, 0)
                            const totalEst = matTotal
                            const diff = totalActual - totalEst
                            if (totalActual === 0) return null
                            return (
                              <span className={`text-xs font-bold px-2.5 py-1 rounded-full border ${diff <= 0 ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-red-50 border-red-200 text-red-700'}`}>
                                {diff <= 0 ? `${formatMoney(Math.abs(diff))} under budget` : `${formatMoney(diff)} over budget`}
                              </span>
                            )
                          })()}
                        </div>
                        <div className="divide-y" style={{ borderColor: 'rgba(219,234,254,0.5)' }}>
                          {Object.entries(categoryTotals).sort((a, b) => b[1] - a[1]).map(([cat, est]) => {
                            const meta = CATEGORY_META[cat] || { label: cat, icon: '📦' }
                            const actual = actualCosts[cat] || 0
                            const diff = actual - (est as number)
                            return (
                              <div key={cat} className="px-5 py-3 grid grid-cols-[1fr_auto_auto_auto] gap-4 items-center">
                                <span className="text-slate-600 text-sm flex items-center gap-2"><span>{meta.icon}</span>{meta.label}</span>
                                <span className="text-slate-400 text-xs text-right">{formatMoney(est as number)} est.</span>
                                <div className="flex items-center gap-1">
                                  <span className="text-slate-400 text-xs">$</span>
                                  <input
                                    type="number"
                                    min="0"
                                    placeholder="0"
                                    value={actual || ''}
                                    onChange={e => updateActualCost(cat, parseFloat(e.target.value) || 0)}
                                    className="w-24 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1 text-sm text-slate-700 focus:outline-none focus:border-blue-400 text-right"
                                  />
                                </div>
                                {actual > 0 && (
                                  <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${diff <= 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                                    {diff <= 0 ? '-' : '+'}{formatMoney(Math.abs(diff))}
                                  </span>
                                )}
                                {actual === 0 && <div />}
                              </div>
                            )
                          })}
                        </div>
                        {Object.values(actualCosts).some(v => v > 0) && (() => {
                          const totalActual = Object.values(actualCosts).reduce((s, v) => s + v, 0)
                          return (
                            <div className="px-5 py-3 flex justify-between items-center bg-slate-50/60 border-t" style={{ borderColor: 'rgba(219,234,254,0.7)' }}>
                              <span className="text-slate-600 text-sm font-bold">Total Actual Materials</span>
                              <span className="text-slate-800 font-black">{formatMoney(totalActual)}</span>
                            </div>
                          )
                        })()}
                      </div>

                      {/* ── Final summary ── */}
                      <div className="bg-white rounded-2xl overflow-hidden" style={cardStyle}>
                        <div className="px-5 py-4 border-b" style={{ borderColor: 'rgba(219,234,254,0.7)' }}>
                          <span className="text-slate-800 font-bold">Project Cost Summary</span>
                        </div>
                        {[
                          { label: 'Materials',      value: matTotal,   color: 'bg-blue-500',   icon: '🪵' },
                          { label: 'Labor',          value: laborTotal, color: 'bg-purple-500', icon: '👷' },
                          { label: 'Overhead (10%)', value: overhead,   color: 'bg-slate-400',  icon: '📊' },
                          { label: `Markup (${estimate.markup_pct || 15}%)`, value: markupAmt, color: 'bg-amber-500', icon: '💼' },
                        ].map(row => (
                          <div key={row.label} className="px-5 py-3.5 border-b last:border-0 flex justify-between items-center" style={{ borderColor: 'rgba(219,234,254,0.5)' }}>
                            <span className="text-slate-600 text-sm flex items-center gap-2"><span>{row.icon}</span>{row.label}</span>
                            <span className="text-slate-800 font-bold">{formatMoney(row.value)}</span>
                          </div>
                        ))}

                        {/* Markup control */}
                        <div className="px-5 py-4 bg-slate-50/60 border-t flex items-center justify-between" style={{ borderColor: 'rgba(219,234,254,0.7)' }}>
                          <span className="text-slate-500 text-sm">Adjust Markup %</span>
                          <div className="flex items-center gap-2">
                            <input
                              type="number" min={0} max={100} value={markup}
                              onChange={e => setMarkup(Number(e.target.value))}
                              className="w-16 bg-white border rounded-lg px-2 py-1 text-sm text-slate-700 text-right focus:outline-none focus:border-blue-400"
                              style={{ borderColor: 'rgba(219,234,254,0.9)' }}
                            />
                            <span className="text-slate-400 text-sm">%</span>
                            <button onClick={handleMarkupUpdate} className="text-xs text-white bg-blue-600 hover:bg-blue-700 font-semibold px-3 py-1.5 rounded-lg transition-all">Apply</button>
                          </div>
                        </div>

                        <div className="px-5 py-5 flex justify-between items-center bg-blue-50 border-t" style={{ borderColor: 'rgba(219,234,254,0.9)' }}>
                          <span className="text-slate-800 font-black text-base">Grand Total</span>
                          <span className="text-blue-600 font-black text-2xl">{formatMoney(grand)}</span>
                        </div>
                        <div className="px-5 py-4 flex justify-between items-center border-t" style={{ borderColor: 'rgba(219,234,254,0.7)' }}>
                          <span className="text-slate-500 text-sm">Customer Proposal</span>
                          <button
                            onClick={() => setShowProposal(true)}
                            className="flex items-center gap-2 text-white font-bold px-4 py-2 rounded-xl text-sm transition-all hover:scale-[1.02]"
                            style={{ background: 'linear-gradient(135deg, #7c3aed, #5b21b6)', boxShadow: '0 4px 14px rgba(124,58,237,0.2)' }}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                            Generate Proposal
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                })()}
              </div>
            )}

            {/* ── 3D VIEW ───────────────────────────────────────────────── */}
            {tab === 'view3d' && (
              <div className="max-w-5xl space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-slate-800 font-bold text-lg">3D Floor Plan</h2>
                    <p className="text-slate-400 text-xs mt-0.5">
                      {sceneData
                        ? `Claude Vision parsed · ${sceneData.walls?.length || 0} walls · ${sceneData.rooms?.length || 0} rooms · ${sceneData.electrical?.length || 0} electrical · ${sceneData.plumbing?.length || 0} plumbing`
                        : 'Generate a 3D model from the uploaded blueprint using Claude Vision.'}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    {sceneData && (
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                          ✓ Vision Parsed · {Math.round((sceneData.confidence || 0) * 100)}% confidence
                        </span>
                      </div>
                    )}
                    <button
                      onClick={handleGenerate3D}
                      disabled={scene3dLoading || !hasBlueprint}
                      title={!hasBlueprint ? 'Upload a blueprint first' : 'Parse blueprint with Claude Vision'}
                      className="flex items-center gap-2 text-white font-bold px-4 py-2 rounded-xl text-sm transition-all disabled:opacity-40 hover:scale-[1.02]"
                      style={{ background: scene3dLoading ? '#94a3b8' : 'linear-gradient(135deg, #6366f1, #4f46e5)', boxShadow: '0 4px 14px rgba(99,102,241,0.3)' }}
                    >
                      {scene3dLoading
                        ? <><svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg> Analyzing Blueprint…</>
                        : sceneData ? '🔄 Re-generate 3D' : '✦ Generate 3D Model'}
                    </button>
                  </div>
                </div>

                {scene3dError && (
                  <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-red-700 text-sm">{scene3dError}</div>
                )}



                {analysis ? (
                  <>
                    <Blueprint3DViewer analysis={analysis} sceneData={sceneData} />
                    {analysis.rooms?.length > 0 && (
                      <div className="bg-white rounded-2xl p-5" style={{ boxShadow: '0 2px 12px rgba(59,130,246,0.08)', border: '1px solid rgba(219,234,254,0.8)' }}>
                        <h3 className="text-slate-800 font-bold text-sm mb-3">Rooms Detected</h3>
                        <div className="grid grid-cols-3 gap-3">
                          {(sceneData?.rooms?.length > 0 ? sceneData.rooms : analysis.rooms).map((room: any, i: number) => {
                            const colors = ['bg-blue-50 border-blue-200','bg-green-50 border-green-200','bg-yellow-50 border-yellow-200','bg-rose-50 border-rose-200','bg-purple-50 border-purple-200','bg-cyan-50 border-cyan-200','bg-orange-50 border-orange-200','bg-emerald-50 border-emerald-200']
                            return (
                              <div key={i} className={`rounded-xl border p-3 ${colors[i % colors.length]}`}>
                                <div className="text-slate-800 font-semibold text-sm">{room.name}</div>
                                <div className="text-slate-500 text-xs mt-0.5">{room.sqft ? `${Math.round(room.sqft)} sqft` : '—'}</div>
                                {(room.dimensions || room.width) && (
                                  <div className="text-slate-400 text-xs">{(room.dimensions?.width || room.width)?.toFixed(0)}′ × {(room.dimensions?.height || room.depth)?.toFixed(0)}′</div>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="bg-white rounded-2xl p-12 text-center text-slate-400" style={{ boxShadow: '0 2px 12px rgba(59,130,246,0.08)', border: '1px solid rgba(219,234,254,0.8)' }}>
                    Run a blueprint analysis first to generate the 3D view.
                  </div>
                )}
              </div>
            )}

            {/* ── PHOTOS ──────────────────────────────────────────────── */}
            {tab === 'photos' && (
              <div className="max-w-5xl">
                <div className="flex items-center justify-between mb-5">
                  <div>
                    <h2 className="text-slate-800 font-bold text-lg">Job Photos</h2>
                    <p className="text-slate-400 text-xs mt-0.5">{photos.length} photo{photos.length !== 1 ? 's' : ''} — before, during, and after documentation</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {(['before', 'during', 'after'] as const).map(phase => (
                      <label key={phase} className="relative cursor-pointer">
                        <input
                          type="file"
                          multiple
                          accept="image/*"
                          className="sr-only"
                          onChange={e => handlePhotoUpload(phase, e.target.files)}
                        />
                        <span className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all border ${
                          phase === 'before' ? 'bg-blue-600 text-white border-blue-600 hover:bg-blue-700' :
                          phase === 'during' ? 'bg-amber-500 text-white border-amber-500 hover:bg-amber-600' :
                          'bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700'
                        }`}>
                          {uploadingPhoto ? <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg> : '+'} {phase.charAt(0).toUpperCase() + phase.slice(1)}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>

                {/* Phase filter */}
                <div className="flex gap-2 mb-5">
                  {(['all', 'before', 'during', 'after'] as const).map(p => {
                    const count = p === 'all' ? photos.length : photos.filter(ph => ph.phase === p).length
                    const colors: Record<string, string> = { all: 'bg-blue-600 text-white border-blue-600', before: 'bg-blue-600 text-white border-blue-600', during: 'bg-amber-500 text-white border-amber-500', after: 'bg-emerald-600 text-white border-emerald-600' }
                    return (
                      <button key={p} onClick={() => setPhotoPhase(p)}
                        className={`text-xs px-3 py-1.5 rounded-full font-semibold border transition-all capitalize ${photoPhase === p ? colors[p] : 'bg-white text-slate-500 border-slate-200 hover:border-blue-300'}`}>
                        {p === 'all' ? 'All' : p.charAt(0).toUpperCase() + p.slice(1)} ({count})
                      </button>
                    )
                  })}
                </div>

                {/* Photo grid */}
                {(() => {
                  const displayed = photoPhase === 'all' ? photos : photos.filter(p => p.phase === photoPhase)
                  if (displayed.length === 0) return (
                    <div className="bg-white rounded-2xl p-16 text-center" style={cardStyle}>
                      <div className="text-5xl mb-4">📸</div>
                      <div className="text-slate-700 font-semibold mb-1">No photos yet</div>
                      <div className="text-slate-400 text-sm">Upload before, during, and after photos using the buttons above.</div>
                    </div>
                  )
                  return (
                    <div className="columns-2 sm:columns-3 lg:columns-4 gap-3 space-y-3">
                      {displayed.map((photo: any) => {
                        const phaseColors: Record<string, string> = { before: 'bg-blue-500', during: 'bg-amber-500', after: 'bg-emerald-500' }
                        return (
                          <div key={photo.id} className="relative group break-inside-avoid bg-white rounded-2xl overflow-hidden cursor-pointer" style={cardStyle} onClick={() => setSelectedPhoto(photo)}>
                            <img src={photo.url} alt={photo.filename} className="w-full object-cover" />
                            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-all flex items-end p-2">
                              <div className="flex items-center justify-between w-full opacity-0 group-hover:opacity-100 transition-all">
                                <span className={`text-[10px] font-bold text-white px-2 py-0.5 rounded-full capitalize ${phaseColors[photo.phase] || 'bg-slate-500'}`}>{photo.phase}</span>
                                <button
                                  onClick={e => { e.stopPropagation(); handleDeletePhoto(photo) }}
                                  className="p-1.5 bg-red-500 hover:bg-red-600 text-white rounded-lg transition-all"
                                >
                                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>
                                </button>
                              </div>
                            </div>
                            <div className="px-3 py-2">
                              <div className="text-slate-500 text-[10px] truncate">{photo.filename}</div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )
                })()}

                {/* Photo-to-Measurements */}
                <div className="mt-6 bg-white rounded-2xl p-5" style={cardStyle}>
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <h3 className="text-slate-800 font-bold text-sm">AI Measurement Estimate</h3>
                      <p className="text-slate-400 text-xs mt-0.5">Claude Vision analyzes your photos to estimate wall area, roof area, and dimensions.</p>
                    </div>
                    <button
                      onClick={handlePhotoMeasure}
                      disabled={photoMeasureLoading || photos.length === 0}
                      title={photos.length === 0 ? 'Upload at least one photo first' : ''}
                      className="flex items-center gap-2 text-white font-bold px-4 py-2 rounded-xl text-sm transition-all disabled:opacity-40 hover:scale-[1.02]"
                      style={{ background: photoMeasureLoading ? '#94a3b8' : 'linear-gradient(135deg, #2563eb, #1e40af)', boxShadow: '0 4px 14px rgba(37,99,235,0.25)' }}
                    >
                      {photoMeasureLoading ? (
                        <><svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg> Analyzing…</>
                      ) : '📐 Measure from Photos'}
                    </button>
                  </div>
                  {photoMeasureError && (
                    <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-xl">{photoMeasureError}</div>
                  )}
                  {photoMeasureResult && (
                    <div>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                        {[
                          { label: 'Total Sqft',     value: `${(photoMeasureResult.total_sqft || 0).toLocaleString()} sqft` },
                          { label: 'Wall Area',      value: `${(photoMeasureResult.wall_area_sqft || 0).toLocaleString()} sqft` },
                          { label: 'Roof Area',      value: `${(photoMeasureResult.roof_area_sqft || 0).toLocaleString()} sqft` },
                          { label: 'Perimeter',      value: `${photoMeasureResult.perimeter_ft || 0} ft` },
                          { label: 'Stories',        value: photoMeasureResult.stories || '—' },
                          { label: 'Wall Height',    value: `${photoMeasureResult.wall_height_ft || '—'} ft` },
                          { label: 'Photos Used',    value: photoMeasureResult.photo_count || photos.length },
                          { label: 'Confidence',     value: `${Math.round((photoMeasureResult.confidence || 0) * 100)}%` },
                        ].map(s => (
                          <div key={s.label} className="bg-blue-50 rounded-xl p-3">
                            <div className="text-blue-800 font-black text-lg">{s.value}</div>
                            <div className="text-blue-500 text-xs mt-0.5">{s.label}</div>
                          </div>
                        ))}
                      </div>
                      {photoMeasureResult.structure_type && (
                        <div className="text-slate-500 text-xs mb-2"><span className="font-semibold text-slate-700">Structure:</span> {photoMeasureResult.structure_type}</div>
                      )}
                      {photoMeasureResult.dimensions && (
                        <div className="text-slate-500 text-xs mb-2"><span className="font-semibold text-slate-700">Est. Dimensions:</span> ~{photoMeasureResult.dimensions.estimated_width_ft}ft wide × {photoMeasureResult.dimensions.estimated_depth_ft}ft deep</div>
                      )}
                      {photoMeasureResult.notes && (
                        <div className="text-slate-500 text-xs mb-2 italic">{photoMeasureResult.notes}</div>
                      )}
                      {photoMeasureResult.warnings?.length > 0 && (
                        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 mt-2">
                          {photoMeasureResult.warnings.map((w: string, i: number) => (
                            <div key={i} className="text-amber-700 text-xs flex items-start gap-1.5"><span className="mt-0.5">⚠</span>{w}</div>
                          ))}
                        </div>
                      )}
                      <p className="text-slate-400 text-[10px] mt-3">AI estimates only — verify all measurements on-site before ordering materials.</p>
                    </div>
                  )}
                  {!photoMeasureResult && !photoMeasureError && !photoMeasureLoading && (
                    <div className="text-center py-6 text-slate-400 text-sm">
                      {photos.length === 0
                        ? 'Upload photos above, then click "Measure from Photos" to get AI estimates.'
                        : `${photos.length} photo${photos.length > 1 ? 's' : ''} ready — click "Measure from Photos" to extract dimensions.`}
                    </div>
                  )}
                </div>

                {/* Lightbox */}
                {selectedPhoto && (
                  <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.85)' }} onClick={() => setSelectedPhoto(null)}>
                    <div className="max-w-4xl max-h-full relative" onClick={e => e.stopPropagation()}>
                      <img src={selectedPhoto.url} alt={selectedPhoto.filename} className="max-w-full max-h-[85vh] object-contain rounded-2xl" />
                      <div className="flex items-center justify-between mt-3">
                        <span className="text-white/60 text-sm">{selectedPhoto.filename}</span>
                        <button onClick={() => setSelectedPhoto(null)} className="text-white/70 hover:text-white text-sm font-semibold">Close ✕</button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ── COMPLIANCE ────────────────────────────────────────────── */}
            {tab === 'compliance' && (
              <div className="max-w-3xl">
                <div className="flex justify-end mb-4">
                  <button
                    onClick={handleMaterialsComplianceCheck}
                    disabled={matCheckLoading || !project?.city}
                    className="flex items-center gap-2 px-4 py-2 rounded-xl text-white text-sm font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{ background: matCheckLoading ? '#94a3b8' : 'linear-gradient(135deg, #7c3aed, #5b21b6)', boxShadow: '0 4px 14px rgba(124,58,237,0.25)' }}
                    title={!project?.city ? 'Add a city to the project first' : ''}
                  >
                    {matCheckLoading ? (
                      <><svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>Checking…</>
                    ) : '⚖ Check Code Compliance'}
                  </button>
                </div>
                {!compliance || compliance.status === 'not_run' ? (
                  <div className="bg-white rounded-2xl p-12 text-center" style={cardStyle}>
                    <div className="text-5xl mb-4">⚖️</div>
                    <div className="text-slate-800 font-semibold mb-2">No compliance check run</div>
                    <div className="text-slate-400 text-sm">Runs automatically when your blueprint is analyzed.</div>
                  </div>
                ) : compliance.status === 'processing' || compliance.status === 'pending' ? (
                  <div className="bg-white rounded-2xl p-12 text-center" style={cardStyle}>
                    <svg className="animate-spin text-blue-500 mx-auto mb-4" width="28" height="28" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>
                    <div className="text-slate-400 text-sm">Analyzing building codes and requirements…</div>
                  </div>
                ) : compliance.status === 'complete' ? (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className="text-slate-800 font-bold">{compliance.city ? `${compliance.city}, ` : ''}{compliance.region}</span>
                        {compliance.risk_level && (
                          <span className={`text-xs px-2.5 py-1 rounded-full font-semibold capitalize border ${RISK_BANNER[compliance.risk_level]}`}>
                            {compliance.risk_level} risk
                          </span>
                        )}
                      </div>
                      <span className="text-slate-400 text-xs">{compliance.items.length} items</span>
                    </div>
                    <div className="flex gap-2 flex-wrap">
                      {(['all', 'required', 'recommended', 'info'] as const).map(f => (
                        <button key={f} onClick={() => setComplianceFilter(f)}
                          className={`text-xs px-3 py-1.5 rounded-full font-semibold transition-all capitalize border ${complianceFilter === f ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-500 border-slate-200 hover:border-blue-300'}`}>
                          {f === 'all' ? `All (${compliance.items.length})` :
                           f === 'required' ? `Required (${requiredCount})` :
                           f === 'recommended' ? `Recommended (${recommendedCount})` :
                           `Info (${compliance.items.filter(i => i.severity === 'info').length})`}
                        </button>
                      ))}
                    </div>
                    {Object.entries(complianceByCategory).map(([category, items]) => (
                      <div key={category}>
                        <div className="flex items-center gap-2 mb-2 mt-4">
                          <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">{category}</span>
                          <span className="text-xs text-slate-300">({items.length})</span>
                        </div>
                        <div className="space-y-2">
                          {items.map(item => (
                            <div key={item.id} className="bg-white rounded-xl overflow-hidden cursor-pointer transition-all hover:shadow-sm" style={cardStyle}
                              onClick={() => setExpandedItem(expandedItem === item.id ? null : item.id)}>
                              <div className="px-4 py-3.5 flex items-start gap-3">
                                <div className={`w-2 h-2 rounded-full mt-2 flex-shrink-0 ${SEVERITY[item.severity].dot}`} />
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-start justify-between gap-3">
                                    <span className="text-slate-800 text-sm font-medium leading-snug">{item.title}</span>
                                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold flex-shrink-0 capitalize ${SEVERITY[item.severity].badge}`}>{SEVERITY[item.severity].label}</span>
                                  </div>
                                </div>
                                <svg className={`flex-shrink-0 text-slate-400 transition-transform mt-0.5 ${expandedItem === item.id ? 'rotate-180' : ''}`} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="6 9 12 15 18 9"/></svg>
                              </div>
                              {expandedItem === item.id && (
                                <div className="px-4 pb-4 border-t pt-3 space-y-3" style={{ borderColor: 'rgba(219,234,254,0.7)' }}>
                                  <p className="text-slate-500 text-sm leading-relaxed">{item.description}</p>
                                  {item.action && (
                                    <div className="bg-blue-50 border border-blue-100 rounded-xl px-4 py-3">
                                      <div className="text-[10px] font-bold text-blue-600 uppercase tracking-wider mb-1">Action Required</div>
                                      <p className="text-slate-700 text-xs">{item.action}</p>
                                    </div>
                                  )}
                                  <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-400">
                                    {item.deadline && <span>⏱ {item.deadline}</span>}
                                    {item.penalty && <span>⚠️ {item.penalty}</span>}
                                    {item.source && <span>📖 {item.source}</span>}
                                  </div>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                    {Object.keys(complianceByCategory).length === 0 && (
                      <div className="text-center py-8 text-slate-400 text-sm">No items match this filter.</div>
                    )}
                  </div>
                ) : (
                  <div className="bg-white rounded-2xl p-12 text-center text-red-500" style={cardStyle}>Compliance check failed.</div>
                )}

                {/* ── MATERIALS CODE CHECK RESULTS ──────────────────────── */}
                {(matCheckResult || matCheckLoading || matCheckError) && (
                  <div className="mt-6">
                    {matCheckLoading && (
                      <div className="bg-white rounded-2xl p-8 text-center" style={cardStyle}>
                        <svg className="animate-spin text-purple-500 mx-auto mb-3" width="24" height="24" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>
                        <div className="text-slate-600 text-sm font-medium mb-1">Checking materials against local codes…</div>
                        <div className="text-slate-400 text-xs">Pulling {project?.city} building codes and cross-referencing your materials list</div>
                      </div>
                    )}

                    {matCheckError && (
                      <div className="bg-red-50 border border-red-200 rounded-2xl p-4 text-red-600 text-sm">{matCheckError}</div>
                    )}

                    {matCheckResult && (() => {
                      const checklist: any[] = matCheckResult.checklist || []
                      const missing: any[] = matCheckResult.missing_required_items || []
                      const passCount = checklist.filter((c: any) => c.status === 'pass').length
                      const failCount = checklist.filter((c: any) => c.status === 'fail').length
                      const warnCount = checklist.filter((c: any) => c.status === 'warning').length
                      const loc = matCheckResult.location
                      const locationStr = [loc?.city, loc?.county, loc?.state].filter(Boolean).join(', ')

                      return (
                        <div className="space-y-4">
                          {/* Header */}
                          <div className="bg-white rounded-2xl px-5 py-4" style={cardStyle}>
                            <div className="flex items-start justify-between gap-4 mb-3">
                              <div>
                                <div className="flex items-center gap-2 mb-1">
                                  <span className="text-slate-800 font-bold text-sm">Materials Code Compliance</span>
                                  <span className={`text-xs px-2.5 py-0.5 rounded-full font-semibold border capitalize ${
                                    matCheckResult.overall_status === 'pass' ? 'bg-emerald-50 border-emerald-200 text-emerald-700' :
                                    matCheckResult.overall_status === 'warning' ? 'bg-amber-50 border-amber-200 text-amber-700' :
                                    'bg-red-50 border-red-200 text-red-700'
                                  }`}>{matCheckResult.overall_status}</span>
                                </div>
                                {locationStr && <div className="text-slate-400 text-xs">{locationStr} · {matCheckResult.project_type}</div>}
                              </div>
                              <div className="flex gap-3 text-center flex-shrink-0">
                                <div><div className="text-emerald-600 font-bold text-lg leading-none">{passCount}</div><div className="text-slate-400 text-[10px] mt-0.5">Pass</div></div>
                                {warnCount > 0 && <div><div className="text-amber-500 font-bold text-lg leading-none">{warnCount}</div><div className="text-slate-400 text-[10px] mt-0.5">Warn</div></div>}
                                <div><div className="text-red-500 font-bold text-lg leading-none">{failCount + missing.length}</div><div className="text-slate-400 text-[10px] mt-0.5">Fail</div></div>
                              </div>
                            </div>
                            {matCheckResult.summary && <p className="text-slate-500 text-sm leading-relaxed border-t pt-3" style={{ borderColor: 'rgba(219,234,254,0.6)' }}>{matCheckResult.summary}</p>}
                          </div>

                          {/* Per-material checklist */}
                          {checklist.length > 0 && (
                            <div className="space-y-2">
                              <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Materials Checklist ({checklist.length} items)</div>
                              {checklist.map((item: any, i: number) => {
                                const isFail = item.status === 'fail'
                                const isWarn = item.status === 'warning'
                                const isPass = item.status === 'pass'
                                return (
                                  <div key={i} className={`bg-white rounded-xl overflow-hidden`} style={{
                                    boxShadow: isFail ? '0 2px 12px rgba(239,68,68,0.08)' : isWarn ? '0 2px 12px rgba(245,158,11,0.08)' : '0 2px 8px rgba(59,130,246,0.06)',
                                    border: isFail ? '1px solid rgba(254,202,202,0.9)' : isWarn ? '1px solid rgba(253,230,138,0.9)' : '1px solid rgba(167,243,208,0.7)',
                                  }}>
                                    <div className="px-4 py-3 flex items-start gap-3">
                                      {/* Status icon */}
                                      <div className="flex-shrink-0 mt-0.5">
                                        {isPass && (
                                          <div className="w-5 h-5 rounded-full bg-emerald-100 flex items-center justify-center">
                                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="3" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                                          </div>
                                        )}
                                        {isFail && (
                                          <div className="w-5 h-5 rounded-full bg-red-100 flex items-center justify-center">
                                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="3" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                                          </div>
                                        )}
                                        {isWarn && (
                                          <div className="w-5 h-5 rounded-full bg-amber-100 flex items-center justify-center">
                                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="3" strokeLinecap="round"><path d="M12 9v4M12 17h.01"/></svg>
                                          </div>
                                        )}
                                      </div>
                                      <div className="flex-1 min-w-0">
                                        <div className="flex items-start justify-between gap-2">
                                          <span className="text-slate-800 text-sm font-semibold">{item.item_name}</span>
                                          {item.category && <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 font-medium flex-shrink-0 capitalize">{item.category}</span>}
                                        </div>
                                        {isPass && item.note && <p className="text-slate-500 text-xs mt-0.5">{item.note}</p>}
                                        {isPass && item.code_reference && <p className="text-emerald-600 text-[10px] mt-0.5 font-medium">{item.code_reference}</p>}
                                        {(isFail || isWarn) && item.rule_text && (
                                          <blockquote className={`mt-2 pl-3 border-l-2 text-slate-500 text-xs italic leading-relaxed ${isFail ? 'border-red-300' : 'border-amber-300'}`}>{item.rule_text}</blockquote>
                                        )}
                                        {(isFail || isWarn) && item.violation_reason && (
                                          <p className="mt-1.5 text-slate-600 text-xs">{item.violation_reason}</p>
                                        )}
                                        {(isFail || isWarn) && item.fix_suggestion && (
                                          <div className="mt-2 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2">
                                            <span className="text-[10px] font-bold text-blue-600 uppercase tracking-wider">Fix: </span>
                                            <span className="text-slate-700 text-xs">{item.fix_suggestion}</span>
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                )
                              })}
                            </div>
                          )}

                          {/* Missing required items */}
                          {missing.length > 0 && (
                            <div>
                              <div className="text-xs font-bold text-amber-600 uppercase tracking-wider mb-2">Missing Required Items ({missing.length})</div>
                              <div className="space-y-2">
                                {missing.map((m: any, i: number) => (
                                  <div key={i} className="bg-white rounded-xl px-4 py-3 flex items-start gap-3" style={{ boxShadow: '0 2px 12px rgba(245,158,11,0.08)', border: '1px solid rgba(253,230,138,0.9)' }}>
                                    <div className="w-5 h-5 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0 mt-0.5">
                                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="3" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                                    </div>
                                    <div className="flex-1">
                                      <span className="text-slate-800 text-sm font-semibold">{m.item_name}</span>
                                      {m.rule_text && <blockquote className="mt-1.5 pl-3 border-l-2 border-amber-300 text-slate-500 text-xs italic leading-relaxed">{m.rule_text}</blockquote>}
                                      {m.reason_required && <p className="mt-1 text-slate-500 text-xs">{m.reason_required}</p>}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    })()}
                  </div>
                )}
              </div>
            )}

            {/* ── PERMITS ───────────────────────────────────────────────── */}
            {tab === 'permits' && (
              <div className="max-w-2xl space-y-5">
                <div>
                  <h2 className="text-slate-800 font-bold text-lg">Permit Applications</h2>
                  <p className="text-slate-400 text-xs mt-0.5">Find and submit your building permit for {project?.city ? `${project.city}, ` : ''}{project?.region}</p>
                </div>
                <PermitPortalSection project={project} projectId={projectId} />
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── PROPOSAL MODAL ── */}
      {showProposal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(15,23,42,0.5)', backdropFilter: 'blur(6px)' }}>
          <div className="bg-white rounded-2xl w-full max-w-2xl shadow-2xl max-h-[90vh] overflow-y-auto" style={{ border: '1px solid rgba(219,234,254,0.8)' }}>
            <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: 'rgba(219,234,254,0.8)' }}>
              <div>
                <h2 className="text-lg font-bold text-slate-800">Customer Proposal</h2>
                <p className="text-slate-400 text-xs mt-0.5">Print or save as PDF to share with your client</p>
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => window.print()}
                  className="flex items-center gap-2 text-white font-bold px-4 py-2 rounded-xl text-sm transition-all"
                  style={{ background: 'linear-gradient(135deg, #3b82f6, #1d4ed8)', boxShadow: '0 4px 14px rgba(59,130,246,0.3)' }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
                  Print / Save PDF
                </button>
                <button onClick={() => setShowProposal(false)} className="text-slate-400 hover:text-slate-700 text-xl leading-none">✕</button>
              </div>
            </div>

            {/* Proposal content */}
            <div id="proposal-content" className="p-8 space-y-6">
              {/* Header */}
              <div className="text-center border-b pb-6" style={{ borderColor: 'rgba(219,234,254,0.8)' }}>
                <div className="text-3xl font-black text-blue-600 mb-1">Project Proposal</div>
                <div className="text-xl font-bold text-slate-800">{project?.name}</div>
                <div className="text-slate-400 text-sm mt-1">
                  {project?.city && `${project.city}, `}{project?.region?.replace('US-', '')} · {new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                </div>
              </div>

              {/* Project Overview */}
              <div>
                <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Project Overview</div>
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { label: 'Project Type', value: project?.blueprint_type || 'Residential' },
                    { label: 'Location', value: [project?.city, project?.region?.replace('US-','')].filter(Boolean).join(', ') || '—' },
                    { label: 'Total Area', value: analysis?.total_sqft ? `${analysis.total_sqft.toLocaleString()} sq ft` : '—' },
                    { label: 'Rooms', value: analysis?.rooms?.length || '—' },
                  ].map(row => (
                    <div key={row.label} className="bg-slate-50 rounded-xl p-3">
                      <div className="text-slate-400 text-xs">{row.label}</div>
                      <div className="text-slate-800 font-bold text-sm mt-0.5">{row.value}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Scope of Work */}
              {analysis?.rooms?.length > 0 && (
                <div>
                  <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Scope of Work</div>
                  <div className="bg-slate-50 rounded-xl p-4">
                    <div className="grid grid-cols-3 gap-2">
                      {analysis.rooms.slice(0, 9).map((room: any, i: number) => (
                        <div key={i} className="text-slate-600 text-sm">{room.name}{room.sqft ? ` (${Math.round(room.sqft)} sqft)` : ''}</div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Materials Summary */}
              {materials.length > 0 && (
                <div>
                  <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Materials Summary</div>
                  <div className="space-y-1">
                    {Object.entries(categoryTotals).sort((a, b) => b[1] - a[1]).map(([cat, total]) => {
                      const meta = CATEGORY_META[cat] || { label: cat, icon: '📦' }
                      return (
                        <div key={cat} className="flex justify-between items-center py-2 border-b" style={{ borderColor: 'rgba(219,234,254,0.6)' }}>
                          <span className="text-slate-600 text-sm flex items-center gap-2"><span>{meta.icon}</span>{meta.label}</span>
                          <span className="text-slate-800 font-semibold text-sm">{formatMoney(total as number)}</span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* Investment Summary */}
              {estimate && (() => {
                const matTotal = estimate.materials_total || 0
                const laborTotal = estimate.labor_total || 0
                const overhead = (matTotal + laborTotal) * 0.10
                const markupAmt = (matTotal + laborTotal + overhead) * ((estimate.markup_pct || 15) / 100)
                const grand = matTotal + laborTotal + overhead + markupAmt
                return (
                  <div>
                    <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Investment Summary</div>
                    <div className="bg-blue-600 rounded-2xl p-6 text-white text-center">
                      <div className="text-blue-100 text-sm mb-1">Total Project Investment</div>
                      <div className="text-4xl font-black">{formatMoney(grand)}</div>
                      <div className="flex justify-center gap-4 text-blue-200 text-xs mt-2">
                        <span>Materials: {formatMoney(matTotal)}</span>
                        <span>·</span>
                        <span>Labor: {formatMoney(laborTotal)}</span>
                      </div>
                    </div>
                  </div>
                )
              })()}

              {/* Footer */}
              <div className="text-center text-slate-400 text-xs pt-4 border-t" style={{ borderColor: 'rgba(219,234,254,0.8)' }}>
                This proposal is an estimate based on AI-powered blueprint analysis. Final pricing may vary based on site conditions, material availability, and local market rates.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Quote Request Modal */}
      {quoteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(15,23,42,0.6)', backdropFilter: 'blur(6px)' }} onClick={() => setQuoteModal(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: 'rgba(219,234,254,0.8)' }}>
              <div>
                <h2 className="text-slate-800 font-bold text-base">Quote Request — {quoteModal.vendor}</h2>
                <p className="text-slate-400 text-xs mt-0.5">Fill in your info, then copy the generated text to send to the distributor.</p>
              </div>
              <button onClick={() => setQuoteModal(null)} className="text-slate-400 hover:text-slate-700 text-lg font-light leading-none">✕</button>
            </div>
            <div className="px-6 py-5 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                {[
                  { key: 'name', label: 'Your Name', placeholder: 'John Smith' },
                  { key: 'company', label: 'Company', placeholder: 'Smith Roofing LLC' },
                  { key: 'phone', label: 'Phone', placeholder: '(555) 000-0000' },
                  { key: 'email', label: 'Email', placeholder: 'john@smithroofing.com' },
                  { key: 'branch', label: 'Preferred Branch / Location', placeholder: 'Chicago, IL branch' },
                ].map(f => (
                  <div key={f.key} className={f.key === 'branch' ? 'col-span-2' : ''}>
                    <label className="text-xs font-semibold text-slate-600 mb-1 block">{f.label}</label>
                    <input
                      value={(quoteForm as any)[f.key]}
                      onChange={e => setQuoteForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                      placeholder={f.placeholder}
                      className="w-full border rounded-xl px-3 py-2 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-blue-300"
                      style={{ borderColor: 'rgba(219,234,254,0.9)' }}
                    />
                  </div>
                ))}
                <div className="col-span-2">
                  <label className="text-xs font-semibold text-slate-600 mb-1 block">Additional Notes</label>
                  <textarea
                    value={quoteForm.notes}
                    onChange={e => setQuoteForm(prev => ({ ...prev, notes: e.target.value }))}
                    placeholder="Delivery requirements, timeline, special requests…"
                    rows={2}
                    className="w-full border rounded-xl px-3 py-2 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-blue-300 resize-none"
                    style={{ borderColor: 'rgba(219,234,254,0.9)' }}
                  />
                </div>
              </div>
              <div>
                <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Items ({quoteModal.items.length})</div>
                <div className="bg-slate-50 rounded-xl px-4 py-3 max-h-36 overflow-y-auto space-y-1">
                  {quoteModal.items.map((m: any, i: number) => (
                    <div key={i} className="flex justify-between text-xs text-slate-600">
                      <span className="truncate max-w-[60%]">{m.item_name}</span>
                      <span className="text-slate-400 ml-2">{m.quantity} {m.unit}</span>
                    </div>
                  ))}
                </div>
              </div>
              {!quoteGenerated ? (
                <button
                  onClick={() => setQuoteGenerated(true)}
                  className="w-full flex items-center justify-center gap-2 text-white font-bold py-3 rounded-xl text-sm transition-all"
                  style={{ background: 'linear-gradient(135deg, #f59e0b, #d97706)', boxShadow: '0 4px 14px rgba(245,158,11,0.3)' }}
                >
                  📋 Generate Quote Request
                </button>
              ) : (
                <div>
                  <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Quote Request Text</div>
                  <pre className="bg-slate-900 text-green-400 text-xs rounded-xl p-4 overflow-x-auto whitespace-pre-wrap font-mono leading-relaxed">{generateQuoteText()}</pre>
                  <div className="flex gap-2 mt-3">
                    <button
                      onClick={() => { navigator.clipboard.writeText(generateQuoteText()); setQuoteCopied(true); setTimeout(() => setQuoteCopied(false), 2000) }}
                      className={`flex-1 flex items-center justify-center gap-2 font-bold py-2.5 rounded-xl text-sm transition-all ${quoteCopied ? 'bg-emerald-600 text-white' : 'bg-slate-800 hover:bg-slate-900 text-white'}`}
                    >
                      {quoteCopied ? '✓ Copied!' : '📋 Copy to Clipboard'}
                    </button>
                    <a
                      href={quoteModal.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-bold bg-amber-500 hover:bg-amber-600 text-white transition-all"
                    >
                      Open {quoteModal.vendor}
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                    </a>
                  </div>
                  <p className="text-slate-400 text-[10px] mt-2 text-center">Copy this text and paste it into an email or the distributor's quote request form.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
