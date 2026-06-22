'use client'

/**
 * APIR — Reports panel mounted at the end of the /roof-v2 workflow.
 *
 * Lets the contractor:
 *   * Pick a roof + siding waste %
 *   * Click "Preview" to see the 12-page HTML in a new tab (no PDF wait)
 *   * Click "Generate APIR PDF" to run the full pipeline → S3 → download URL
 *   * See a list of every past version, download any of them, finalize a draft
 *
 * Self-fetches the version list on mount and after each generate/finalize.
 * Empty state (no reports yet): just shows the two waste dropdowns + buttons.
 */
import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'

import { api } from '@/lib/api'
import AccuracyPanel from '@/components/roof-v2/AccuracyPanel'


type ReportRow = {
  id: string
  version: number
  status: 'draft' | 'final'
  pdf_url: string | null
  pdf_size_kb: number | null
  scale_confidence: 'high' | 'medium' | 'estimated' | null
  ai_model_used: string | null
  page_count: number
  generated_at: string
  finalized_at: string | null
}

interface Props {
  projectId: string
  runId?: string
  // Initial waste %s — pulled from the run row if available, else defaults.
  initialRoofWastePct?: number
  initialSidingWastePct?: number
}

const WASTE_OPTIONS = [0, 5, 10, 12, 15, 17, 20, 22]


