'use client'

/**
 * The board's sense of "now".
 *
 * Dispatch is a today-anchored tool: a board that opens on the wrong day is
 * worse than useless, because the dispatcher trusts it. Three things have to be
 * true for the date to be right, and each one is a bug we've been bitten by:
 *
 *  1. It's the *local* date, not UTC. `toISOString().slice(0,10)` is wrong for
 *     every crew west of Greenwich after 7pm — it silently rolls the board a day
 *     forward. We build the string from local getters instead.
 *  2. It rolls over at midnight without a refresh. Dispatch boards sit open on a
 *     wall display for days at a time.
 *  3. It re-syncs when the tab wakes. A laptop closed overnight suspends timers,
 *     so the midnight timeout may never fire — visibility is the backstop.
 *
 * Returns `null` until mounted, on purpose: the server renders in its own
 * timezone (Vercel is UTC) and any date we render during SSR risks a hydration
 * mismatch. Callers show their skeleton for the one frame it takes to resolve.
 */
import { useEffect, useState } from 'react'

/** Local calendar date as `yyyy-MM-dd` — never UTC-shifted. */
export function toISODate(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** Parse `yyyy-MM-dd` as a *local* midnight Date (`new Date(str)` parses as UTC). */
export function fromISODate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, (m || 1) - 1, d || 1)
}

/** Shift a `yyyy-MM-dd` string by whole days, staying in local time. */
export function shiftISODate(s: string, days: number): string {
  const d = fromISODate(s)
  d.setDate(d.getDate() + days)
  return toISODate(d)
}

/** Monday-start week containing `s`, as `yyyy-MM-dd`. */
export function startOfISOWeek(s: string): string {
  const d = fromISODate(s)
  const dow = (d.getDay() + 6) % 7 // Mon=0 … Sun=6
  d.setDate(d.getDate() - dow)
  return toISODate(d)
}

/**
 * Today's local date, live. `null` for the first client frame (see above).
 */
export function useToday(): string | null {
  const [today, setToday] = useState<string | null>(null)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined

    const sync = () => {
      setToday(toISODate(new Date()))
      // Re-arm for just after the next local midnight. Recomputed each tick so
      // DST transitions can't drift us onto the wrong hour.
      const now = new Date()
      const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5)
      timer = setTimeout(sync, Math.max(1000, nextMidnight.getTime() - now.getTime()))
    }
    sync()

    const onWake = () => { if (document.visibilityState === 'visible') sync() }
    document.addEventListener('visibilitychange', onWake)
    window.addEventListener('focus', onWake)
    return () => {
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onWake)
      window.removeEventListener('focus', onWake)
    }
  }, [])

  return today
}
