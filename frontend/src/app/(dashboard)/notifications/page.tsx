'use client'

/**
 * Notifications — the full feed (the bell in the header links here).
 * Groups by read/unread, lets you open an item (marks read + navigates),
 * and mark everything read.
 */
import { useCallback, useEffect, useState } from 'react'
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
  return d < 7 ? `${d}d ago` : new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export default function NotificationsPage() {
  const router = useRouter()
  const [items, setItems] = useState<AppNotification[] | null>(null)

  const load = useCallback(() => {
    api.notifications.list().then(r => setItems(r.notifications)).catch(() => setItems([]))
  }, [])
  useEffect(() => { load() }, [load])

  const unread = (items || []).filter(n => !n.read).length

  function open(n: AppNotification) {
    if (!n.read) {
      setItems(prev => (prev || []).map(x => x.id === n.id ? { ...x, read: true } : x))
      api.notifications.markRead(n.id).catch(() => {})
    }
    if (n.link) router.push(n.link)
  }
  function markAll() {
    setItems(prev => (prev || []).map(x => ({ ...x, read: true })))
    api.notifications.markAllRead().catch(() => {})
  }

  return (
    <div className="relative min-h-full" style={{ background: 'var(--color-surface-1)' }}>
      <div className="pointer-events-none absolute inset-0 opacity-[0.10]" style={{ backgroundImage: 'linear-gradient(rgba(0,127,255,1) 1.5px, transparent 1.5px), linear-gradient(90deg, rgba(0,127,255,1) 1.5px, transparent 1.5px)', backgroundSize: '34px 34px' }} />
      <div className="relative mx-auto max-w-2xl p-8">
        <div className="mb-6 flex items-end justify-between">
          <div>
            <h1 className="text-2xl font-bold text-[#1a1a1a]">Notifications</h1>
            <p className="mt-1 text-sm text-[#6b7280]">{unread > 0 ? `${unread} unread` : 'You’re all caught up'}</p>
          </div>
          {unread > 0 && (
            <button onClick={markAll} className="rounded-lg border border-[#dededc] bg-[#f8f8f7] px-3 py-1.5 text-xs font-medium text-[#1a1a1a] hover:bg-[#f8f8f7]">
              Mark all read
            </button>
          )}
        </div>

        {items === null ? (
          <div className="flex items-center justify-center py-24">
            <svg className="animate-spin text-blue-400" width="24" height="24" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>
          </div>
        ) : items.length === 0 ? (
          <div className="rounded-2xl border border-[#dededc] bg-[#f8f8f7] py-16 text-center">
            <div className="text-3xl">🔔</div>
            <div className="mt-2 text-sm font-medium text-[#1a1a1a]">Nothing yet</div>
            <div className="mx-auto mt-1 max-w-xs text-xs text-[#6b7280]">Bookings, accepted proposals, and customer replies will show up here.</div>
          </div>
        ) : (
          <ul className="space-y-2">
            {items.map(n => (
              <li key={n.id}>
                <button
                  onClick={() => open(n)}
                  className={`flex w-full items-start gap-3.5 rounded-2xl border p-4 text-left transition-colors ${n.read ? 'border-[#dededc] bg-[#f8f8f7] hover:bg-[#f8f8f7]' : 'border-blue-400/25 bg-blue-500/[0.08] hover:bg-blue-500/[0.12]'}`}
                >
                  <span className="mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-[#f8f8f7] text-base">{TYPE_ICON[n.type] || '🔔'}</span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className={`text-sm ${n.read ? 'text-[#1a1a1a]' : 'font-semibold text-[#1a1a1a]'}`}>{n.title}</span>
                      {!n.read && <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-blue-400" />}
                    </span>
                    {n.body && <span className="mt-0.5 block text-xs leading-relaxed text-[#6b7280]">{n.body}</span>}
                    <span className="mt-1.5 block text-[11px] text-[#6b7280]">{timeAgo(n.created_at)}{n.link ? ' · tap to open' : ''}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