export default function ReportsPanel({
  projectId,
  runId,
  initialRoofWastePct,
  initialSidingWastePct,
}: Props) {
  const [reports, setReports] = useState<ReportRow[]>([])
  const [listLoading, setListLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [roofWaste, setRoofWaste] = useState<number>(initialRoofWastePct ?? 12)
  const [sidingWaste, setSidingWaste] = useState<number>(initialSidingWastePct ?? 10)
  const [expandedReportId, setExpandedReportId] = useState<string | null>(null)

  // Load version history on mount + when projectId changes
  const refresh = useCallback(async () => {
    setListLoading(true)
    try {
      const { reports } = await api.apir.list(projectId)
      setReports(reports)
    } catch (e) {
      console.error('apir list failed', e)
    } finally {
      setListLoading(false)
    }
  }, [projectId])

  useEffect(() => { void refresh() }, [refresh])

  // ── Actions ──────────────────────────────────────────────────────────

  const handlePreview = async () => {
    if (previewing) return
    setPreviewing(true)
    const toastId = toast.loading('Building HTML preview…')
    try {
      const html = await api.apir.preview(projectId, runId)
      const blob = new Blob([html], { type: 'text/html' })
      const url = URL.createObjectURL(blob)
      window.open(url, '_blank', 'noopener,noreferrer')
      toast.success('Preview opened in new tab', { id: toastId })
      // Revoke the blob URL after a delay — the new tab has already
      // resolved it, so we can free the memory.
      setTimeout(() => URL.revokeObjectURL(url), 60000)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Preview failed'
      toast.error(msg, { id: toastId })
    } finally {
      setPreviewing(false)
    }
  }

  const handleGenerate = async () => {
    if (generating) return
    setGenerating(true)
    const toastId = toast.loading(
      'Generating APIR report… (vision + PDF can take 60–120s)',
    )
    try {
      const res = await api.apir.generate({
        project_id: projectId,
        run_id: runId,
        report_type: 'full_exterior',
      })
      toast.success(
        `Report v${res.version} ready · ${res.scale_confidence} confidence`,
        { id: toastId },
      )
      await refresh()
      // Open the PDF immediately — but only if it's a real web URL. When object
      // storage isn't configured the backend returns a file:// path the browser
      // can't open; surface that clearly instead of silently doing nothing.
      if (res.download_url && /^https?:\/\//i.test(res.download_url)) {
        window.open(res.download_url, '_blank', 'noopener,noreferrer')
      } else if (res.download_url) {
        toast.error('Report generated, but file storage isn’t configured on the server yet, so it can’t be downloaded. (Needs S3/R2 or Supabase storage.)', { id: toastId, duration: 8000 })
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Generate failed'
      toast.error(msg, { id: toastId })
    } finally {
      setGenerating(false)
    }
  }

  const handleFinalize = async (reportId: string) => {
    const ok = window.confirm(
      'Finalizing locks this report — it cannot be edited or regenerated. Continue?',
    )
    if (!ok) return
    const toastId = toast.loading('Finalizing report…')
    try {
      await api.apir.finalize(reportId)
      toast.success('Report finalized', { id: toastId })
      await refresh()
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Finalize failed'
      toast.error(msg, { id: toastId })
    }
  }

  // ── Render ───────────────────────────────────────────────────────────

  return (
    <section className="mt-6 rounded-xl border border-slate-800 bg-slate-900/60 p-5 text-slate-100">
      <header className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-white">Axis Property Intelligence Report</h3>
          <p className="text-xs text-slate-400">
            12-page contractor-grade PDF. Branded with your company info.
          </p>
        </div>
      </header>

      {/* Waste % dropdowns */}
      <div className="mb-4 grid grid-cols-2 gap-3">
        <label className="block text-sm">
          <span className="mb-1 block text-xs uppercase tracking-wide text-slate-400">
            Roof waste %
          </span>
          <select
            value={roofWaste}
            onChange={e => setRoofWaste(Number(e.target.value))}
            className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white focus:border-blue-500 focus:outline-none"
            disabled={generating}
          >
            {WASTE_OPTIONS.map(p => (
              <option key={p} value={p}>{p}%</option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-xs uppercase tracking-wide text-slate-400">
            Siding waste %
          </span>
          <select
            value={sidingWaste}
            onChange={e => setSidingWaste(Number(e.target.value))}
            className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white focus:border-blue-500 focus:outline-none"
            disabled={generating}
          >
            {WASTE_OPTIONS.map(p => (
              <option key={p} value={p}>{p}%</option>
            ))}
          </select>
        </label>
      </div>

      {/* Actions */}
      <div className="mb-4 flex flex-wrap gap-2">
        <button
          onClick={handleGenerate}
          disabled={generating}
          className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {generating ? 'Generating…' : 'Generate APIR PDF'}
        </button>
        <button
          onClick={handlePreview}
          disabled={previewing}
          className="rounded-md bg-slate-700 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-600 disabled:opacity-50"
        >
          {previewing ? 'Opening…' : 'Preview HTML'}
        </button>
        <button
          onClick={() => { void refresh() }}
          disabled={listLoading || generating}
          className="rounded-md border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-50"
        >
          Refresh
        </button>
      </div>

      {/* Version history */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-sm font-semibold text-slate-200">Version history</h4>
          <span className="text-xs text-slate-500">
            {reports.length} version{reports.length === 1 ? '' : 's'}
          </span>
        </div>

        {listLoading ? (
          <div className="rounded-md bg-slate-800/60 p-4 text-center text-xs text-slate-400">
            Loading…
          </div>
        ) : reports.length === 0 ? (
          <div className="rounded-md bg-slate-800/60 p-4 text-center text-xs text-slate-400">
            No reports generated yet. Click <span className="text-emerald-400">Generate APIR PDF</span> to make one.
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border border-slate-800">
            <table className="w-full text-xs">
              <thead className="bg-slate-800/70 text-left text-slate-400">
                <tr>
                  <th className="px-3 py-2 font-medium">Version</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Confidence</th>
                  <th className="px-3 py-2 font-medium">Generated</th>
                  <th className="px-3 py-2 font-medium">Size</th>
                  <th className="px-3 py-2 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {reports.map(r => {
                  const isExpanded = expandedReportId === r.id
                  return (
                    <FragmentRow key={r.id}>
                      <tr className="border-t border-slate-800">
                        <td className="px-3 py-2 font-mono text-slate-200">
                          <button
                            onClick={() => setExpandedReportId(isExpanded ? null : r.id)}
                            className="hover:text-emerald-300"
                            title={isExpanded ? 'Hide accuracy diagnostic' : 'Show accuracy diagnostic'}
                          >
                            {isExpanded ? '▾' : '▸'} v{r.version}
                          </button>
                        </td>
                        <td className="px-3 py-2">
                          <StatusBadge status={r.status} />
                        </td>
                        <td className="px-3 py-2">
                          <ConfidenceBadge confidence={r.scale_confidence} />
                        </td>
                        <td className="px-3 py-2 text-slate-400">
                          {new Date(r.generated_at).toLocaleString()}
                        </td>
                        <td className="px-3 py-2 text-slate-400">
                          {r.pdf_size_kb ? `${(r.pdf_size_kb / 1024).toFixed(2)} MB` : '—'}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <div className="flex justify-end gap-2">
                            {r.pdf_url && (
                              <a
                                href={r.pdf_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-500"
                              >
                                Download
                              </a>
                            )}
                            {r.status === 'draft' && (
                              <button
                                onClick={() => { void handleFinalize(r.id) }}
                                className="rounded border border-amber-700 px-2 py-1 text-xs font-medium text-amber-400 hover:bg-amber-900/30"
                              >
                                Finalize
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr className="border-t border-slate-800 bg-slate-900/30">
                          <td colSpan={6} className="px-3 py-3">
                            <AccuracyPanel reportId={r.id} />
                          </td>
                        </tr>
                      )}
                    </FragmentRow>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  )
}


// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * React.Fragment alias — needed because TR siblings can't have a
 * <div> wrapper, but we want a single "logical row" (row + accuracy panel).
 */
function FragmentRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}


// ─── Small badge components ───────────────────────────────────────────

function StatusBadge({ status }: { status: 'draft' | 'final' }) {
  if (status === 'final') {
    return (
      <span className="rounded bg-emerald-900/40 px-2 py-0.5 text-emerald-300">FINAL</span>
    )
  }
  return (
    <span className="rounded bg-slate-700 px-2 py-0.5 text-slate-300">DRAFT</span>
  )
}


function ConfidenceBadge({
  confidence,
}: { confidence: 'high' | 'medium' | 'estimated' | null }) {
  if (!confidence) return <span className="text-slate-500">—</span>
  const tone =
    confidence === 'high'   ? 'bg-emerald-900/40 text-emerald-300'
    : confidence === 'medium' ? 'bg-amber-900/40 text-amber-300'
    : 'bg-rose-900/40 text-rose-300'
  return (
    <span className={`rounded px-2 py-0.5 ${tone}`}>
      {confidence.toUpperCase()}
    </span>
  )
}
