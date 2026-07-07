'use client'
/**
 * Axis Performance — cinematic landing page.
 *
 * Scroll-driven frame sequence as the hero (house rotates + builds itself
 * piece by piece as the user scrolls). Glassmorphism content cards are
 * layered over the canvas with scroll-progress-tied opacity so the copy
 * appears at the right beats of the animation.
 *
 * NOTE: this is a pure presentation rewrite. No backend code, no auth
 * logic, no API contracts are touched.
 */

import { useState } from 'react'
import Link from 'next/link'
import { motion, useInView } from 'framer-motion'
import { useRef, useEffect } from 'react'
import HeroImageScene from '@/components/HeroImageScene'

// ─── Scroll progress phases ─────────────────────────────────────────────────
// Each phase = (start, end) in 0..1 progress. Used to fade overlay cards
// in and out as the house animation advances.
const PHASE_INTRO    = [0.00, 0.18] as const
const PHASE_ANALYZE  = [0.20, 0.40] as const
const PHASE_BUILD    = [0.42, 0.62] as const
const PHASE_COMPLIANCE = [0.64, 0.82] as const
const PHASE_PERMIT   = [0.84, 1.00] as const

function rangeOpacity(progress: number, [start, end]: readonly [number, number]) {
  // Fade in over the first 25% of the phase, fade out over the last 25%
  if (progress < start || progress > end) return 0
  const fadeIn = (end - start) * 0.25
  if (progress < start + fadeIn) return (progress - start) / fadeIn
  if (progress > end - fadeIn) return (end - progress) / fadeIn
  return 1
}

