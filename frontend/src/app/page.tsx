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

// ─── Glassmorphism phase card ───────────────────────────────────────────────
function PhaseCard({
  progress, phase, label, title, body, align = 'right',
}: {
  progress: number
  phase: readonly [number, number]
  label: string
  title: React.ReactNode
  body: string
  align?: 'left' | 'right' | 'center'
}) {
  const opacity = rangeOpacity(progress, phase)
  const visible = opacity > 0.001
  const alignClass =
    align === 'left'   ? 'left-6 md:left-16 right-auto' :
    align === 'right'  ? 'right-6 md:right-16 left-auto' :
                         'left-1/2 -translate-x-1/2 right-auto'
  return (
    <div
      className={`pointer-events-none absolute top-1/2 -translate-y-1/2 max-w-md ${alignClass}`}
      style={{
        opacity,
        transform: `translateY(calc(-50% + ${(1 - opacity) * 16}px))`,
        transition: 'opacity 180ms linear, transform 180ms linear',
        visibility: visible ? 'visible' : 'hidden',
      }}
    >
      <div
        className="rounded-2xl p-6 md:p-7 backdrop-blur-xl"
        style={{
          background: 'linear-gradient(135deg, rgba(255,255,255,0.08), rgba(255,255,255,0.02))',
          border: '1px solid rgba(255,255,255,0.12)',
          boxShadow: '0 24px 60px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.08)',
        }}
      >
        <div className="text-[10px] font-bold text-blue-300/90 tracking-[0.25em] uppercase mb-3 font-mono">
          {label}
        </div>
        <h3 className="text-2xl md:text-3xl font-bold text-white leading-tight mb-3 tracking-tight">
          {title}
        </h3>
        <p className="text-white/70 text-sm md:text-[15px] leading-relaxed font-light">
          {body}
        </p>
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
      className="relative rounded-2xl p-7 md:p-9 backdrop-blur-xl group hover:bg-white/[0.04] transition-colors"
      style={{
        background: 'linear-gradient(135deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01))',
        border: '1px solid rgba(255,255,255,0.08)',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05)',
      }}
    >
      <div
        className="text-blue-300/80 font-mono text-xs tracking-[0.3em] uppercase mb-5"
      >
        {num}
      </div>
      <h3 className="text-xl md:text-2xl font-semibold text-white mb-3 tracking-tight">
        {title}
      </h3>
      <p className="text-white/55 text-sm md:text-[15px] leading-relaxed font-light">
        {body}
      </p>
      {/* subtle hover glow */}
      <div
        className="absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
        style={{
          background: 'radial-gradient(ellipse at top, rgba(96,165,250,0.08), transparent 70%)',
        }}
      />
    </motion.div>
  )
}

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
    <main className="bg-[#02060f] text-white font-sans selection:bg-blue-500/30">
      {/* Global typography niceties — modern tech feel */}
      <style jsx global>{`
        html { scroll-behavior: auto; }
        body { background: #02060f; }
        .font-display { font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif; letter-spacing: -0.02em; }
      `}</style>

      <Nav />

      {/* ─── HERO: scroll-driven 3D house frame sequence ─────────────────── */}
      <HeroImageScene
        image="/hero/house-hero.jpg"
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

        {/* ── Phase cards: appear at the right beats of the build ──────── */}
        <PhaseCard
          progress={progress}
          phase={PHASE_ANALYZE}
          label="01 · Blueprint Analysis"
          title={<>AI reads your blueprint.</>}
          body="Vision models identify rooms, walls, dimensions, openings, and structural elements within seconds — no manual measuring."
          align="right"
        />
        <PhaseCard
          progress={progress}
          phase={PHASE_BUILD}
          label="02 · Materials & Cost"
          title={<>Every board, brick, fixture.</>}
          body="Lumber, drywall, concrete, finishings — quantified, priced against live regional rates, and assembled into a complete project estimate."
          align="left"
        />
        <PhaseCard
          progress={progress}
          phase={PHASE_COMPLIANCE}
          label="03 · Compliance"
          title={<>Code-checked before you submit.</>}
          body="Every plan validated against current local building codes. Failures flagged and explained before the city ever sees the application."
          align="right"
        />
        <PhaseCard
          progress={progress}
          phase={PHASE_PERMIT}
          label="04 · Permit Filing"
          title={<>From blueprint to filed permit.</>}
          body="Permit packets pre-filled with project data, contractor profile, and required documentation — ready for submission to your jurisdiction."
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

      {/* ─── Capabilities (below the cinematic hero) ─────────────────────── */}
      <section className="relative px-6 md:px-10 py-32 md:py-40">
        {/* Faint grid background */}
        <div
          className="absolute inset-0 opacity-[0.04] pointer-events-none"
          style={{
            backgroundImage: `
              linear-gradient(rgba(255,255,255,1) 1px, transparent 1px),
              linear-gradient(90deg, rgba(255,255,255,1) 1px, transparent 1px)
            `,
            backgroundSize: '64px 64px',
          }}
        />
        <div className="relative max-w-6xl mx-auto">
          <FadeIn>
            <div className="text-center mb-20">
              <div className="text-blue-300/80 text-[10px] font-mono tracking-[0.3em] uppercase mb-5">
                Capabilities
              </div>
              <h2 className="font-display text-4xl md:text-6xl font-bold text-white tracking-tight leading-tight max-w-3xl mx-auto">
                Everything a contractor needs.
                <br />
                <span className="text-white/40">One platform.</span>
              </h2>
            </div>
          </FadeIn>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
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
      <section className="relative py-24 px-6 border-y border-white/[0.06]">
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
                  style={{ backgroundImage: 'linear-gradient(180deg, #ffffff 0%, #4A90E2 130%)' }}
                >
                  {s.value}
                </div>
                <div className="text-white/40 text-xs md:text-sm font-mono tracking-widest uppercase">
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
            <div className="text-red-300/80 text-[10px] font-mono tracking-[0.3em] uppercase mb-5">
              Without Axis
            </div>
            <h3 className="font-display text-3xl md:text-4xl font-bold text-white/55 mb-10 tracking-tight leading-tight">
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
                <li key={item} className="flex items-start gap-3 text-white/45 text-[15px] font-light leading-relaxed">
                  <span className="mt-2 w-3.5 h-px bg-red-400/40 flex-shrink-0" />
                  {item}
                </li>
              ))}
            </ul>
          </FadeIn>

          <FadeIn delay={0.15}>
            <div
              className="relative rounded-3xl p-8 md:p-10 backdrop-blur-xl"
              style={{
                background: 'linear-gradient(135deg, rgba(59,130,246,0.08), rgba(59,130,246,0.02))',
                border: '1px solid rgba(96,165,250,0.20)',
                boxShadow: '0 24px 60px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.06)',
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

      {/* ─── Final CTA ───────────────────────────────────────────────────── */}
      <section className="relative px-6 py-32 md:py-44 overflow-hidden">
        {/* Ambient glow */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              'radial-gradient(ellipse 60% 70% at 50% 50%, rgba(59,130,246,0.18), transparent 60%)',
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
            <p className="text-white/55 text-base md:text-lg font-light max-w-md mx-auto mb-10">
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
      <footer className="relative border-t border-white/[0.06] px-6 md:px-10 py-8 flex items-center justify-between text-white/30 text-xs">
        <span className="font-semibold text-white/55">Axis Performance</span>
        <span className="font-mono tracking-wide">© 2026 · Built for contractors</span>
      </footer>
    </main>
  )
}
