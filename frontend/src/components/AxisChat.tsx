'use client'
import { useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { useChatContext, type ChatSection } from '@/lib/chat-context'

type Msg = { role: 'user' | 'assistant'; content: string }

const STORAGE_KEY = 'axis_chat_history_v1'
const MAX_PERSIST = 30  // recent turns kept in localStorage

const SUGGESTED_PROMPTS: Record<ChatSection, string[]> = {
  'permit': [
    'What does APN mean and where do I find it?',
    'Which fields are still missing?',
    'Is this the right permit for my project?',
  ],
  'storm-report': [
    'Which hazard should I prioritize first?',
    'Why did hail score what it did?',
    'What roof reinforcements would help most here?',
  ],
  'project-detail': [
    'What\'s the next step on this project?',
    'Explain my material cost breakdown',
    'Did the blueprint analysis catch everything?',
  ],
  'aerial-report': [
    'Does this roof outline look right?',
    'How was the square footage calculated?',
  ],
  'compliance': [
    'Which compliance items are blocking me?',
    'How do I fix the failures?',
  ],
  'dashboard': [
    'What should I do first?',
    'Which tool fits what I\'m trying to do?',
  ],
  'general': [
    'How does Axis Performance work?',
    'What can you help me with?',
  ],
}

export default function AxisChat() {
  const ctx = useChatContext()
  const [open, setOpen] = useState(false)
  const [section, setSection] = useState<ChatSection>(ctx.section)
  const [messages, setMessages] = useState<Msg[]>(() => {
    if (typeof window === 'undefined') return []
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY)
      return saved ? JSON.parse(saved) : []
    } catch { return [] }
  })
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Subscribe to the chat context so the widget reflects whichever page
  // the user is currently on.
  useEffect(() => {
    setSection(ctx.section)
    return ctx.subscribe(() => setSection(ctx.section))
  }, [ctx])

  // Persist message history (capped) so a refresh doesn't lose the conversation
  useEffect(() => {
    try {
      const trimmed = messages.slice(-MAX_PERSIST)
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed))
    } catch {}
  }, [messages])

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (scrollerRef.current) scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight
  }, [messages, busy])

  // Focus the input when opening
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50)
  }, [open])

  async function send(text?: string) {
    const userMsg = (text ?? draft).trim()
    if (!userMsg || busy) return
    setErr(null)
    setBusy(true)
    setDraft('')
    const next: Msg[] = [...messages, { role: 'user', content: userMsg }]
    setMessages(next)
    try {
      const res = await api.chat.ask({
        section: ctx.section,
        page_data: ctx.pageData,
        history: messages.slice(-10),
        message: userMsg,
      })
      setMessages([...next, { role: 'assistant', content: res.reply }])
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not reach Axis right now.')
      // Roll the user message back into the draft so they don't lose it
      setDraft(userMsg)
      setMessages(messages)
    } finally {
      setBusy(false)
    }
  }

  function clearChat() {
    setMessages([])
    setErr(null)
    try { window.localStorage.removeItem(STORAGE_KEY) } catch {}
  }

  const suggestions = SUGGESTED_PROMPTS[section] || SUGGESTED_PROMPTS.general

  return (
    <>
      {/* Floating launcher */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          aria-label="Ask Axis"
          className="fixed bottom-6 right-6 z-40 flex items-center gap-2 px-4 h-12 rounded-full text-white font-bold text-sm shadow-xl transition-all hover:scale-105"
          style={{
            background: 'linear-gradient(135deg, #2563eb 0%, #1e3a5f 100%)',
            boxShadow: '0 6px 24px rgba(37,99,235,0.40), 0 0 0 1px rgba(127,201,244,0.30)',
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
          </svg>
          <span>Ask Axis</span>
        </button>
      )}

      {/* Chat panel */}
      {open && (
        <div
          className="fixed bottom-6 right-6 z-40 flex flex-col bg-white rounded-2xl overflow-hidden"
          style={{
            width: '380px',
            height: '560px',
            maxHeight: 'calc(100vh - 48px)',
            boxShadow: '0 24px 60px rgba(15,23,42,0.20), 0 0 0 1px rgba(127,201,244,0.30)',
          }}
        >
          {/* Header */}
          <div
            className="flex items-center justify-between px-4 py-3 text-white"
            style={{ background: 'linear-gradient(135deg, #1e3a5f 0%, #0f3a75 100%)' }}
          >
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: 'rgba(127,201,244,0.20)' }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
                </svg>
              </div>
              <div>
                <div className="font-bold text-sm leading-tight">Axis Assistant</div>
                <div className="text-[10px] opacity-70 capitalize">
                  {section === 'general' ? 'General help' : `Helping with ${section.replace('-', ' ')}`}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {messages.length > 0 && (
                <button onClick={clearChat} title="Clear conversation" className="w-7 h-7 rounded-md flex items-center justify-center hover:bg-white/10 transition-colors">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 01-2 2H9a2 2 0 01-2-2L5 6"/>
                  </svg>
                </button>
              )}
              <button onClick={() => setOpen(false)} title="Close" className="w-7 h-7 rounded-md flex items-center justify-center hover:bg-white/10 transition-colors">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
          </div>

          {/* Messages */}
          <div ref={scrollerRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3" style={{ background: '#F8FAFC' }}>
            {messages.length === 0 && (
              <div className="text-center pt-2">
                <div className="text-slate-700 font-bold text-sm mb-1">How can I help?</div>
                <p className="text-slate-500 text-xs leading-relaxed mb-4">
                  I can see what's on your current screen and answer questions about it.
                </p>
                <div className="flex flex-col gap-2">
                  {suggestions.slice(0, 3).map(s => (
                    <button
                      key={s}
                      onClick={() => send(s)}
                      className="text-left text-xs text-slate-700 bg-white border border-slate-200 hover:border-blue-400 hover:bg-blue-50 rounded-xl px-3 py-2 transition-all"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[85%] px-3 py-2 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
                    m.role === 'user'
                      ? 'bg-blue-600 text-white rounded-br-md'
                      : 'bg-white text-slate-800 border border-slate-200 rounded-bl-md'
                  }`}
                >
                  {m.content}
                </div>
              </div>
            ))}

            {busy && (
              <div className="flex justify-start">
                <div className="bg-white border border-slate-200 rounded-2xl rounded-bl-md px-3 py-2.5 flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                  <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                  <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
              </div>
            )}

            {err && (
              <div className="bg-red-50 border border-red-200 rounded-xl px-3 py-2 text-red-600 text-xs">
                {err}
              </div>
            )}
          </div>

          {/* Input */}
          <div className="border-t border-slate-200 p-3 bg-white">
            <div className="flex items-end gap-2">
              <textarea
                ref={inputRef}
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    send()
                  }
                }}
                rows={1}
                placeholder="Ask anything about this screen…"
                disabled={busy}
                className="flex-1 resize-none text-sm text-slate-700 placeholder-slate-400 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100 max-h-24"
                style={{ minHeight: '38px' }}
              />
              <button
                onClick={() => send()}
                disabled={busy || !draft.trim()}
                className="flex-shrink-0 w-9 h-9 rounded-xl text-white flex items-center justify-center transition-all disabled:opacity-40"
                style={{ background: 'linear-gradient(135deg, #2563eb 0%, #1e3a5f 100%)' }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
                </svg>
              </button>
            </div>
            <div className="text-[10px] text-slate-400 mt-1.5 text-center">
              Axis can see this screen — it's read-only and won't edit anything for you
            </div>
          </div>
        </div>
      )}
    </>
  )
}