// ─── Premium scroll-reveal phase card ───────────────────────────────────────
function PhaseCard({
  progress, phase, label, title, body, icon, chips = [], align = 'right',
}: {
  progress: number
  phase: readonly [number, number]
  label: string
  title: React.ReactNode
  body: string
  icon: React.ReactNode
  chips?: string[]
  align?: 'left' | 'right' | 'center'
}) {
  const opacity = rangeOpacity(progress, phase)
  const visible = opacity > 0.001
  const alignClass =
    align === 'left'   ? 'left-5 md:left-20 right-auto' :
    align === 'right'  ? 'right-5 md:right-20 left-auto' :
                         'left-1/2 -translate-x-1/2 right-auto'
  return (
    <div
      className={`pointer-events-none absolute top-1/2 w-[min(92vw,31rem)] ${alignClass}`}
      style={{
        opacity,
        transform: `translateY(calc(-50% + ${(1 - opacity) * 26}px)) scale(${0.955 + opacity * 0.045})`,
        transition: 'opacity 200ms ease, transform 240ms cubic-bezier(0.22,1,0.36,1)',
        visibility: visible ? 'visible' : 'hidden',
      }}
    >
      {/* ambient glow behind the card */}
      <div
        className="absolute -inset-8 rounded-[2.5rem] blur-3xl"
        style={{ background: 'radial-gradient(ellipse at 28% 18%, rgba(59,130,246,0.38), transparent 64%)', opacity }}
      />
      {/* gradient hairline border */}
      <div
        className="relative rounded-[1.6rem] p-px"
        style={{ background: 'linear-gradient(135deg, rgba(150,200,255,0.55), rgba(255,255,255,0.05) 45%, rgba(59,130,246,0.42))' }}
      >
        <div
          className="relative overflow-hidden rounded-[1.55rem] p-7 md:p-8"
          style={{
            background: 'linear-gradient(155deg, rgba(12,19,38,0.88), rgba(6,11,24,0.93))',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.10), 0 50px 90px -40px rgba(0,0,0,0.9)',
            backdropFilter: 'blur(22px)',
            WebkitBackdropFilter: 'blur(22px)',
          }}
        >
          {/* top accent shimmer + diagonal sheen */}
          <div className="absolute inset-x-10 top-0 h-px" style={{ background: 'linear-gradient(90deg, transparent, rgba(150,200,255,0.9), transparent)' }} />
          <div className="pointer-events-none absolute -right-1/4 -top-1/2 h-[150%] w-2/3 rotate-12 opacity-[0.06]" style={{ background: 'linear-gradient(180deg, #fff, transparent)' }} />

          <div className="mb-5 flex items-center gap-3">
            <div
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-blue-100"
              style={{
                background: 'linear-gradient(160deg, rgba(59,130,246,0.45), rgba(59,130,246,0.08))',
                border: '1px solid rgba(150,200,255,0.45)',
                boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.3), 0 0 28px rgba(59,130,246,0.4)',
              }}
            >
              {icon}
            </div>
            <div className="font-mono text-[10px] font-bold uppercase tracking-[0.26em] text-blue-300/90">{label}</div>
          </div>

          <h3 className="mb-3 text-[27px] md:text-[33px] font-bold leading-[1.07] tracking-tight text-white">{title}</h3>
          <p className="text-[14.5px] md:text-[15px] leading-relaxed text-white/65 font-light">{body}</p>

          {chips.length > 0 && (
            <div className="mt-5 flex flex-wrap gap-2">
              {chips.map(c => (
                <span key={c} className="rounded-full border border-white/[0.12] bg-white/[0.04] px-3 py-1 text-[11px] font-medium tracking-wide text-blue-100/85">
                  {c}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Animated section header for the below-fold sections ───────────────────
function FadeIn({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) {
  const ref = useRef(null)
  const inView = useInView(ref, { once: true, margin: '-80px' })
  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 24 }}
      animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.7, delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  )
}

// ─── Capability block (used in detail section below the fold) ──────────────
function Capability({
  num, title, body,
}: { num: string; title: string; body: string }) {
  const ref = useRef(null)
  const inView = useInView(ref, { once: true, margin: '-100px' })
  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 30 }}
      animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
      className="group relative rounded-3xl bg-white p-8 md:p-10 transition-transform duration-300 hover:-translate-y-1"
      style={{
        border: '1px solid rgba(15,23,42,0.08)',
        boxShadow: '0 18px 50px -28px rgba(15,40,80,0.25)',
      }}
    >
      <div
        className="text-blue-600/80 font-mono text-xs tracking-[0.3em] uppercase mb-5"
      >
        {num}
      </div>
      <h3 className="text-2xl md:text-[26px] font-semibold text-slate-900 mb-3.5 tracking-tight leading-tight">
        {title}
      </h3>
      <p className="text-slate-500 text-[15px] md:text-base leading-relaxed font-light">
        {body}
      </p>
      {/* subtle hover glow */}
      <div
        className="absolute inset-0 rounded-3xl opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
        style={{
          background: 'radial-gradient(ellipse at top, rgba(59,130,246,0.07), transparent 70%)',
        }}
      />
    </motion.div>
  )
}

