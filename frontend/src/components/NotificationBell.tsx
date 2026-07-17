'use client'

/**
 * NotificationBell — the top-bar bell + unread badge + dropdown feed.
 * Polls the unread count on a light interval; loads the full list when opened.
 * Clicking a notification marks it read and navigates to its target.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { api, type AppNotification } from '@/lib/api'

const TYPE_ICON: Record<AppNotification['type'], string> = {
  appointment: '📅',
  proposal_accepted: '🎉',
  message: '💬',
  system: '🔔',
}

function timeAgo(ts: string) {
  const m = Math.floor((Date.now() - new Date(ts).getTime()) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return d < 7 ? `${d}d ago` : new Date(ts).toLocaleDateString()
}

export default function NotificationBell() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [unread, setUnread] = useState(0)
  const [items, setItems] = useState<AppNotification[] | null>(null)
  const [loading, setLoading] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const refreshCount = useCallback(() => {
    api.notifications.unreadCount().then(r => setUnread(r.unread)).catch(() => {})
  }, [])

  // Poll the badge every 45s (and once on mount).
  useEffect(() => {
    refreshCount()
    const t = setInterval(refreshCount, 45000)
    return () => clearInterval(t)
  }, [refreshCount])

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  const load = useCallback(() => {
    setLoading(true)
    api.notifications.list()
      .then(r => { setItems(r.notifications); setUnread(r.unread) })
      .catch(() => setItems([]))
      .finally(() => setLoading(false))
  }, [])

  function toggle() {
    const next = !open
    setOpen(next)
    if (next) load()
  }

  function openItem(n: AppNotification) {
    if (!n.read) {
      setItems(prev => (prev || []).map(x => x.id === n.id ? { ...x, read: true } : x))
      setUnread(u => Math.max(0, u - 1))
      api.notifications.markRead(n.id).catch(() => {})
    }
    setOpen(false)
    if (n.link) router.push(n.link)
  }

  function markAll() {
    setItems(prev => (prev || []).map(x => ({ ...x, read: true })))
    setUnread(0)
    api.notifications.markAllRead().catch(() => {})
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={toggle}
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

      {open && (
        <div className="absolute right-0 mt-2 w-[360px] max-w-[92vw] rounded-2xl border border-white/10 bg-[#0b111b] shadow-2xl overflow-hidden z-50"
          style={{ boxShadow: '0 24px 60px -18px rgba(0,0,0,0.7)' }}>
          <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
            <div className="text-sm font-semibold text-white">Notifications</div>
            {(items?.some(i => !i.read)) && (
              <button onClick={markAll} className="text-[11px] font-medium text-blue-300 hover:text-blue-200">Mark all read</button>
            )}
          </div>
          <div className="max-h-[420px] overflow-y-auto">
            {loading && !items ? (
              <div className="py-10 text-center text-slate-500 text-sm">Loading…</div>
            ) : !items || items.length === 0 ? (
              <div className="py-12 text-center px-6">
                <div className="text-2xl mb-1">🔔</div>
                <div className="text-slate-300 text-sm font-medium">You&apos;re all caught up</div>
                <div className="text-slate-500 text-xs mt-1">Bookings, accepted proposals, and customer replies show up here.</div>
              </div>
            ) : (
              <ul className="divide-y divide-white/[0.06]">
                {items.map(n => (
                  <li key={n.id}>
                    <button
                      onClick={() => openItem(n)}
                      className={`w-full text-left flex gap-3 px-4 py-3 transition-colors hover:bg-white/[0.04] ${n.read ? '' : 'bg-blue-500/[0.06]'}`}
                    >
                      <span className="text-base leading-none mt-0.5 flex-shrink-0">{TYPE_ICON[n.type] || '🔔'}</span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className={`text-sm truncate ${n.read ? 'text-slate-300' : 'text-white font-semibold'}`}>{n.title}</span>
                          {!n.read && <span className="w-1.5 h-1.5 rounded-full bg-blue-400 flex-shrink-0" />}
                        </span>
                        {n.body && <span className="block text-xs text-slate-400 mt-0.5 line-clamp-2">{n.body}</span>}
                        <span className="block text-[10px] text-slate-500 mt-1">{timeAgo(n.created_at)}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
