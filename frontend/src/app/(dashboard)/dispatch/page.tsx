'use client'

/**
 * Crew Scheduling & Dispatch — the board.
 * Self-contained section: its own QueryClient (global layout untouched), its own
 * data layer, and a design grounded in the subject (dawn on a worksite) rather
 * than the app's default blue-on-black. Numbers are the hero — tabular figures,
 * squares loud, a capacity meter per cell.
 *
 * Date model: the *focused day* is the single source of truth and the visible
 * week is derived from it. That's what lets ‹ › keep walking day by day straight
 * through Sunday into the next week instead of dead-ending at the week edge, and
 * it keeps the week view, the day view and the map view all pointed at the same
 * day when you switch between them.
 */
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { format } from 'date-fns'
import { fetchBoard } from './lib/board'
import { fromISODate, shiftISODate, startOfISOWeek, useToday } from './lib/today'
import Board from './Board'

/**
 * Dispatch used to mount its own QueryClient, which meant its board data was
 * thrown away the moment you navigated to CRM or Projects. It now shares the
 * app-wide cache from the dashboard layout, so coming back to the board repaints
 * the week you were looking at instead of reloading it.
 */
export default function DispatchPage() {
  // BoardScreen reads useSearchParams (the briefing deep link), which forces a
  // Suspense boundary — without one the whole route deopts out of static
  // rendering at build time.
  return (
    <Suspense fallback={null}>
      <BoardScreen />
    </Suspense>
  )
}

