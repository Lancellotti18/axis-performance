'use client'
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'

/**
 * Pages register what section they are and what data is on screen so the
 * floating AxisChat widget knows what context to send to the backend.
 *
 * Usage in a page:
 *
 *   import { useRegisterChatContext } from '@/lib/chat-context'
 *   useRegisterChatContext('permit', { fields, jurisdiction, missing })
 *
 * The hook is fire-and-forget — pages don't need to read context themselves.
 */

export type ChatSection =
  | 'permit'
  | 'storm-report'
  | 'project-detail'
  | 'aerial-report'
  | 'compliance'
  | 'dashboard'
  | 'general'

export interface ChatContextValue {
  section: ChatSection
  pageData: Record<string, unknown>
  /** Subscribe to changes — used internally by the widget. */
  subscribe: (cb: () => void) => () => void
  /** Pages call this to publish their state. Last writer wins. */
  publish: (section: ChatSection, data: Record<string, unknown>) => void
}

const ChatCtx = createContext<ChatContextValue | null>(null)

export function ChatContextProvider({ children }: { children: ReactNode }) {
  // Mutable refs so publishing doesn't re-render the widget mid-stream.
  // The widget reads via subscribe() on demand instead.
  const sectionRef = useRef<ChatSection>('general')
  const dataRef = useRef<Record<string, unknown>>({})
  const subsRef = useRef<Set<() => void>>(new Set())

  const subscribe = (cb: () => void) => {
    subsRef.current.add(cb)
    return () => { subsRef.current.delete(cb) }
  }

  const publish = (section: ChatSection, data: Record<string, unknown>) => {
    sectionRef.current = section
    dataRef.current = data
    for (const cb of subsRef.current) cb()
  }

  // useState wrappers so the context value is stable
  const [value] = useState<ChatContextValue>(() => ({
    get section() { return sectionRef.current },
    get pageData() { return dataRef.current },
    subscribe,
    publish,
  }))

  return <ChatCtx.Provider value={value}>{children}</ChatCtx.Provider>
}

export function useChatContext(): ChatContextValue {
  const ctx = useContext(ChatCtx)
  if (!ctx) {
    // Safe fallback so pages outside the provider don't crash
    return {
      section: 'general',
      pageData: {},
      subscribe: () => () => {},
      publish: () => {},
    }
  }
  return ctx
}

/**
 * Page-side hook: publishes the current section + data on every render where
 * `data` changes. Cleans up to 'general' on unmount so a stale page state
 * doesn't bleed into the next page the user navigates to.
 */
export function useRegisterChatContext(section: ChatSection, data: Record<string, unknown>) {
  const ctx = useContext(ChatCtx)
  // Stringify for a cheap deep-compare. Page data is small enough that this
  // is fine — no need to pull in deep-equal.
  const key = JSON.stringify(data)
  useEffect(() => {
    if (!ctx) return
    ctx.publish(section, data)
    return () => {
      // On unmount, reset to general so the chat doesn't reference stale data
      ctx.publish('general', {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, key])
}
