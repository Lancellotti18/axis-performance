'use client'

/**
 * Audit trail (M6) — every board mutation already writes a server-side event; this
 * surfaces the history as a slide-over ("who moved what, when"). Read-only.
 */
import { useQuery } from '@tanstack/react-query'
import { fetchAudit, type AuditEvent } from './lib/board'

const ICON: Record<string, string> = {
  CREATE: '＋', UNDO: '↺', CAPACITY_UPDATE: '⟳', BULK_UNASSIGN: '⇤',
}
function iconFor(a: string) {
  if (a in ICON) return ICON[a]
  if (a.includes('STATUS')) return '◐'
  if (a.includes('MOVE') || a.includes('REASSIGN')) return '→'
  return '•'
}
function ago(iso: string | null) {
  if (!iso) return ''
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export default function AuditPanel({ onClose }: { onClose: () => void }) {
  const { data, isLoading, error } = useQuery({ queryKey: ['audit'], queryFn: () => fetchAudit(80), staleTime: 15_000 })
  const events: AuditEvent[] = data?.events ?? []

  return (
    <div className="fixed inset-0 z-40 flex justify-end" onClick={onClose}>
      <div className="h-full w-full max-w-md overflow-y-auto border-l shadow-2xl" onClick={e => e.stopPropagation()}
        style={{ background: 'var(--panel)', borderColor: 'var(--line)' }}>
        <div className="sticky top-0 flex items-center justify-between border-b px-5 py-3" style={{ background: 'var(--panel)', borderColor: 'var(--line)' }}>
          <div>
            <div className="text-[15px] font-bold">History</div>
            <div className="text-[12px]" style={{ color: 'var(--muted)' }}>Every schedule change, most recent first</div>
          </div>
          <button onClick={onClose} className="rounded-md px-2 py-1 text-sm hover:bg-[#eeeeed]">✕</button>
        </div>

        <div className="p-4">
          {isLoading ? (
            <div className="space-y-2">{[0, 1, 2, 3, 4].map(i => <div key={i} className="h-10 animate-pulse rounded-md bg-[#eeeeed]" />)}</div>
          ) : error ? (
            <div className="text-[12px]" style={{ color: 'var(--tight)' }}>Couldn’t load history.</div>
          ) : events.length === 0 ? (
            <div className="py-10 text-center text-[12px]" style={{ color: 'var(--muted)' }}>No changes recorded yet.</div>
          ) : (
            <ol className="relative space-y-0">
              {events.map((e, i) => (
                <li key={e.id} className="flex gap-3">
                  <div className="flex flex-col items-center">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px]" style={{ background: 'var(--panel2)', color: 'var(--sky)' }}>{iconFor(e.action)}</span>
                    {i < events.length - 1 && <span className="w-px flex-1" style={{ background: 'var(--line)' }} />}
                  </div>
                  <div className="min-w-0 flex-1 pb-4">
                    <div className="text-[13px] leading-snug">{e.summary}</div>
                    <div className="mt-0.5 text-[11px]" style={{ color: 'var(--muted)' }}>{ago(e.created_at)}{e.actor_id ? ' · dispatcher' : ' · system'}</div>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  )
}