// minimal, consistent line icons (used by the scroll-reveal phase cards)
const ic = (d: React.ReactNode) => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{d}</svg>
)
const ICON_SATELLITE = ic(<><circle cx="12" cy="12" r="3.2" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" /></>)
const ICON_AI = ic(<><path d="M12 3l1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5 10.1 7.6z" /><path d="M18.5 3.5l.6 1.5 1.5.6-1.5.6-.6 1.5-.6-1.5L16.4 5.6l1.5-.6z" /></>)
const ICON_CAMERA = ic(<><path d="M3 8.5A2 2 0 015 6.5h1.6L8 4.5h8l1.4 2H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z" /><circle cx="12" cy="12.5" r="3.3" /></>)
const ICON_DOC = ic(<><path d="M14 3H7a1 1 0 00-1 1v16a1 1 0 001 1h11a1 1 0 001-1V8z" /><path d="M14 3v5h5M9 13h6M9 17h5" /></>)

// ─── Nav (glassmorphism, dark) ──────────────────────────────────────────────
function Nav() {
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 50)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])
  return (
    <nav
      className="fixed top-0 left-0 right-0 z-50 transition-all duration-300"
      style={{
        background: scrolled ? 'rgba(2,6,18,0.72)' : 'rgba(2,6,18,0.35)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        borderBottom: scrolled ? '1px solid rgba(255,255,255,0.06)' : '1px solid transparent',
      }}
    >
      <div className="max-w-7xl mx-auto flex items-center justify-between px-6 md:px-10 py-4">
        <div className="flex items-center gap-2.5">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center"
            style={{
              background: 'linear-gradient(180deg, #1B2433 0%, #06090E 100%)',
              border: '1px solid rgba(127,201,244,0.45)',
              boxShadow: '0 0 0 1px rgba(127,201,244,0.20), 0 4px 12px -4px rgba(127,201,244,0.45)',
            }}
          >
            <svg width="16" height="16" viewBox="0 0 28 28" fill="none">
              <path d="M14 4 L24 24 H19 L17 19 H11 L9 24 H4 Z" fill="#BFE6FF" />
              <path d="M12.5 15 H15.5 L14 11 Z" fill="#06090E" />
            </svg>
          </div>
          <span className="text-white font-semibold text-[15px] tracking-tight">Axis Performance</span>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/login"
            className="text-white/80 hover:text-white text-sm font-medium px-4 py-2 rounded-lg hover:bg-white/5 transition-all"
          >
            Sign In
          </Link>
          <Link
            href="/register"
            className="text-white text-sm font-semibold px-4 py-2 rounded-lg transition-all"
            style={{
              background: 'linear-gradient(180deg, #3B82F6 0%, #1E40AF 100%)',
              boxShadow: '0 4px 14px rgba(59,130,246,0.45), inset 0 1px 0 rgba(255,255,255,0.2)',
            }}
          >
            Get Started
          </Link>
        </div>
      </div>
    </nav>
  )
}

