'use client'

/**
 * First-run welcome — what a contractor sees the very first time they land on
 * the dashboard, in place of the morning briefing.
 *
 * Three deliberate choices:
 *
 *  1. It's triggered by STATE, not by a login counter. "Show it until they've
 *     logged in twice" sounds right but misfires both ways: someone can log in
 *     five times without ever tracing a roof and still need the tour, while
 *     someone who set up three jobs on day one does not. Having no projects yet
 *     is the honest signal that you haven't started.
 *  2. It REPLACES the briefing rather than stacking above it. A brand-new
 *     account has no leads and no bookings, so the briefing has nothing to say
 *     — two empty-ish cards competing for the top of the page is worse than one
 *     that's actually addressed to you.
 *  3. It leads with the concrete promise, not with "AI assistant". Axis does
 *     have a real context-aware assistant (AxisChat, bottom-right) and it gets
 *     its own line here — but opening with "your personal AI assistant" invites
 *     someone to type "schedule my crew for Tuesday" in the first ten seconds
 *     and conclude the product is broken when it doesn't. Lead with measuring a
 *     roof from a satellite image, which is the thing it genuinely does better
 *     than anything else they own.
 *
 * Dismissal follows the existing coachmark convention (`axis_*_coach_v1` in
 * localStorage), so it never returns once it's been sent away.
 */
import Link from 'next/link'

export const WELCOME_COACH_KEY = 'axis_welcome_coach_v1'

const STEPS: { n: string; title: string; body: string }[] = [
  {
    n: '1',
    title: 'Measure a roof without leaving your desk',
    body: 'Type an address, confirm the house on the satellite image, trace each roof plane. Axis works out the squares, pitch and every roof line — no ladder, no second trip.',
  },
  {
    n: '2',
    title: 'Turn it into a report you can send',
    body: 'Facets, linear footage and a material list come out the far end as a branded PDF, with a share link the homeowner can open on their phone.',
  },
  {
    n: '3',
    title: 'Run the job from the same place',
    body: 'Leads live in the CRM, crews get scheduled on the Dispatch board by production capacity, and this page tells you each morning what needs chasing.',
  },
]

export default function FirstRunGreeting({ name, onDismiss }: {
  name: string
  onDismiss: () => void
}) {
  return (
    <section
      className="mb-8 overflow-hidden rounded-2xl border border-blue-400/25"
      style={{ background: 'linear-gradient(135deg, rgba(59,130,246,0.14) 0%, rgba(255,255,255,0.03) 60%)' }}
    >
      <div className="flex items-start justify-between gap-4 px-5 pt-5">
        <div>
          <h2 className="text-lg font-bold text-white">Welcome to Axis, {name} 👋</h2>
          <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-slate-300">
            Axis measures roofs from satellite imagery and turns them into quotable reports. Here&apos;s the
            whole workflow in three steps — you can be through it on a real address in about five minutes.
          </p>
        </div>
        <button
          onClick={onDismiss}
          aria-label="Dismiss welcome"
          className="shrink-0 rounded-lg px-2 py-1 text-sm text-slate-400 transition-colors hover:bg-white/5 hover:text-white"
        >✕</button>
      </div>

      <ol className="grid gap-3 px-5 py-4 sm:grid-cols-3">
        {STEPS.map(s => (
          <li key={s.n} className="rounded-xl border border-white/[0.07] bg-white/[0.03] p-3.5">
            <div className="mb-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-blue-600 text-[11px] font-bold text-white">
              {s.n}
            </div>
            <div className="text-[13px] font-semibold text-white">{s.title}</div>
            <p className="mt-1 text-[11.5px] leading-relaxed text-slate-400">{s.body}</p>
          </li>
        ))}
      </ol>

      <div className="border-t border-white/[0.07] px-5 py-3">
        <p className="text-[12px] leading-relaxed text-slate-400">
          <span className="font-semibold text-slate-200">💬 Axis AI is in the bottom-right corner.</span>{' '}
          It knows which page you&apos;re on, so ask it things like &ldquo;why is this pitch flagged?&rdquo; or
          &ldquo;what&apos;s missing from this report?&rdquo; and it answers about the job in front of you.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2 px-5 pb-5">
        <Link
          href="/roof-v2"
          className="rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-500"
        >📐 Measure your first roof →</Link>
        <button
          onClick={onDismiss}
          className="rounded-xl border border-white/12 bg-white/[0.04] px-4 py-2.5 text-sm font-semibold text-slate-200 transition-colors hover:bg-white/[0.08]"
        >I&apos;ll explore on my own</button>
      </div>
    </section>
  )
}
