import { createBrowserClient } from '@supabase/ssr'
import type { Session } from '@supabase/supabase-js'
import { clearAppQueryCache } from './app-query'

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

// ─── One tab, one account ─────────────────────────────────────────────────
// A browser holds ONE Supabase session, shared by every tab through cookies,
// but each tab keeps its own in-memory copy: this cache, the query cache, and
// the user each page loaded on mount. Signing in as someone else in another
// tab (or opening a confirm / reset link there) changes the shared session
// without telling this tab. The tab then mixed two accounts — the sidebar
// showed the new account while the dashboard loaded, and promo-redeemed,
// against the old one. That is how a brand-new test account appeared to open
// onto the owner's projects, CRM and pipeline.
//
// So a tab is pinned to the account it first saw. The moment any path reports
// a DIFFERENT user — an auth event, a getUser() call, the tab regaining focus —
// this tab stops sending the stale token, drops every cached response, and
// reloads, so it can never show or act on two accounts at once.
let tabUserId: string | null = null
// Set while the tab reloads onto a different account: no request may go out
// with either account's token in the gap before the reload lands.
let switching = false

const AUTH_PAGES = ['/login', '/register', '/forgot-password', '/reset-password', '/auth/']

function onAuthPage(): boolean {
  const p = window.location.pathname
  return AUTH_PAGES.some(a => p === a || p.startsWith(a))
}

/** Record who this tab belongs to; switch cleanly if that ever changes.
 *  Returns false when the tab is being reset and the caller must not proceed. */
export function confirmTabAccount(userId: string | null | undefined): boolean {
  if (typeof window === 'undefined' || !userId) return true
  if (tabUserId === null || tabUserId === userId) {
    tabUserId = userId
    return true
  }
  tabUserId = userId
  clearAppQueryCache()
  // On a sign-in / confirm page the switch is the point: nothing of the old
  // account is on screen and the page navigates on as the new one.
  if (onAuthPage()) return true
  // Anywhere in the app, page state already holds the previous account. Stop
  // sending its token and start over as whoever is signed in now.
  cachedSession = null
  switching = true
  window.location.reload()
  return false
}

// Focus and visibilitychange fire together; two concurrent getSession() calls
// are exactly the lock contention the cache above exists to avoid.
let recheck: Promise<void> | null = null

function recheckStoredAccount() {
  if (recheck) return recheck
  recheck = (async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (session?.user?.id) confirmTabAccount(session.user.id)
    } catch { /* lock contention — the next check catches it */ }
  })().finally(() => { recheck = null })
  return recheck
}

if (typeof window !== 'undefined') {
  initialFetch = supabase.auth.getSession().then(({ data: { session } }) => {
    if (!confirmTabAccount(session?.user?.id)) return null
    cachedSession = session
    return session
  })
  supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT' || !session) {
      // Signed out here or in another tab: nothing cached may outlive it.
      tabUserId = null
      cachedSession = null
      clearAppQueryCache()
      return
    }
    if (!confirmTabAccount(session.user?.id)) return
    cachedSession = session
  })
  // Another tab can change the shared session without any event reaching this
  // one, so look again whenever the person comes back to this tab.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') recheckStoredAccount()
  })
  window.addEventListener('focus', recheckStoredAccount)
}

/**
 * Get the current session without triggering the Supabase auth lock.
 * Use this instead of supabase.auth.getSession() everywhere in app code
 * to avoid "Lock was stolen" errors when concurrent calls race.
 */
export async function getCachedSession(): Promise<Session | null> {
  if (switching) return null
  if (cachedSession !== null) return cachedSession
  if (initialFetch) return initialFetch
  return null
}

/** Force a token refresh and update the cache. Call after a 401 response. */
export async function refreshCachedSession(): Promise<Session | null> {
  if (switching) return null
  const { data } = await supabase.auth.refreshSession()
  if (!confirmTabAccount(data.session?.user?.id)) return null
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
