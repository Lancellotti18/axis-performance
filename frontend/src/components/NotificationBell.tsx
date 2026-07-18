'use client'

/**
 * NotificationBell — top-bar bell + unread badge. Clicking it opens the full
 * /notifications page (not a dropdown). Polls the unread count on a light
 * interval so the badge stays current.
 */
import { useCallback, useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { api } from '@/lib/api'

export default function NotificationBell() {
  const router = useRouter()
  const pathname = usePathname()
  const [unread, setUnread] = useState(0)

  const refresh = useCallback(() => {
    api.notifications.unreadCount().then(r => setUnread(r.unread)).catch(() => {})
  }, [])

  // Poll every 45s, and re-check whenever the route changes (e.g. after
  // visiting the notifications page and marking things read).
  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 45000)
    return () => clearInterval(t)
  }, [refresh, pathname])

  return (
    <button
      onClick={() => router.push('/notifications')}
      aria-label={`Notifications${unread ? ` (${unread} unread)` : ''}`}
      className="relative w-10 h-10 rounded-full flex items-center justify-center text-slate-300 hover:text-white hover:bg-white/[0.06] transition-colors"
    >
      <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
      </svg>
      {unread > 0 && (
        <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-rose-500 text-white text-[10px] font-bold flex items-center justify-center ring-2 ring-[#0a0f1a]">
          {unread > 9 ? '9+' : unread}
        </span>
      )}
    </button>
  )
}
