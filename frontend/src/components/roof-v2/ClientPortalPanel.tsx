'use client'

/**
 * ClientPortalPanel — contractor controls for the homeowner portal.
 * Copy the link, move the job through stages, and MESSAGE the homeowner —
 * their replies from the portal land right here. AccuLynx charges for this;
 * Axis includes it.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'

import { api, type PortalMessage } from '@/lib/api'

interface Props {
  projectId: string
}

const STAGES: { key: string; label: string }[] = [
  { key: 'measured', label: 'Roof measured' },
  { key: 'proposal', label: 'Proposal sent' },
  { key: 'accepted', label: 'Accepted' },
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'complete', label: 'Complete' },
]

export default function ClientPortalPanel({ projectId }: Props) {
  const [portal, setPortal] = useState<{ token: string; stage: string; enabled: boolean } | null>(null)

  // Messaging
  const [messages, setMessages] = useState<PortalMessage[]>([])
  const [chatOpen, setChatOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const seenRef = useRef(0)          // homeowner messages already seen (badge)
  const threadRef = useRef<HTMLDivElement>(null)

  const loadMessages = useCallback(() => {
    api.clientPortal.myMessages(projectId)
      .then(r => setMessages(r.messages))
      .catch(() => { /* table may not exist yet */ })
  }, [projectId])

  useEffect(() => {
    api.clientPortal.my(projectId).then(setPortal).catch(() => {})
    loadMessages()
    const t = setInterval(loadMessages, 30000)
    return () => clearInterval(t)
  }, [projectId, loadMessages])

  useEffect(() => {
    if (chatOpen) {
      seenRef.current = messages.filter(m => m.sender === 'homeowner').length
      threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight })
    }
  }, [chatOpen, messages])

  const homeownerCount = messages.filter(m => m.sender === 'homeowner').length
  const unread = chatOpen ? 0 : Math.max(0, homeownerCount - seenRef.current)

  const setStage = useCallback(async (stage: string) => {
    if (!portal) return
    setPortal({ ...portal, stage })
    try {
      await api.clientPortal.update(projectId, { stage })
      toast.success('Portal updated — your customer sees the new status')
    } catch { toast.error('Could not update the portal') }
  }, [portal, projectId])

  const send = useCallback(async () => {
    const body = draft.trim()
    if (!body || sending) return
    setSending(true)
    try {
      const res = await api.clientPortal.sendMyMessage(projectId, body)
      setMessages(prev => [...prev, res.message])
      setDraft('')
    } catch (e) {
      toast.error(e instanceof Error ? e.message.replace(/\[HTTP \d+\]\s*/, '') : 'Could not send')
    } finally {
      setSending(false)
    }
  }, [draft, sending, projectId])

  if (!portal) return null
  const url = `${typeof window !== 'undefined' ? window.location.origin : ''}/c/${portal.token}`

  return (
    <section className="rounded-lg border border-white/10 bg-slate-900/40 p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">🏠 Client portal</h3>
          <p className="text-xs text-slate-400">
            One link your customer keeps for the whole job — live status, proposal, report, photos,
            messages. Text it once; update the stage as work progresses.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => { void navigator.clipboard.writeText(url).then(() => toast.success('Portal link copied — text it to your customer')) }}
            className="rounded bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-500"
          >Copy link</button>
          <a href={`/c/${portal.token}`} target="_blank" rel="noreferrer"
            className="rounded bg-slate-700 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-600">Preview ↗</a>
          <button
            onClick={() => setChatOpen(o => !o)}
            className="relative rounded bg-slate-700 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-600"
          >
            💬 Messages
            {unread > 0 && (
              <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">
                {unread}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Stage stepper */}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {STAGES.map((s, i) => {
          const idx = STAGES.findIndex(x => x.key === portal.stage)
          const done = i < idx
          const active = i === idx
          return (
            <button
              key={s.key}
              onClick={() => setStage(s.key)}
              className={`rounded-full border px-2.5 py-1 text-[11px] transition ${
                active ? 'border-blue-400/60 bg-blue-500/20 font-semibold text-blue-200'
                  : done ? 'border-emerald-400/40 bg-emerald-500/10 text-emerald-300'
                  : 'border-white/10 bg-slate-800/60 text-slate-400 hover:text-white'
              }`}
              title="Set the job to this stage"
            >{done ? '✓ ' : ''}{s.label}</button>
          )
        })}
      </div>

      {/* Message thread (contractor side) */}
      {chatOpen && (
        <div className="mt-3 rounded-lg border border-white/10 bg-slate-800/40 p-3">
          <div ref={threadRef} className="max-h-64 space-y-2 overflow-y-auto pr-1">
            {messages.length === 0 && (
              <p className="py-3 text-center text-xs text-slate-500">
                No messages yet. Post an update — your customer sees it on their portal and can reply.
              </p>
            )}
            {messages.map(m => (
              <div key={m.id} className={`flex ${m.sender === 'contractor' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[80%] rounded-2xl px-3 py-1.5 text-xs ${
                  m.sender === 'contractor'
                    ? 'rounded-br-md bg-blue-600 text-white'
                    : 'rounded-bl-md bg-slate-700 text-slate-100'
                }`}>
                  <div className="whitespace-pre-wrap break-words">{m.body}</div>
                  <div className={`mt-0.5 text-[9px] ${m.sender === 'contractor' ? 'text-blue-200' : 'text-slate-400'}`}>
                    {m.sender === 'contractor' ? 'You' : (m.sender_name || 'Homeowner')}
                    {' · '}{new Date(m.created_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <input
              type="text" value={draft} onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void send() }}
              placeholder="Message your customer… (e.g. 'Crew arrives Tuesday 8am')"
              className="min-w-0 flex-1 rounded border border-slate-700 bg-slate-800 px-2.5 py-2 text-xs text-white placeholder:text-slate-500"
            />
            <button
              onClick={send} disabled={sending || !draft.trim()}
              className="shrink-0 rounded bg-blue-600 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-500 disabled:opacity-40"
            >{sending ? '…' : 'Send'}</button>
          </div>
        </div>
      )}
    </section>
  )
}
