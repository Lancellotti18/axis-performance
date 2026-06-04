import { createBrowserClient } from '@supabase/ssr'
import type { Session } from '@supabase/supabase-js'

export const supabase = createBrowserClient(
  (process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://drouqkykdejsxziwkqgy.supabase.co').trim(),
  (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '').trim()
)

// ─── Session cache ────────────────────────────────────────────────────────
// The @supabase/ssr browser client uses navigator.locks under the hood for
// auth state. When multiple components call supabase.auth.getSession()
// concurrently — which the project-detail page does on load (analyses,
// estimates, compliance, status poll all in parallel) — the SDK aborts the
// later requests with "AbortError: Lock was stolen by another request".
// React StrictMode double-mounting in dev guarantees the race.
//
// Fix: prime the cache once at startup, keep it fresh via onAuthStateChange,
// and have API helpers read from the cache. No lock contention, no aborts.

let cachedSession: Session | null = null
let initialFetch: Promise<Session | null> | null = null

if (typeof window !== 'undefined') {
  initialFetch = supabase.auth.getSession().then(({ data: { session } }) => {
    cachedSession = session
    return session
  })
  supabase.auth.onAuthStateChange((_event, session) => {
    cachedSession = session
  })
}

/**
 * Get the current session without triggering the Supabase auth lock.
 * Use this instead of supabase.auth.getSession() everywhere in app code
 * to avoid "Lock was stolen" errors when concurrent calls race.
 */
export async function getCachedSession(): Promise<Session | null> {
  if (cachedSession !== null) return cachedSession
  if (initialFetch) return initialFetch
  return null
}

/** Force a token refresh and update the cache. Call after a 401 response. */
export async function refreshCachedSession(): Promise<Session | null> {
  const { data } = await supabase.auth.refreshSession()
  cachedSession = data.session
  return cachedSession
}

export type AuthUser = {
  id: string
  email: string
  full_name?: string
  company_name?: string
  plan?: string
  region?: string
}
