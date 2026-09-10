/**
 * Shared chrome for the public legal documents (/legal/terms, /legal/privacy).
 *
 * These pages are deliberately outside the (dashboard) group: they must be
 * readable while signed out — from the marketing site, from the acceptance
 * gate, and by anyone a contractor forwards the link to.
 */
import Link from 'next/link'

export function LegalDoc({
  title,
  version,
  children,
}: {
  title: string
  version: string
  children: React.ReactNode
}) {
  return (
    <div className="min-h-screen bg-white">
      <header className="border-b border-[#e5e7eb] bg-[#f8f8f7]">
        <div className="mx-auto flex max-w-3xl items-center gap-2.5 px-6 py-5">
          <div
            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl"
            style={{ background: '#0068d6' }}
          >
            <svg width="17" height="17" viewBox="0 0 28 28" fill="none">
              <path d="M14 4 L24 24 H19 L17 19 H11 L9 24 H4 Z" fill="#BFE6FF" />
              <path d="M12.5 15 H15.5 L14 11 Z" fill="#06090E" />
            </svg>
          </div>
          <div className="leading-none">
            <div className="text-[13px] font-black tracking-tight text-[#1a1a1a]">AXIS</div>
            <div className="mt-0.5 text-[8px] font-bold tracking-[0.3em] text-[#6b7280]">PERFORMANCE</div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-10">
        <h1 className="text-3xl font-bold tracking-tight text-[#1a1a1a]">{title}</h1>
        <p className="mt-2 text-sm text-[#6b7280]">
          Version {version} · RW AI Infrastructure LLC
        </p>
        <div className="legal-body mt-8">{children}</div>

        <div className="mt-12 border-t border-[#e5e7eb] pt-6 text-sm text-[#6b7280]">
          <Link href="/legal/terms" className="text-[#0068d6] underline underline-offset-2">
            Terms of Service
          </Link>
          <span className="mx-2">·</span>
          <Link href="/legal/privacy" className="text-[#0068d6] underline underline-offset-2">
            Privacy Policy
          </Link>
        </div>
      </main>
    </div>
  )
}

/** Section heading. */
export function S({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mt-9 border-b border-[#e5e7eb] pb-2 text-lg font-semibold text-[#1a1a1a]">
      {children}
    </h2>
  )
}

/** Sub-heading. */
export function H({ children }: { children: React.ReactNode }) {
  return <h3 className="mt-6 text-[15px] font-semibold text-[#1a1a1a]">{children}</h3>
}

/** Body paragraph. */
export function P({ children }: { children: React.ReactNode }) {
  return <p className="mt-3 text-[15px] leading-relaxed text-[#374151]">{children}</p>
}

/** Bulleted list. */
export function UL({ children }: { children: React.ReactNode }) {
  return (
    <ul className="mt-3 list-disc space-y-1.5 pl-6 text-[15px] leading-relaxed text-[#374151]">
      {children}
    </ul>
  )
}

/** Callout for the clauses that carry real legal weight. */
export function Callout({ children, tone = 'info' }: { children: React.ReactNode; tone?: 'info' | 'warn' }) {
  const border = tone === 'warn' ? '#dc2626' : '#0068d6'
  return (
    <div
      className="mt-4 rounded-r-lg bg-[#f8f8f7] px-5 py-4 text-[15px] leading-relaxed text-[#374151]"
      style={{ borderLeft: `4px solid ${border}` }}
    >
      {children}
    </div>
  )
}