// ─── Main page ──────────────────────────────────────────────────────────────
export default function HomePage() {
  const [progress, setProgress] = useState(0)

  return (
    <main className="bg-[#f7f9fc] text-slate-900 font-sans selection:bg-blue-500/20">
      {/* Global typography niceties — modern tech feel */}
      <style jsx global>{`
        html { scroll-behavior: auto; }
        body { background: #02060f; }
        .font-display { font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif; letter-spacing: -0.02em; }
      `}</style>

      <Nav />

      {/* ─── HERO: scroll-driven 3D house frame sequence ─────────────────── */}
      <HeroImageScene
        image="/hero/digital-twin-hero.jpg"
        trackHeightVh={500}
        onProgress={setProgress}
      >
        {/* ── Hero title (always visible, fades during the build phases) ── */}
        <div
          className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center px-6"
          style={{
            opacity: 1 - Math.min(1, progress * 4.5),
            transition: 'opacity 180ms linear',
          }}
        >
          <div className="inline-flex items-center gap-2 text-[10px] font-bold tracking-[0.3em] uppercase text-blue-300/90 mb-6 font-mono">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
            AI Blueprint & Permit Platform
          </div>
          <h1
            className="font-display font-bold text-white text-5xl sm:text-7xl md:text-8xl leading-[0.95] mb-6"
            style={{ textShadow: '0 4px 60px rgba(0,0,0,0.6)' }}
          >
            Build smarter.
            <br />
            <span
              className="text-transparent bg-clip-text"
              style={{
                backgroundImage: 'linear-gradient(180deg, #BFE6FF 0%, #4A90E2 100%)',
              }}
            >
              Permit faster.
            </span>
          </h1>
          <p className="text-white/65 text-base md:text-lg max-w-xl mx-auto font-light leading-relaxed mb-10">
            Upload a blueprint. Get instant room detection, material lists,
            cost estimates, code compliance, and automatic permit filing —
            in under two minutes.
          </p>
          <div className="pointer-events-auto flex flex-col sm:flex-row gap-3">
            <Link
              href="/register"
              className="text-white font-semibold text-sm px-7 py-3.5 rounded-xl transition-all hover:scale-[1.02]"
              style={{
                background: 'linear-gradient(180deg, #3B82F6 0%, #1E40AF 100%)',
                boxShadow: '0 8px 28px rgba(59,130,246,0.5), inset 0 1px 0 rgba(255,255,255,0.2)',
              }}
            >
              Get Started Free
            </Link>
            <Link
              href="/login"
              className="text-white/90 font-semibold text-sm px-7 py-3.5 rounded-xl backdrop-blur-md transition-all hover:bg-white/10"
              style={{
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.12)',
              }}
            >
              Sign In
            </Link>
          </div>

          {/* Scroll hint */}
          <div
            className="absolute bottom-12 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2"
            style={{ opacity: 1 - Math.min(1, progress * 8) }}
          >
            <span className="text-white/35 text-[10px] font-mono tracking-[0.4em] uppercase">Scroll to build</span>
            <motion.div
              animate={{ y: [0, 6, 0] }}
              transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
            >
              <svg width="16" height="22" viewBox="0 0 16 22" fill="none">
                <rect x="1" y="1" width="14" height="20" rx="7" stroke="rgba(255,255,255,0.45)" strokeWidth="1.2" />
                <line x1="8" y1="6" x2="8" y2="10" stroke="rgba(255,255,255,0.7)" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
            </motion.div>
          </div>
        </div>

        {/* ── Roofing story: cards reveal as you scroll the house ──────── */}
        <PhaseCard
          progress={progress}
          phase={PHASE_ANALYZE}
          icon={ICON_SATELLITE}
          label="01 · Aerial Measurement"
          title={<>Measure the roof<br />from the sky.</>}
          body="Trace the roof on high-resolution satellite imagery and get square footage, pitch, ridges, hips, valleys, and eaves — accurate to the foot. No ladder. No drone."
          chips={['Satellite imagery', 'Exact pitch', 'No ladder']}
          align="right"
        />
        <PhaseCard
          progress={progress}
          phase={PHASE_BUILD}
          icon={ICON_AI}
          label="02 · AI Detection"
          title={<>AI finds<br />every facet.</>}
          body="Vision AI proposes the roof planes and edge types for you to confirm — and where Google Solar has coverage, it pulls in measured pitch and plane geometry automatically."
          chips={['Vision AI', 'Google Solar', 'Measured pitch']}
          align="left"
        />
        <PhaseCard
          progress={progress}
          phase={PHASE_COMPLIANCE}
          icon={ICON_CAMERA}
          label="03 · Ground Intelligence"
          title={<>Photos fill<br />in the rest.</>}
          body="A few shots from the driveway read pitch, chimneys, dormers, and material — then step, valley, and chimney flashing are quantified and priced as orderable SKUs."
          chips={['Phone photos', 'Flashing SKUs', 'Materials']}
          align="right"
        />
        <PhaseCard
          progress={progress}
          phase={PHASE_PERMIT}
          icon={ICON_DOC}
          label="04 · Client-Ready Report"
          title={<>Send a pro report<br />in minutes.</>}
          body="A branded, EagleView-class PDF — facet diagrams, full measurements, and a complete material takeoff — delivered to your customer for a fraction of the usual cost."
          chips={['Branded PDF', 'Full takeoff', 'Minutes']}
          align="left"
        />

        {/* Subtle scroll-progress dots on the side (premium navigation feel) */}
        <div className="hidden md:flex pointer-events-none absolute right-6 top-1/2 -translate-y-1/2 flex-col gap-3">
          {[PHASE_INTRO, PHASE_ANALYZE, PHASE_BUILD, PHASE_COMPLIANCE, PHASE_PERMIT].map((p, i) => {
            const active = progress >= p[0] && progress <= p[1]
            return (
              <div
                key={i}
                className="w-1.5 h-1.5 rounded-full transition-all duration-300"
                style={{
                  background: active ? '#60A5FA' : 'rgba(255,255,255,0.18)',
                  boxShadow: active ? '0 0 12px rgba(96,165,250,0.7)' : 'none',
                  transform: active ? 'scale(1.6)' : 'scale(1)',
                }}
              />
            )
          })}
        </div>
      </HeroImageScene>

      {/* Dark hero → light content transition band */}
      <div className="h-32 w-full" style={{ background: 'linear-gradient(180deg, #02060f 0%, #f7f9fc 100%)' }} />

      {/* ─── Capabilities (below the cinematic hero) ─────────────────────── */}
      <section className="relative px-6 md:px-10 py-28 md:py-36">
        {/* Faint grid background */}
        <div
          className="absolute inset-0 opacity-[0.05] pointer-events-none"
          style={{
            backgroundImage: `
              linear-gradient(rgba(15,23,42,1) 1px, transparent 1px),
              linear-gradient(90deg, rgba(15,23,42,1) 1px, transparent 1px)
            `,
            backgroundSize: '64px 64px',
          }}
        />
        <div className="relative max-w-6xl mx-auto">
          <FadeIn>
            <div className="text-center mb-20">
              <div className="text-blue-600/80 text-[10px] font-mono tracking-[0.3em] uppercase mb-5">
                Capabilities
              </div>
              <h2 className="font-display text-4xl md:text-6xl font-bold text-slate-900 tracking-tight leading-tight max-w-3xl mx-auto">
                Everything a contractor needs.
                <br />
                <span className="text-slate-400">One platform.</span>
              </h2>
            </div>
          </FadeIn>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Capability
              num="01"
              title="Blueprint analysis"
              body="Drop any PDF or image. Vision AI identifies rooms, walls, dimensions, openings, and structural elements — instantly."
            />
            <Capability
              num="02"
              title="Material takeoff"
              body="Quantities for lumber, drywall, concrete, fixtures, and finishings — broken out by category with live regional pricing."
            />
            <Capability
              num="03"
              title="Cost estimation"
              body="Region-adjusted cost projections grounded in real material prices, labor estimates, and project complexity."
            />
            <Capability
              num="04"
              title="Code compliance"
              body="Plans cross-checked against the relevant local building codes. Failures flagged with specific reasoning and citations."
            />
            <Capability
              num="05"
              title="Permit packaging"
              body="Permit applications pre-filled from your project + contractor profile. Required documents attached and ready to submit."
            />
            <Capability
              num="06"
              title="Aerial roofing"
              body="Trace the property's roof on a satellite tile for accurate square footage, perimeter, and pitch — without leaving the office."
            />
          </div>
        </div>
      </section>

      {/* ─── Stats strip ─────────────────────────────────────────────────── */}
      <section className="relative border-y border-slate-200 bg-white py-24 px-6">
        <div className="max-w-5xl mx-auto grid grid-cols-2 md:grid-cols-4 gap-10 md:gap-16">
          {[
            { value: '< 2min', label: 'Full analysis' },
            { value: '90%', label: 'Less admin work' },
            { value: '100+', label: 'Codes checked' },
            { value: '24/7', label: 'AI on call' },
          ].map((s, i) => (
            <FadeIn key={s.label} delay={i * 0.08}>
              <div className="text-center md:text-left">
                <div
                  className="font-display text-4xl md:text-5xl font-bold text-transparent bg-clip-text mb-2"
                  style={{ backgroundImage: 'linear-gradient(180deg, #0f172a 0%, #2563eb 130%)' }}
                >
                  {s.value}
                </div>
                <div className="text-slate-400 text-xs md:text-sm font-mono tracking-widest uppercase">
                  {s.label}
                </div>
              </div>
            </FadeIn>
          ))}
        </div>
      </section>

      {/* ─── Before / After ──────────────────────────────────────────────── */}
      <section className="relative px-6 md:px-10 py-32 md:py-40">
        <div className="max-w-6xl mx-auto grid md:grid-cols-2 gap-12 md:gap-20 items-start">
          <FadeIn>
            <div className="text-red-500/80 text-[10px] font-mono tracking-[0.3em] uppercase mb-5">
              Without Axis
            </div>
            <h3 className="font-display text-3xl md:text-4xl font-bold text-slate-400 mb-10 tracking-tight leading-tight">
              Hours of manual work.
            </h3>
            <ul className="space-y-4">
              {[
                'Manually review blueprints page by page',
                'Build material spreadsheets from scratch',
                'Calculate cost estimates by hand',
                'Research local building codes',
                'Navigate complex permit portals',
                'Re-submit rejected applications',
              ].map(item => (
                <li key={item} className="flex items-start gap-3 text-slate-500 text-[15px] font-light leading-relaxed">
                  <span className="mt-2 w-3.5 h-px bg-red-400/60 flex-shrink-0" />
                  {item}
                </li>
              ))}
            </ul>
          </FadeIn>

          <FadeIn delay={0.15}>
            {/* Dark navy anchor card — deliberate contrast pop on the light page */}
            <div
              className="relative rounded-3xl p-8 md:p-10"
              style={{
                background: 'linear-gradient(150deg, #0b1526 0%, #0e1f3f 100%)',
                border: '1px solid rgba(96,165,250,0.25)',
                boxShadow: '0 30px 70px -25px rgba(13,30,66,0.55), inset 0 1px 0 rgba(255,255,255,0.06)',
              }}
            >
              <div className="text-blue-300 text-[10px] font-mono tracking-[0.3em] uppercase mb-5">
                With Axis
              </div>
              <h3 className="font-display text-3xl md:text-4xl font-bold text-white mb-10 tracking-tight leading-tight">
                Automated in <span className="text-blue-300">seconds.</span>
              </h3>
              <ul className="space-y-4">
                {[
                  'AI reads and interprets blueprints instantly',
                  'Material lists generated automatically',
                  'Cost projections in real time',
                  'All building codes checked automatically',
                  'Permit applications filed for you',
                  'Accurate submissions, fewer rejections',
                ].map(item => (
                  <li key={item} className="flex items-start gap-3 text-white/80 text-[15px] font-light leading-relaxed">
                    <span className="mt-1.5 w-4 h-4 rounded-full bg-blue-500/15 border border-blue-400/40 flex items-center justify-center flex-shrink-0">
                      <svg width="9" height="7" viewBox="0 0 10 8" fill="none">
                        <path d="M1 4L3.5 6.5L9 1" stroke="rgba(147,197,253,0.95)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </FadeIn>
        </div>
      </section>

      {/* ─── Final CTA — deep navy band anchoring the light page ─────────── */}
      <section
        className="relative px-6 py-32 md:py-44 overflow-hidden"
        style={{ background: 'linear-gradient(165deg, #081226 0%, #0c1c3d 60%, #081226 100%)' }}
      >
        {/* Ambient glow */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              'radial-gradient(ellipse 60% 70% at 50% 50%, rgba(59,130,246,0.22), transparent 60%)',
          }}
        />
        <FadeIn>
          <div className="relative max-w-2xl mx-auto text-center">
            <h2 className="font-display text-4xl md:text-6xl font-bold text-white tracking-tight leading-[1.05] mb-6">
              Save hours
              <br />
              <span
                className="text-transparent bg-clip-text"
                style={{ backgroundImage: 'linear-gradient(180deg, #BFE6FF 0%, #4A90E2 100%)' }}
              >
                per project.
              </span>
            </h2>
            <p className="text-white/60 text-base md:text-lg font-light max-w-md mx-auto mb-10">
              Built for contractors who'd rather be building than filing.
            </p>
            <Link
              href="/register"
              className="inline-block text-white font-semibold text-base px-9 py-4 rounded-xl transition-all hover:scale-[1.03]"
              style={{
                background: 'linear-gradient(180deg, #3B82F6 0%, #1E40AF 100%)',
                boxShadow: '0 12px 36px rgba(59,130,246,0.55), inset 0 1px 0 rgba(255,255,255,0.2)',
              }}
            >
              Get Started Free
            </Link>
          </div>
        </FadeIn>
      </section>

      {/* ─── Footer ──────────────────────────────────────────────────────── */}
      <footer className="relative border-t border-slate-200 bg-white px-6 md:px-10 py-8 flex items-center justify-between text-slate-400 text-xs">
        <span className="font-semibold text-slate-700">Axis Performance</span>
        <span className="font-mono tracking-wide">© 2026 · Built for contractors</span>
      </footer>
    </main>
  )
}
