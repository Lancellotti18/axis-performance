'use client'

/**
 * Axis Performance — Training Data Dashboard.
 *
 * Phase-0 of Option 4. Shows the contractor (or you, the platform owner)
 * the moat being built: every confirmed facet/edge/penetration/wall/opening
 * is captured automatically and accumulates here. After 6-12 months of use
 * you'll have enough labeled examples to fine-tune SAM2 on RunPod.
 *
 * Exports as COCO JSON ready for any major polygon-segmentation framework.
 */
import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import { getUser } from '@/lib/auth'

interface Stats {
  total: number
  by_task_type: Record<string, number>
  by_quality: Record<string, number>
  by_capture_source: Record<string, number>
  ready_for_training: number
  recent_7d: number
}

interface Example {
  id: string
  task_type: string
  quality_tier: string
  capture_source: string
  image_url: string
  image_width_px: number
  image_height_px: number
  annotation: Record<string, unknown>
  created_at: string
}

const TASK_LABELS: Record<string, string> = {
  roof_facet_polygon: 'Roof facet polygons',
  edge_classification: 'Edge labels (eave/rake/ridge/hip/valley)',
  penetration_location: 'Penetration locations',
  wall_polygon: 'Wall facade polygons',
  opening_rectangle: 'Window/door rectangles',
  roof_outline_polygon: 'Roof outline polygons',
}

const QUALITY_COLORS: Record<string, string> = {
  unverified: 'bg-slate-700 text-slate-200',
  reviewed: 'bg-emerald-500/20 text-emerald-300 border border-emerald-400/40',
  expert_verified: 'bg-blue-500/20 text-blue-300 border border-blue-400/40',
  rejected: 'bg-rose-500/20 text-rose-300 border border-rose-400/40',
}