function BoardScreen() {
  const today = useToday()
  // `null` means "nobody has navigated" — the board simply *is* today, and keeps
  // being today when the clock rolls past midnight on an untouched board. The
  // moment the dispatcher navigates, their choice takes over. Derived rather
  // than synced in an effect, so there's no frame where the two disagree.
  const [picked, setPicked] = useState<string | null>(null)

  // Deep link from the morning briefing's rain line: /dispatch?date=YYYY-MM-DD&reschedule=1
  // lands on the affected day with the dry-day proposals already open, so the
  // alert and the fix are one click apart instead of two screens.
  const params = useSearchParams()
  const linkedDate = params.get('date')
  const autoOpenWeather = params.get('reschedule') === '1'
  useEffect(() => {
    if (linkedDate && /^\d{4}-\d{2}-\d{2}$/.test(linkedDate)) setPicked(linkedDate)
  }, [linkedDate])
  const focusDate = picked ?? today

  const goToday = useCallback(() => setPicked(null), [])
  const nudge = useCallback((days: number) => {
    if (!focusDate) return
    setPicked(shiftISODate(focusDate, days))
  }, [focusDate])
  const setFocusDate = useCallback((d: string) => setPicked(d), [])

  // ← → walk a day, ⇧← ⇧→ a week, T snaps back to today. The board is a
  // keyboard tool for anyone who lives in it all morning.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (e.key === 'ArrowLeft') { e.preventDefault(); nudge(e.shiftKey ? -7 : -1) }
      else if (e.key === 'ArrowRight') { e.preventDefault(); nudge(e.shiftKey ? 7 : 1) }
      else if (e.key === 't' || e.key === 'T') { e.preventDefault(); goToday() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [nudge, goToday])

  const weekStart = focusDate ? startOfISOWeek(focusDate) : null
  const weekEnd = weekStart ? shiftISODate(weekStart, 6) : null

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['board', weekStart, weekEnd],
    queryFn: () => fetchBoard(weekStart!, weekEnd!),
    enabled: !!weekStart && !!weekEnd,
  })

  const rootStyle = useMemo(() => ({
    ['--ink' as string]: '#0b0f14',
    ['--panel' as string]: '#141b24',
    ['--panel2' as string]: '#0f151d',
    ['--line' as string]: 'rgba(255,255,255,0.07)',
    ['--text' as string]: '#e7edf5',
    ['--muted' as string]: '#8b98a9',
    ['--dawn' as string]: '#ff8a3d',
    ['--sky' as string]: '#5aa9ff',
    ['--idle' as string]: '#6b7687',
    ['--balanced' as string]: '#37c98b',
    ['--tight' as string]: '#f2b32e',
    ['--over' as string]: '#f5566c',
  }) as React.CSSProperties, [])

  const onToday = !!today && focusDate === today

  return (
    <div className="flex h-full min-h-0 flex-col" style={{ ...rootStyle, background: 'var(--ink)', color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>
      {/* Toolbar */}
      <div className="flex flex-shrink-0 flex-wrap items-center gap-3 border-b px-5 py-3" style={{ borderColor: 'var(--line)' }}>
        <div>
          <h1 className="text-[15px] font-bold tracking-tight">Dispatch board</h1>
          <p className="text-[11px]" style={{ color: 'var(--muted)' }}>Production scheduling — squares, not slots.</p>
        </div>
        <div className="ml-2 flex items-center gap-0.5">
          <button onClick={() => nudge(-7)} disabled={!focusDate} className="rounded-md px-1.5 py-1 text-sm hover:bg-white/5 disabled:opacity-30" aria-label="Back one week" title="Back a week (⇧←)">«</button>
          <button onClick={() => nudge(-1)} disabled={!focusDate} className="rounded-md px-2 py-1 text-sm hover:bg-white/5 disabled:opacity-30" aria-label="Back one day" title="Back a day (←)">‹</button>
          <button onClick={goToday} disabled={!today || onToday}
            className="rounded-md border px-2.5 py-1 text-xs font-semibold transition-colors hover:bg-white/5 disabled:opacity-40"
            style={{ borderColor: 'var(--line)' }} title="Jump to today (T)">Today</button>
          <button onClick={() => nudge(1)} disabled={!focusDate} className="rounded-md px-2 py-1 text-sm hover:bg-white/5 disabled:opacity-30" aria-label="Forward one day" title="Forward a day (→)">›</button>
          <button onClick={() => nudge(7)} disabled={!focusDate} className="rounded-md px-1.5 py-1 text-sm hover:bg-white/5 disabled:opacity-30" aria-label="Forward one week" title="Forward a week (⇧→)">»</button>
        </div>
        <DateJump value={focusDate} onChange={setFocusDate} weekStart={weekStart} weekEnd={weekEnd} />
        <div className="ml-auto flex items-center gap-2 text-[11px]" style={{ color: 'var(--muted)' }}>
          {isFetching && <span>updating…</span>}
          <button onClick={() => refetch()} className="rounded-md border px-2.5 py-1 font-semibold hover:bg-white/5" style={{ borderColor: 'var(--line)' }}>Refresh</button>
        </div>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-auto">
        {isLoading || !focusDate || !today ? (
          <BoardSkeleton />
        ) : error ? (
          <div className="p-8">
            <div className="mx-auto max-w-md rounded-xl border p-5 text-center" style={{ borderColor: 'var(--line)', background: 'var(--panel)' }}>
              <div className="text-sm font-semibold">Couldn&apos;t load the board</div>
              <div className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>{error instanceof Error ? error.message.replace(/\[HTTP \d+\]\s*/, '') : 'Unknown error'}</div>
              <div className="mt-2 text-[11px]" style={{ color: 'var(--muted)' }}>First load after a deploy can take a moment while the backend wakes up — try Refresh.</div>
            </div>
          </div>
        ) : data && data.crews.length === 0 ? (
          <div className="p-10 text-center text-sm" style={{ color: 'var(--muted)' }}>No crews yet. Add a crew to start scheduling.</div>
        ) : data ? (
          <Board data={data} today={today} focusDate={focusDate} onFocusDate={setFocusDate} autoOpenWeather={autoOpenWeather} />
        ) : null}
      </div>
    </div>
  )
}

/**
 * The visible range doubles as the date picker: click the dates, get a native
 * calendar (which is also the good mobile one), pick any day, the board follows.
 */
function DateJump({
  value, onChange, weekStart, weekEnd,
}: {
  value: string | null; onChange: (d: string) => void; weekStart: string | null; weekEnd: string | null
}) {
  if (!value || !weekStart || !weekEnd) return <div className="h-[26px] w-44 animate-pulse rounded-md bg-white/5" />
  const label = `${format(fromISODate(weekStart), 'MMM d')} – ${format(fromISODate(weekEnd), 'MMM d, yyyy')}`
  return (
    <label className="relative cursor-pointer rounded-md px-2 py-1 text-sm font-semibold transition-colors hover:bg-white/5"
      title="Jump to a date">
      {label}
      <span className="ml-1.5 text-[10px]" style={{ color: 'var(--muted)' }}>▾</span>
      <input
        type="date"
        value={value}
        onChange={e => { if (e.target.value) onChange(e.target.value) }}
        aria-label="Jump to date"
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
      />
    </label>
  )
}

function BoardSkeleton() {
  return (
    <div className="space-y-3 p-4">
      {[0, 1, 2].map(i => (
        <div key={i} className="rounded-xl border p-3" style={{ borderColor: 'var(--line)', background: 'var(--panel)' }}>
          <div className="mb-2 h-4 w-40 animate-pulse rounded bg-white/10" />
          <div className="grid grid-cols-7 gap-2">
            {Array.from({ length: 7 }).map((_, j) => <div key={j} className="h-24 animate-pulse rounded-lg bg-white/5" />)}
          </div>
        </div>
      ))}
    </div>
  )
}
