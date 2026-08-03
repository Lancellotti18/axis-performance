'use client'

/**
 * Crew Scheduling & Dispatch — the board (M2: read-only).
 * Self-contained section: its own QueryClient (global layout untouched), its own
 * data layer, and a design grounded in the subject (dawn on a worksite) rather
 * than the app's default blue-on-black. Numbers are the hero — tabular figures,
 * squares loud, a capacity meter per cell.
 */
import { useMemo, useState } from 'react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { addWeeks, format, startOfWeek } from 'date-fns'
import { fetchBoard } from './lib/board'
import Board from './Board'

const TZ_TODAY = new Date(2026, 7, 3) // board demo week anchor (Mon Aug 3, 2026)

export default function DispatchPage() {
  const [client] = useState(() => new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 } },
  }))
  return (
    <QueryClientProvider client={client}>
      <BoardScreen />
    </QueryClientProvider>
  )
}

function BoardScreen() {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(TZ_TODAY, { weekStartsOn: 1 }))
  const start = format(weekStart, 'yyyy-MM-dd')
  const endInclusive = format(new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 6), 'yyyy-MM-dd')

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['board', start, endInclusive],
    queryFn: () => fetchBoard(start, endInclusive),
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

  return (
    <div className="flex h-full min-h-0 flex-col" style={{ ...rootStyle, background: 'var(--ink)', color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>
      {/* Toolbar */}
      <div className="flex flex-shrink-0 flex-wrap items-center gap-3 border-b px-5 py-3" style={{ borderColor: 'var(--line)' }}>
        <div>
          <h1 className="text-[15px] font-bold tracking-tight">Dispatch board</h1>
          <p className="text-[11px]" style={{ color: 'var(--muted)' }}>Production scheduling — squares, not slots.</p>
        </div>
        <div className="ml-2 flex items-center gap-1">
          <button onClick={() => setWeekStart(w => addWeeks(w, -1))} className="rounded-md px-2 py-1 text-sm hover:bg-white/5" aria-label="Previous week">←</button>
          <button onClick={() => setWeekStart(startOfWeek(TZ_TODAY, { weekStartsOn: 1 }))} className="rounded-md border px-2.5 py-1 text-xs font-semibold hover:bg-white/5" style={{ borderColor: 'var(--line)' }}>This week</button>
          <button onClick={() => setWeekStart(w => addWeeks(w, 1))} className="rounded-md px-2 py-1 text-sm hover:bg-white/5" aria-label="Next week">→</button>
        </div>
        <div className="text-sm font-semibold">
          {format(weekStart, 'MMM d')} – {format(new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 6), 'MMM d, yyyy')}
        </div>
        <div className="ml-auto flex items-center gap-2 text-[11px]" style={{ color: 'var(--muted)' }}>
          {isFetching && <span>updating…</span>}
          <button onClick={() => refetch()} className="rounded-md border px-2.5 py-1 font-semibold hover:bg-white/5" style={{ borderColor: 'var(--line)' }}>Refresh</button>
        </div>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-auto">
        {isLoading ? (
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
          <Board data={data} today={format(TZ_TODAY, 'yyyy-MM-dd')} />
        ) : null}
      </div>
    </div>
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