export default function TrainingDataPage() {
  const router = useRouter()
  const [stats, setStats] = useState<Stats | null>(null)
  const [examples, setExamples] = useState<Example[]>([])
  const [filterTask, setFilterTask] = useState<string>('')
  const [filterQuality, setFilterQuality] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [s, e] = await Promise.all([
        api.training.stats(),
        api.training.list({
          task_type: filterTask || undefined,
          quality_tier: filterQuality || undefined,
          limit: 30,
        }),
      ])
      setStats(s)
      setExamples(e.examples as unknown as Example[])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load training data')
    } finally {
      setLoading(false)
    }
  }, [filterTask, filterQuality])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const u = await getUser()
      if (!u) { router.push('/login'); return }
      if (cancelled) return
      void refresh()
    })()
    return () => { cancelled = true }
  }, [router, refresh])

  const markReview = useCallback(async (id: string, tier: 'reviewed' | 'rejected' | 'expert_verified') => {
    try {
      await api.training.patch(id, { quality_tier: tier })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed')
    }
  }, [refresh])

  const exportCoco = useCallback(async (taskType: string) => {
    try {
      await api.training.downloadCoco(taskType, 'reviewed')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed')
    }
  }, [])

  return (
    <div className="mx-auto max-w-[1400px] space-y-6 p-6 text-slate-100">
      <header>
        <h1 className="text-2xl font-bold">Training Data</h1>
        <p className="text-sm text-slate-400">
          The moat. Every facet, edge, penetration, wall, and opening your contractors confirm is
          captured here automatically. Export as COCO JSON to fine-tune SAM2 or any segmentation
          model on RunPod when the dataset is large enough (~500+ reviewed examples per task type).
        </p>
      </header>

      {error && (
        <div className="rounded-lg border border-rose-400/30 bg-rose-500/10 p-3 text-sm text-rose-200">
          {error}
        </div>
      )}

      {/* Top stats */}
      {stats && (
        <section className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <StatCard label="Total examples" value={stats.total} accent />
          <StatCard label="Ready for training" value={stats.ready_for_training} color="text-emerald-300" />
          <StatCard label="Added in last 7d" value={stats.recent_7d} color="text-blue-300" />
          <StatCard label="AI corrections" value={stats.by_capture_source['ai_corrected'] || 0} color="text-amber-300" />
          <StatCard label="Organic" value={stats.by_capture_source['organic'] || 0} />
        </section>
      )}

      {/* Per-task breakdown */}
      {stats && (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-slate-200">Per task type</h2>
          <ul className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
            {Object.entries(TASK_LABELS).map(([key, label]) => {
              const count = stats.by_task_type[key] || 0
              return (
                <li
                  key={key}
                  className="rounded-lg border border-white/10 bg-slate-900/40 p-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-xs uppercase tracking-wide text-slate-400">{key}</div>
                      <div className="text-sm font-medium text-slate-100">{label}</div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-xl font-bold text-slate-100">{count}</div>
                      <div className="text-[10px] text-slate-500">examples</div>
                    </div>
                  </div>
                  <button
                    onClick={() => exportCoco(key)}
                    disabled={count === 0}
                    className="mt-3 w-full rounded bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-500 disabled:opacity-30"
                  >Export COCO JSON</button>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {/* Filters + recent list */}
      <section>
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-200">Recent examples</h2>
          <div className="flex flex-wrap gap-2 text-xs">
            <select
              value={filterTask}
              onChange={e => setFilterTask(e.target.value)}
              className="rounded bg-slate-800 px-2 py-1 text-slate-100"
            >
              <option value="">All task types</option>
              {Object.keys(TASK_LABELS).map(k => <option key={k} value={k}>{k}</option>)}
            </select>
            <select
              value={filterQuality}
              onChange={e => setFilterQuality(e.target.value)}
              className="rounded bg-slate-800 px-2 py-1 text-slate-100"
            >
              <option value="">All quality tiers</option>
              <option value="unverified">Unverified</option>
              <option value="reviewed">Reviewed</option>
              <option value="expert_verified">Expert verified</option>
              <option value="rejected">Rejected</option>
            </select>
            <button
              onClick={refresh}
              disabled={loading}
              className="rounded bg-slate-700 px-2 py-1 text-slate-200 hover:bg-slate-600 disabled:opacity-50"
            >{loading ? 'Loading…' : 'Refresh'}</button>
          </div>
        </div>

        {examples.length === 0 ? (
          <p className="rounded border border-white/10 bg-slate-900/40 p-4 text-xs text-slate-400">
            No examples match the current filters. Confirm some facets/edges/penetrations in the
            Roof v2 editor or the Exterior module — examples will appear here automatically.
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            {examples.map(ex => (
              <li
                key={ex.id}
                className="overflow-hidden rounded-lg border border-white/10 bg-slate-900/40"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={ex.image_url}
                  alt=""
                  className="h-40 w-full object-cover"
                />
                <div className="space-y-2 p-3 text-xs">
                  <div className="flex items-center justify-between">
                    <span className={`rounded px-2 py-0.5 text-[10px] ${QUALITY_COLORS[ex.quality_tier] || 'bg-slate-700'}`}>
                      {ex.quality_tier}
                    </span>
                    <span className="text-slate-500">
                      {new Date(ex.created_at).toLocaleDateString()}
                    </span>
                  </div>
                  <div>
                    <div className="font-medium text-slate-100">{TASK_LABELS[ex.task_type] || ex.task_type}</div>
                    <div className="text-slate-500 capitalize">{ex.capture_source.replace('_', ' ')}</div>
                  </div>
                  {ex.quality_tier === 'unverified' && (
                    <div className="flex gap-1">
                      <button
                        onClick={() => markReview(ex.id, 'reviewed')}
                        className="flex-1 rounded bg-emerald-600 px-2 py-1 text-white hover:bg-emerald-500"
                      >Approve</button>
                      <button
                        onClick={() => markReview(ex.id, 'rejected')}
                        className="flex-1 rounded bg-rose-600 px-2 py-1 text-white hover:bg-rose-500"
                      >Reject</button>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="rounded-lg border border-blue-400/30 bg-blue-500/5 p-4 text-xs text-slate-300">
        <strong className="text-blue-300">What to do with this dataset:</strong> When you have ~500+
        examples in any task type with <strong>quality_tier in (reviewed, expert_verified)</strong>,
        export the COCO JSON, and either: (a) fine-tune SAM2 yourself on RunPod (~$200-500 compute),
        (b) hire an ML contractor to do the fine-tune (~$5K-15K for the model + serving), or
        (c) hold the dataset as an asset — it has intrinsic value to any company building
        roofing/insurance vision tools.
      </div>
    </div>
  )
}

function StatCard({ label, value, accent = false, color }: { label: string; value: number; accent?: boolean; color?: string }) {
  return (
    <div className={`rounded-lg border ${accent ? 'border-blue-400/40 bg-blue-500/10' : 'border-white/10 bg-slate-900/40'} p-3`}>
      <div className="text-[10px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`text-2xl font-bold ${color || 'text-slate-100'}`}>{value.toLocaleString()}</div>
    </div>
  )
}
