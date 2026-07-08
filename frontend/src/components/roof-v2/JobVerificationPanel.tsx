'use client'

/**
 * JobVerificationPanel — the accuracy flywheel + report branding, on the
 * report step.
 *
 * 1. Job verification: after the crew measures the roof for real, the
 *    contractor enters the actual squares. Axis snapshots its prediction and
 *    builds calibration stats — the honest "measured within X% across N
 *    verified jobs" number that goes on reports (and eventually marketing).
 *
 * 2. Report branding: company name / license / phone / logo that appear at
 *    the top of every generated report (white-label).
 */
import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'

import { api } from '@/lib/api'
import type { ContractorProfile } from '@/types'

interface Props {
  runId: string
  userId: string
  predictedSquares?: number | null
}

type Calibration = { jobs: number; mean_abs_pct_error?: number; median_abs_pct_error?: number; bias_pct?: number }

export default function JobVerificationPanel({ runId, userId, predictedSquares }: Props) {
  // ---- actuals ----
  const [actualSquares, setActualSquares] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [calibration, setCalibration] = useState<Calibration | null>(null)

  // ---- branding ----
  const [brandOpen, setBrandOpen] = useState(false)
  const [profile, setProfile] = useState<Partial<ContractorProfile>>({})
  const [brandSaving, setBrandSaving] = useState(false)
  const [logoUploading, setLogoUploading] = useState(false)

  const uploadLogo = useCallback(async (file: File) => {
    setLogoUploading(true)
    try {
      const res = await api.contractorProfile.uploadLogo(userId, file)
      setProfile(p => ({ ...p, logo_url: res.logo_url }))
      toast.success('Logo cleaned up and saved — it appears on your next report.')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not upload the logo')
    } finally {
      setLogoUploading(false)
    }
  }, [userId])

  useEffect(() => {
    void api.roofing.v2.getCalibration().then(c => setCalibration(c as Calibration)).catch(() => {})
    void api.contractorProfile.get(userId).then(p => setProfile(p || {})).catch(() => {})
  }, [userId])

  const submit = useCallback(async () => {
    const v = parseFloat(actualSquares)
    if (!Number.isFinite(v) || v <= 0) { toast.error('Enter the actual squares (e.g. 24.5)'); return }
    setSaving(true)
    try {
      const res = await api.roofing.v2.recordActuals(runId, { actual_squares: v, notes: notes || undefined })
      setResult(res.message)
      if (res.calibration) setCalibration(res.calibration)
      setActualSquares(''); setNotes('')
      toast.success('Recorded — thanks, this makes Axis more accurate.')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not record')
    } finally {
      setSaving(false)
    }
  }, [actualSquares, notes, runId])

  const saveBrand = useCallback(async () => {
    setBrandSaving(true)
    try {
      await api.contractorProfile.save(userId, profile)
      toast.success('Branding saved — it appears on your next generated report.')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save branding')
    } finally {
      setBrandSaving(false)
    }
  }, [userId, profile])

  return (
    <section className="rounded-lg border border-white/10 bg-slate-900/40 p-4 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">📏 Job verification</h3>
          <p className="text-xs text-slate-400">
            After the crew measures for real, enter the actual squares. Axis compares it against
            its prediction{predictedSquares ? <> (<strong>{predictedSquares.toFixed(1)} sq</strong> on this roof)</> : null} and
            builds your <strong>verified accuracy</strong> stat.
          </p>
        </div>
        {calibration && calibration.jobs >= 3 && calibration.mean_abs_pct_error != null && (
          <span className="rounded-md border border-emerald-400/30 bg-emerald-500/10 px-2.5 py-1.5 text-xs text-emerald-200">
            ✓ Verified within <strong>{calibration.mean_abs_pct_error.toFixed(1)}%</strong> across {calibration.jobs} jobs
          </span>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        <label className="text-slate-300">Actual roof size:</label>
        <input
          type="number" min={1} step={0.1} value={actualSquares}
          onChange={e => setActualSquares(e.target.value)}
          placeholder="e.g. 24.5"
          className="w-24 rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-white"
        />
        <span className="text-slate-500">squares</span>
        <input
          type="text" value={notes} onChange={e => setNotes(e.target.value)}
          placeholder="Notes (optional)"
          className="min-w-40 flex-1 rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-white"
        />
        <button
          onClick={submit} disabled={saving}
          className="rounded bg-blue-600 px-3 py-1.5 font-semibold text-white hover:bg-blue-500 disabled:opacity-50"
        >{saving ? 'Saving…' : 'Record'}</button>
      </div>
      {result && <p className="mt-2 text-xs text-emerald-300">{result}</p>}
      {calibration && calibration.jobs > 0 && calibration.jobs < 3 && (
        <p className="mt-2 text-[11px] text-slate-500">
          {calibration.jobs} verified job{calibration.jobs === 1 ? '' : 's'} so far — your accuracy stat appears on reports after 3.
        </p>
      )}

      {/* ---- Report branding (white-label) ---- */}
      <div className="mt-4 border-t border-white/10 pt-3">
        <button onClick={() => setBrandOpen(o => !o)} className="flex w-full items-center justify-between text-left">
          <span className="text-xs font-semibold text-slate-200">🏷 Report branding — your company on every report</span>
          <span className="text-xs text-slate-500">{brandOpen ? 'Hide' : 'Edit'}</span>
        </button>
        {brandOpen && (
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {([
              ['company_name', 'Company name'],
              ['license_number', 'License #'],
              ['phone', 'Phone'],
              ['email', 'Email'],
            ] as [keyof ContractorProfile, string][]).map(([key, label]) => (
              <label key={key} className={`text-[11px] text-slate-400 ${key === 'logo_url' ? 'sm:col-span-2' : ''}`}>
                {label}
                <input
                  type="text"
                  value={(profile[key] as string) || ''}
                  onChange={e => setProfile(p => ({ ...p, [key]: e.target.value }))}
                  className="mt-1 w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-xs text-white"
                />
              </label>
            ))}
            {/* Logo: upload a file — Axis preps it (trim, center, pad, hi-res). */}
            <div className="sm:col-span-2">
              <div className="text-[11px] text-slate-400">Company logo</div>
              <div className="mt-1 flex items-center gap-3">
                {profile.logo_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={profile.logo_url} alt="logo" className="h-10 max-w-40 rounded bg-white object-contain p-1" />
                ) : (
                  <span className="text-[11px] text-slate-500">No logo yet</span>
                )}
                <label className="cursor-pointer rounded bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-500">
                  {logoUploading ? 'Preparing…' : profile.logo_url ? 'Replace logo' : 'Upload logo'}
                  <input type="file" accept="image/*" hidden disabled={logoUploading}
                    onChange={e => { const f = e.target.files?.[0]; if (f) void uploadLogo(f); e.target.value = '' }} />
                </label>
                <span className="text-[10px] text-slate-500">PNG/JPG — we auto-trim, center and size it for the report.</span>
              </div>
            </div>
            <div className="sm:col-span-2">
              <button
                onClick={saveBrand} disabled={brandSaving}
                className="rounded bg-slate-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-600 disabled:opacity-50"
              >{brandSaving ? 'Saving…' : 'Save branding'}</button>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
