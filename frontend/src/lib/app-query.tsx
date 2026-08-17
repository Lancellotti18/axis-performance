'use client'

/**
 * One query cache for the whole signed-in app.
 *
 * Every dashboard page used to hold its data in local `useState` and fetch it
 * in a `useEffect`. Next's client router unmounts a page when you navigate away,
 * so leaving Projects for CRM and coming back threw the data away and started
 * over — a blank screen, and on a cold Render dyno up to 75 seconds of one. That
 * is the "page is blank and has to reload" report, and it applied everywhere.
 *
 * Hoisting a single QueryClient above the pages fixes it structurally rather
 * than page by page: data fetched once stays in memory for the life of the tab,
 * so going back to a page paints instantly from cache and quietly revalidates
 * behind the paint.
 *
 * Lifetime is deliberately "until the tab closes or you sign out":
 *   - `gcTime: Infinity` — never evict on unmount. This is the setting that
 *     actually stops the blanking; the default 5 minutes is short enough that a
 *     detour through another section can still lose the data.
 *   - `staleTime` — how long we trust it before revalidating *behind* the
 *     already-painted screen. The user never waits on this.
 *   - Sign-out clears the cache (see `clearAppQueryCache`), because none of this
 *     should survive into the next account.
 */
import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

let activeClient: QueryClient | null = null

export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Serve from cache instantly, revalidate in the background.
        staleTime: 60_000,
        // Never drop a cached page just because it isn't mounted right now.
        gcTime: Infinity,
        // Refetching on every tab focus makes a long working session flicker
        // and hammers a free-tier backend; staleTime already covers freshness.
        refetchOnWindowFocus: false,
        refetchOnMount: true,
        retry: 1,
      },
    },
  })
}

/**
 * Wipe everything cached for the current user. Call on sign-out — otherwise the
 * next account to sign in on this tab paints the previous one's projects for a
 * frame before their own data lands.
 */
export function clearAppQueryCache() {
  activeClient?.clear()
}

export function AppQueryProvider({ children }: { children: React.ReactNode }) {
  // useState (not a module singleton) so React owns the instance, but we keep a
  // module-level handle so sign-out can reach it from outside the tree.
  const [client] = useState(() => {
    const c = createAppQueryClient()
    activeClient = c
    return c
  })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}
