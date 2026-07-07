'use client'

/**
 * ClientPortalPanel — contractor controls for the homeowner portal.
 * Copy the link, move the job through stages; the homeowner's timeline
 * updates instantly. AccuLynx charges for this — Axis includes it.
 */
import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'

import { api } from '@/lib/api'

interface Props {
  projectId: string
}

const STAGES: { key: string; label: string }[] = [
  { key: 'measured', label: 'Roof measured' },
  { key: 'proposal', label: 'Proposal sent' },
  { key: 'accepted', label: 'Accepted' },
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'complete', label: 'Complete' },
]

export default function ClientPortalPanel({ projectId }: Props) {
  const [portal, setPortal] = useState<{ token: string; stage: string; enabled: boolean } | null>(null)

  useEffect(() => {
    api.clientPortal.my(projectId).then(setPortal).catch(() => {})
  }, [projectId])

  const setStage = useCallback(async (stage: string) => {
    if (!portal) return
    setPortal({ ...portal, stage })
    try {
      await api.clientPortal.update(projectId, { stage })
      toast.success('Portal updated — your customer sees the new status')
    } catch { toast.error('Could not update the portal') }
  }, [portal, projectId])

  if (!portal) return null
  const url = `${typeof window !== 'undefined' ? window.location.origin : ''}/c/${portal.token}`

  return (
    <section className="rounded-lg border border-white/10 bg-slate-900/40 p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">🏠 Client portal</h3>
          <p className="text-xs text-slate-400">
            One link your customer keeps for the whole job — live status, proposal, report, photos,
            your contact info. Text it once; update the stage as work progresses.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => { void navigator.clipboard.writeText(url).then(() => toast.success('Portal link copied — text it to your customer')) }}
            className="rounded bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-500"
          >Copy link</button>
          <a href={`/c/${portal.token}`} target="_blank" rel="noreferrer"
            className="rounded bg-slate-700 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-600">Preview ↗</a>
        </div>
      </div>

      {/* Stage stepper */}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {STAGES.map((s, i) => {
          const idx = STAGES.findIndex(x => x.key === portal.stage)
          const done = i < idx
          const active = i === idx
          return (
            <button
              key={s.key}
              onClick={() => setStage(s.key)}
              className={`rounded-full border px-2.5 py-1 text-[11px] transition ${
                active ? 'border-blue-400/60 bg-blue-500/20 font-semibold text-blue-200'
                  : done ? 'border-emerald-400/40 bg-emerald-500/10 text-emerald-300'
                  : 'border-white/10 bg-slate-800/60 text-slate-400 hover:text-white'
              }`}
              title="Set the job to this stage"
            >{done ? '✓ ' : ''}{s.label}</button>
          )
        })}
      </div>
    </section>
  )
}
