'use client'

/**
 * LegalAcknowledgmentGate — the blocking consent step a contractor sees once,
 * immediately after signing up, before they can use anything in the dashboard.
 *
 * Deliberately not dismissible: no close button, no click-outside, no Escape.
 * Consent that can be skipped is not consent, and the record it produces is
 * the evidence that the contractor agreed to the data-licensing and liability
 * terms. The accept button stays disabled until BOTH boxes are checked, and
 * the server independently rejects a half-accepted submission.
 *
 * Re-prompts by itself when the documents are re-versioned: the backend
 * compares what the contractor accepted against the versions it currently
 * requires, so bumping CURRENT_TOS_VERSION in legal.py is the whole ritual.
 */
import { useCallback, useEffect, useState } from 'react'

import { api } from '@/lib/api'

export default function LegalAcknowledgmentGate() {
  const [required, setRequired] = useState(false)
  const [tos, setTos] = useState(false)
  const [privacy, setPrivacy] = useState(false)
  // Optional. Never gates the button — see the note by the checkbox.
  const [marketing, setMarketing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const check = useCallback(() => {
    api.legal.status()
      .then(s => setRequired(s.required))
      // A failed check must not gate the app — the contractor would be stuck
      // in a modal whose submit endpoint is equally unreachable.
      .catch(() => setRequired(false))
  }, [])

  useEffect(() => { check() }, [check])

  // Hold the page still behind the gate, so a contractor cannot scroll the
  // dashboard around underneath it while the modal is up.
  useEffect(() => {
    if (!required) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [required])

  const accept = useCallback(async () => {
    if (!tos || !privacy || saving) return
    setSaving(true)
    setError('')
    try {
      await api.legal.accept(marketing)
      setRequired(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save your acceptance. Try again.')
    } finally {
      setSaving(false)
    }
  }, [tos, privacy, marketing, saving])

  if (!required) return null

  const ready = tos && privacy

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="legal-gate-title"
      className="fixed inset-0 flex items-center justify-center overflow-y-auto p-4"
      style={{ zIndex: 1000, background: 'rgba(6, 9, 14, 0.72)' }}
    >
      <div
        className="w-full max-w-lg rounded-2xl bg-white shadow-2xl"
        style={{ border: '1px solid var(--color-surface-border)' }}
      >
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-[#e5e7eb] px-6 py-5">
          <div
            className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl"
            style={{ background: '#0068d6' }}
          >
            <svg width="18" height="18" viewBox="0 0 28 28" fill="none">
              <path d="M14 4 L24 24 H19 L17 19 H11 L9 24 H4 Z" fill="#BFE6FF" />
              <path d="M12.5 15 H15.5 L14 11 Z" fill="#06090E" />
            </svg>
          </div>
          <div>
            <h2 id="legal-gate-title" className="text-[17px] font-bold text-[#1a1a1a]">
              Before you get started
            </h2>
            <p className="mt-0.5 text-[13px] text-[#6b7280]">
              Please review and accept these to use Axis.
            </p>
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-5">
          <div className="space-y-3">
            <AgreementRow
              checked={tos}
              onChange={setTos}
              id="ack-tos"
              href="/legal/terms"
              label="Terms of Service"
              hint="Subscription and billing, pricing changes, accuracy, liability."
            />
            <AgreementRow
              checked={privacy}
              onChange={setPrivacy}
              id="ack-privacy"
              href="/legal/privacy"
              label="Privacy Policy"
              hint="What we collect, how AI training works, and how data is shared."
            />
          </div>

          {/* Optional, and deliberately unstyled as a required row.
              This is permission to solicit, not a contract term — the TCPA
              forbids conditioning a product on it, so it must be refusable and
              is never part of `ready`. Damages run $500–1,500 per message, and
              a box someone was forced to tick is not a defence. */}
          <label
            htmlFor="ack-marketing"
            className="mt-3 flex cursor-pointer select-none items-start gap-3 rounded-lg px-3.5 py-3"
            style={{ border: '1px dashed var(--color-surface-border)' }}
          >
            <input
              id="ack-marketing"
              type="checkbox"
              checked={marketing}
              onChange={e => setMarketing(e.target.checked)}
              className="mt-0.5 h-[18px] w-[18px] flex-shrink-0 cursor-pointer accent-[#0068d6]"
            />
            <span className="text-[13.5px] leading-snug text-[#374151]">
              Send me occasional texts and emails about Axis features, pricing and promotions.
              <span className="mt-0.5 block text-[12.5px] text-[#6b7280]">
                Optional — you can use Axis either way, and unsubscribe anytime.
              </span>
            </span>
          </label>

          {error && (
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-[13px] text-red-700">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-[#e5e7eb] px-6 py-4">
          <button
            type="button"
            onClick={accept}
            disabled={!ready || saving}
            className="w-full rounded-lg px-4 py-3 text-[14px] font-semibold text-white transition-all disabled:cursor-not-allowed"
            style={
              ready && !saving
                ? { background: '#0068d6', border: '1px solid #005cbb' }
                : { background: '#c7ccd3', border: '1px solid #c7ccd3' }
            }
          >
            {saving ? 'Saving…' : 'I acknowledge and agree'}
          </button>
          {!ready && (
            <p className="mt-2.5 text-center text-[12px] text-[#6b7280]">
              Check both boxes above to continue.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

function AgreementRow({
  id,
  checked,
  onChange,
  href,
  label,
  hint,
}: {
  id: string
  checked: boolean
  onChange: (v: boolean) => void
  href: string
  label: string
  hint: string
}) {
  return (
    <div
      className="flex items-start gap-3 rounded-lg px-3.5 py-3 transition-colors"
      style={{
        background: checked ? 'rgba(0, 104, 214, 0.05)' : '#f8f8f7',
        border: `1px solid ${checked ? 'rgba(0, 104, 214, 0.3)' : 'var(--color-surface-border)'}`,
      }}
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        className="mt-0.5 h-[18px] w-[18px] flex-shrink-0 cursor-pointer accent-[#0068d6]"
      />
      <label htmlFor={id} className="cursor-pointer select-none text-[14px] leading-snug">
        <span className="text-[#374151]">I have read and agree to the </span>
        {/* Opens in a new tab on purpose — navigating away would drop the
            other checkbox and make them start over. */}
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={e => e.stopPropagation()}
          className="font-semibold text-[#0068d6] underline underline-offset-2 hover:text-[#01498f]"
        >
          {label}
        </a>
        <span className="mt-0.5 block text-[12.5px] text-[#6b7280]">{hint}</span>
      </label>
    </div>
  )
}
