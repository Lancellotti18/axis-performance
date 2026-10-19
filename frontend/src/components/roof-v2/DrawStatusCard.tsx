'use client'

/**
 * The "Draw & label roof" step's single source of truth.
 *
 * This replaced a stack of up to six yellow/green boxes (auto-measure result,
 * "lines need a type" nudge, auto-label panel, "confirm your edges", the
 * right-roof question, applying-labels spinner) that each described part of the
 * same state and each offered a different button. Contractors could not tell
 * which one to act on (Ryan, 2026-10-18).
 *
 * One card, one state at a time, and exactly one primary action:
 *   0. nothing on the map yet       → Auto-measure roof / Start drawing
 *   A/B. lines still need a type    → label them (all at once, or walked through)
 *   C. labeled, not confirmed       → review one by one / confirm all
 *   D. all confirmed                → show measurements (uses a report) → continue
 * Lower-priority notes live inside the card, never as competing banners.
 */
import type { ReactNode } from 'react'

export interface LineCounts { needsLabel: number; needsConfirm: number; totalLines: number }

interface Props {
  facetCount: number
  counts: LineCounts
  /** The roof on the map came from auto-measure in this session. */
  measuredAuto: boolean
  /** Auto-measure ran and could not measure this roof — why, in plain words. */
  autoFailedReason?: string | null
  autoMeasureAvailable: boolean
  /** Saving labels / recalculating. */
  applying: boolean
  /** The AI labeler is working. */
  labelBusy: boolean
  /** The AI can suggest a type for at least one remaining line. */
  aiLabelAvailable: boolean
  labelError?: string | null
  /** Every line is settled but the numbers are withheld until shown (uses a report). */
  awaitingReportConfirm: boolean
  showingMeasurements: boolean
  /** Second-tier information: auto-measure notes, completeness signals. */
  notes: string[]
  /** Problems that stop a report being produced. */
  blocking: string[]
  saveIndicator?: ReactNode
  onAutoMeasure: () => void
  onStartDrawing: () => void
  onHelp: () => void
  onWalkThrough: () => void
  onLabelAll: () => void
  onConfirmAll: () => void
  onReviewOneByOne: () => void
  onShowMeasurements: () => void
  onContinue: () => void
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export default function DrawStatusCard(p: Props) {
  const { facetCount, counts } = p
  const allSettled = facetCount > 0 && counts.totalLines > 0 && counts.needsLabel === 0 && counts.needsConfirm === 0

  let tone: 'neutral' | 'progress' | 'done' = 'neutral'
  let title = ''
  let body: ReactNode = null
  let primary: { label: string; onClick: () => void; disabled?: boolean } | null = null
  let secondary: { label: string; onClick: () => void; disabled?: boolean } | null = null
  let showHelp = false

  if (facetCount === 0) {
    showHelp = true
    if (p.autoFailedReason) {
      title = 'Draw the roof by hand'
      body = (
        <>
          <span className="block">{p.autoFailedReason}</span>
          <span className="mt-1 block">Trace each flat roof plane one at a time: click its corners, then click the first corner again to close it.</span>
        </>
      )
      primary = { label: 'Start drawing', onClick: p.onStartDrawing }
      if (p.autoMeasureAvailable) secondary = { label: 'Try auto-measure again', onClick: p.onAutoMeasure }
    } else if (p.autoMeasureAvailable) {
      title = 'Measure the roof'
      body = 'Auto-measure finds every roof plane and line for you, usually in under 30 seconds. You can also trace it yourself.'
      primary = { label: 'Auto-measure roof', onClick: p.onAutoMeasure }
      secondary = { label: 'Draw it by hand', onClick: p.onStartDrawing }
    } else {
      title = 'Draw the roof'
      body = 'Trace each flat roof plane one at a time: click its corners, then click the first corner again to close it.'
      primary = { label: 'Start drawing', onClick: p.onStartDrawing }
    }
  } else if (counts.needsLabel > 0) {
    tone = 'progress'
    title = p.measuredAuto
      ? `Roof measured — ${plural(facetCount, 'facet')} detected`
      : `${plural(counts.needsLabel, 'line')} still need${counts.needsLabel === 1 ? 's' : ''} a type`
    body = (
      <>
        {p.measuredAuto && (
          <span className="block">
            Next step: give the remaining {plural(counts.needsLabel, 'line')} a type
            {counts.needsConfirm > 0 ? ', then confirm the rest' : ''}.
          </span>
        )}
        <span className="block">These are the pink dashed lines with a <strong>?</strong> on the map.</span>
      </>
    )
    if (p.aiLabelAvailable) {
      primary = { label: p.labelBusy ? 'Labeling…' : 'Label them all at once', onClick: p.onLabelAll, disabled: p.labelBusy }
      secondary = { label: 'Walk me through them', onClick: p.onWalkThrough }
    } else {
      primary = { label: p.measuredAuto ? 'Label remaining lines' : 'Walk me through them', onClick: p.onWalkThrough }
    }
  } else if (counts.needsConfirm > 0) {
    tone = 'progress'
    title = 'All lines labeled — confirmation needed'
    body = 'Review and confirm the labeled lines so measurements and materials can be calculated. Labels decide the ridge cap, valley metal and drip edge on the order.'
    primary = { label: 'Review one by one', onClick: p.onReviewOneByOne }
    secondary = { label: 'Confirm all labels', onClick: p.onConfirmAll }
  } else if (allSettled && p.awaitingReportConfirm) {
    tone = 'done'
    title = 'Roof fully labeled and confirmed'
    body = 'Show the measurements and material list. This uses one roof report.'
    primary = { label: 'Show measurements & materials', onClick: p.onShowMeasurements, disabled: p.applying }
  } else if (allSettled) {
    tone = 'done'
    title = 'Roof fully labeled and confirmed'
    body = p.showingMeasurements
      ? 'Measurements and the material list are ready below.'
      : 'Loading measurements…'
    primary = { label: 'Continue to details →', onClick: p.onContinue, disabled: !p.showingMeasurements || p.blocking.length > 0 }
  } else {
    // Facets but no lines resolved yet (a facet still being closed, or edges
    // not created) — say so rather than show a wrong count.
    title = `${plural(facetCount, 'facet')} on the map`
    body = 'Finish tracing each roof plane; its lines appear once the plane is closed.'
    showHelp = true
  }

  const ring = tone === 'done' ? 'border-emerald-300' : tone === 'progress' ? 'border-blue-300' : 'border-[#dededc]'
  const dot = tone === 'done' ? 'bg-emerald-500' : tone === 'progress' ? 'bg-blue-500' : 'bg-[#9ca3af]'

  return (
    <section aria-live="polite" className={`rounded-xl border ${ring} bg-white p-4 shadow-sm`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${dot}`} />
            <h2 className="text-[15px] font-semibold text-[#1a1a1a]">{title}</h2>
          </div>
          {facetCount > 0 && counts.totalLines > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5 pl-[18px] text-[11px]">
              <Chip tone={counts.needsLabel > 0 ? 'pink' : 'muted'}>{plural(counts.needsLabel, 'line')} need{counts.needsLabel === 1 ? 's' : ''} a type</Chip>
              <Chip tone={counts.needsConfirm > 0 ? 'amber' : 'muted'}>{plural(counts.needsConfirm, 'line')} labeled, not confirmed</Chip>
              <Chip tone="muted">{plural(counts.totalLines - counts.needsLabel - counts.needsConfirm, 'line')} confirmed</Chip>
            </div>
          )}
          <div className="mt-2 pl-[18px] text-[13px] leading-relaxed text-[#4b5563]">{body}</div>
          {p.applying && (
            <div className="mt-2 flex items-center gap-2 pl-[18px] text-xs text-blue-900">
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-blue-200 border-t-blue-700" />
              Saving and recalculating measurements…
            </div>
          )}
          {p.labelError && <p className="mt-2 pl-[18px] text-xs text-rose-700">{p.labelError}</p>}
        </div>
        {(primary || secondary) && (
          <div className="flex shrink-0 flex-col items-stretch gap-2 sm:items-end">
            {primary && (
              <button onClick={primary.onClick} disabled={primary.disabled}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-500 disabled:opacity-50">
                {primary.label}
              </button>
            )}
            {secondary && (
              <button onClick={secondary.onClick} disabled={secondary.disabled}
                className="rounded-lg border border-[#dededc] bg-white px-4 py-2 text-sm font-medium text-[#1a1a1a] hover:bg-[#f8f8f7] disabled:opacity-50">
                {secondary.label}
              </button>
            )}
          </div>
        )}
      </div>

      {(p.blocking.length > 0 || p.notes.length > 0) && (
        <ul className="mt-3 space-y-1.5 border-t border-[#eeeeed] pt-3 pl-[18px] text-xs">
          {p.blocking.map(b => (
            <li key={b} className="flex gap-2 text-rose-800"><span aria-hidden>●</span><span>{b}</span></li>
          ))}
          {p.notes.map(n => (
            <li key={n} className="flex gap-2 text-[#6b7280]"><span aria-hidden className="text-amber-500">●</span><span>{n}</span></li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex items-center justify-between gap-3 pl-[18px]">
        <div>{p.saveIndicator}</div>
        {showHelp && (
          <button onClick={p.onHelp} className="text-xs font-medium text-[#0068d6] underline underline-offset-2 hover:text-[#01498f]">
            Need help drawing?
          </button>
        )}
      </div>
    </section>
  )
}

function Chip({ tone, children }: { tone: 'pink' | 'amber' | 'muted'; children: ReactNode }) {
  const cls = tone === 'pink' ? 'bg-[#ff1fa8]/10 text-[#b0126f]'
    : tone === 'amber' ? 'bg-amber-100 text-amber-900'
    : 'bg-[#f3f4f6] text-[#6b7280]'
  return <span className={`rounded-full px-2 py-0.5 font-medium ${cls}`}>{children}</span>
}

/**
 * The address-mismatch warning: the one thing that must be seen before anything
 * is measured or drawn. Calm, specific, and two clear choices.
 */
export function AddressMismatchBanner({ message, onConfirm, onStartOver }: {
  message: string
  onConfirm: () => void
  onStartOver: () => void
}) {
  return (
    <section role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold text-amber-950">
            <span aria-hidden>⚠</span> Possible address mismatch
          </h2>
          <p className="mt-1 text-[13px] leading-relaxed text-amber-950/85">{message}</p>
          <p className="mt-1 text-[13px] leading-relaxed text-amber-950/85">
            If this is the correct roof, click <strong>Confirm this is the right house</strong> to continue.
          </p>
        </div>
        <div className="flex shrink-0 flex-col gap-2 sm:items-end">
          <button onClick={onConfirm}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500">
            Confirm this is the right house
          </button>
          <button onClick={onStartOver}
            className="rounded-lg border border-amber-300 bg-white px-4 py-2 text-sm font-medium text-amber-950 hover:bg-amber-100">
            Start over
          </button>
        </div>
      </div>
    </section>
  )
}

/** Notes that once named the data supplier now describe the data. */
export function plainNote(s: string): string {
  return s
    .replace(/Google['’]s 3D (data|model)/g, 'the 3D roof data')
    .replace(/Google 3D/g, '3D roof data')
    .replace(/Google['’]s (aerial )?photo/g, 'the aerial photo')
    .replace(/Google['’]s/g, 'the')
    .replace(/\bGoogle\b/g, 'the aerial data')
}
