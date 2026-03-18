"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { motion, useAnimation, useInView } from "framer-motion";

// ─── Scroll Indicator ─────────────────────────────────────────────────────────

function ScrollIndicator() {
  const handleScroll = () => {
    document.getElementById("features")?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <motion.button
      onClick={handleScroll}
      className="flex flex-col items-center gap-1 cursor-pointer mt-10"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay: 1.8 }}
    >
      <motion.div
        animate={{ y: [0, 5, 0] }}
        transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
        className="flex flex-col items-center gap-0.5"
      >
        <svg width="18" height="11" viewBox="0 0 18 11" fill="none">
          <path d="M1 1L9 9L17 1" stroke="rgba(255,255,255,0.7)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <svg width="24" height="14" viewBox="0 0 24 14" fill="none">
          <path d="M1 1L12 12L23 1" stroke="rgba(255,255,255,0.35)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </motion.div>
      <span className="text-xs text-white/30 font-mono tracking-widest uppercase mt-1">scroll</span>
    </motion.button>
  );
}

// ─── Feature Card ─────────────────────────────────────────────────────────────

function FeatureCard({
  icon, title, desc, highlight = false, delay = 0,
}: {
  icon: string; title: string; desc: string; highlight?: boolean; delay?: number;
}) {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: "-80px" });

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 30 }}
      animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.5, delay }}
      className={`relative rounded-2xl p-7 border transition-all duration-300 hover:-translate-y-1 ${
        highlight
          ? "bg-blue-600/10 border-blue-400/40 hover:border-blue-300/60"
          : "bg-white/5 border-white/10 hover:border-white/20"
      }`}
    >
      {highlight && (
        <div className="absolute -top-3 left-6">
          <span className="bg-blue-500 text-white text-xs font-bold px-3 py-1 rounded-full tracking-wide uppercase">
            Key Feature
          </span>
        </div>
      )}
      <div className="text-3xl mb-4">{icon}</div>
      <h3 className={`text-lg font-bold mb-2 ${highlight ? "text-blue-200" : "text-white"}`}>{title}</h3>
      <p className="text-blue-100/60 text-sm leading-relaxed">{desc}</p>
    </motion.div>
  );
}

// ─── Stat Block ───────────────────────────────────────────────────────────────

function StatBlock({ value, label, delay = 0 }: { value: string; label: string; delay?: number }) {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true });

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, scale: 0.9 }}
      animate={inView ? { opacity: 1, scale: 1 } : {}}
      transition={{ duration: 0.4, delay }}
      className="text-center"
    >
      <div className="text-4xl font-black text-blue-300 mb-1">{value}</div>
      <div className="text-blue-100/50 text-sm">{label}</div>
    </motion.div>
  );
}

// ─── Section Header ───────────────────────────────────────────────────────────

function SectionHeader() {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true });

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 20 }}
      animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.6 }}
      className="text-center mb-20"
    >
      <div className="text-blue-300 text-xs font-bold tracking-widest uppercase mb-4">Platform Overview</div>
      <h2 className="text-4xl sm:text-5xl font-black text-white mb-5 leading-tight">
        AI-Powered Permit &<br />Blueprint Automation
      </h2>
      <p className="text-blue-100/60 text-lg max-w-2xl mx-auto">
        Everything a contractor needs — from raw blueprint to approved permit — automated in one platform.
      </p>
    </motion.div>
  );
}

// ─── Before / After ───────────────────────────────────────────────────────────

function BeforeColumn() {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true });

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, x: -40 }}
      animate={inView ? { opacity: 1, x: 0 } : {}}
      transition={{ duration: 0.6 }}
    >
      <div className="text-red-400 text-xs font-bold tracking-widest uppercase mb-4">Without Axis</div>
      <h3 className="text-3xl font-black text-white mb-8">Hours of manual work</h3>
      <ul className="space-y-5">
        {[
          "Manually review blueprints page by page",
          "Build material spreadsheets from scratch",
          "Calculate cost estimates by hand",
          "Research local building codes",
          "Navigate complex permit portals",
          "Re-submit rejected applications",
        ].map((item, i) => (
          <li key={i} className="flex items-start gap-3 text-blue-100/60">
            <span className="mt-1 w-5 h-5 rounded-full border border-red-500/40 flex items-center justify-center flex-shrink-0">
              <span className="w-2 h-0.5 bg-red-500/60 rounded" />
            </span>
            {item}
          </li>
        ))}
      </ul>
    </motion.div>
  );
}

function AfterColumn() {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true });

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, x: 40 }}
      animate={inView ? { opacity: 1, x: 0 } : {}}
      transition={{ duration: 0.6, delay: 0.15 }}
      className="relative"
    >
      <div className="absolute -inset-4 bg-blue-400/5 rounded-3xl border border-blue-400/15" />
      <div className="relative p-2">
        <div className="text-blue-300 text-xs font-bold tracking-widest uppercase mb-4">With Axis</div>
        <h3 className="text-3xl font-black text-white mb-8">
          Automated in <span className="text-blue-300">seconds</span>
        </h3>
        <ul className="space-y-5">
          {[
            "AI reads and interprets blueprints instantly",
            "Material lists generated automatically",
            "Cost projections in real time",
            "All building codes checked automatically",
            "Permit applications filed for you",
            "Accurate submissions, fewer rejections",
          ].map((item, i) => (
            <li key={i} className="flex items-start gap-3 text-blue-100/80">
              <span className="mt-1 w-5 h-5 rounded-full bg-blue-400/20 border border-blue-400/40 flex items-center justify-center flex-shrink-0">
                <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                  <path d="M1 4L3.5 6.5L9 1" stroke="rgba(147,197,253,0.9)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              {item}
            </li>
          ))}
        </ul>
      </div>
    </motion.div>
  );
}

// ─── CTA Section ──────────────────────────────────────────────────────────────

function CTASection() {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true });

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 30 }}
      animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.6 }}
      className="max-w-2xl mx-auto text-center"
    >
      <h2 className="text-4xl sm:text-5xl font-black text-white mb-5">
        Save hours<br />
        <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-300 to-white">
          per project.
        </span>
      </h2>
      <p className="text-blue-100/60 text-lg mb-10">
        Join contractors automating their blueprint workflow with Axis Performance.
      </p>
      <Link
        href="/register"
        className="inline-block bg-white text-blue-700 font-bold px-10 py-4 rounded-xl text-lg transition-all duration-200 hover:bg-blue-50 hover:shadow-xl hover:shadow-white/20"
      >
        Get Started Free
      </Link>
    </motion.div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function HomePage() {
  const controls = useAnimation();

  useEffect(() => {
    controls.start({ opacity: 1, x: 0 });
  }, [controls]);

  return (
    <div className="min-h-screen bg-[#1a56a0] text-white font-sans overflow-x-hidden">

      {/* ── NAV ─────────────────────────────────────────────────────────────── */}
      <motion.nav
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 1.0 }}
        className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-8 py-4 bg-[#1a56a0]/70 backdrop-blur-md border-b border-white/10"
      >
        <div className="flex items-center gap-2.5">
          <svg width="26" height="26" viewBox="0 0 28 28" fill="none">
            <rect x="2" y="2" width="24" height="24" rx="4" stroke="rgba(255,255,255,0.8)" strokeWidth="1.5" />
            <line x1="7" y1="8" x2="21" y2="8" stroke="rgba(255,255,255,0.8)" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="7" y1="12" x2="17" y2="12" stroke="rgba(255,255,255,0.5)" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="7" y1="16" x2="19" y2="16" stroke="rgba(255,255,255,0.5)" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="7" y1="20" x2="14" y2="20" stroke="rgba(255,255,255,0.3)" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <span className="text-base font-bold tracking-tight text-white">Axis Performance</span>
        </div>

        <div className="flex items-center gap-3">
          <Link
            href="/login"
            className="text-white text-sm font-medium px-5 py-2 rounded-lg border border-white/30 hover:border-white/70 hover:bg-white/10 transition-all duration-200"
          >
            Sign In
          </Link>
          <Link
            href="/register"
            className="bg-white text-blue-700 text-sm font-bold px-5 py-2 rounded-lg hover:bg-blue-50 transition-all duration-200 shadow-md shadow-black/20"
          >
            Sign Up
          </Link>
        </div>
      </motion.nav>

      {/* ── HERO ────────────────────────────────────────────────────────────── */}
      <section className="relative min-h-screen flex flex-col items-center justify-center overflow-hidden">

        {/* Blueprint unroll reveal — slides from left to right off screen */}
        <motion.div
          className="absolute inset-0 bg-[#1a56a0] origin-left z-20"
          initial={{ scaleX: 1 }}
          animate={{ scaleX: 0 }}
          transition={{ duration: 1.1, ease: [0.76, 0, 0.24, 1] }}
        />

        {/* Hero background image */}
        <div
          className="absolute inset-0 bg-cover bg-center bg-no-repeat"
          style={{ backgroundImage: "url('/blueprint-hero.png')" }}
        />

        {/* Dark overlay so text is crisp */}
        <div className="absolute inset-0 bg-[#1a3a6b]/55" />

        {/* Subtle vignette */}
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_75%_65%_at_50%_50%,transparent,rgba(10,30,70,0.45))] pointer-events-none" />

        {/* Hero text */}
        <div className="relative z-10 flex flex-col items-center text-center px-6 pt-20">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 1.2 }}
            className="inline-flex items-center gap-2 bg-white/10 border border-white/25 text-white text-xs font-semibold px-4 py-2 rounded-full mb-6 tracking-widest uppercase backdrop-blur-sm"
          >
            <span className="w-1.5 h-1.5 bg-white rounded-full animate-pulse" />
            AI-Powered Blueprint Platform
          </motion.div>

          <motion.h1
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 1.4 }}
            className="text-6xl sm:text-7xl font-black tracking-tight mb-6 leading-none"
            style={{ textShadow: "0 2px 40px rgba(0,0,0,0.6)" }}
          >
            Axis
            <br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-white to-blue-200">
              Performance
            </span>
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 1.7 }}
            className="text-white/80 text-lg max-w-md mb-10 leading-relaxed"
            style={{ textShadow: "0 1px 12px rgba(0,0,0,0.5)" }}
          >
            Upload a blueprint. Get instant room detection, material lists, cost
            estimates, compliance checks — and automatic permit filing.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 1.9 }}
            className="flex flex-col sm:flex-row gap-4"
          >
            <Link
              href="/register"
              className="bg-white text-blue-700 font-bold px-8 py-3.5 rounded-xl text-base transition-all duration-200 hover:bg-blue-50 hover:shadow-lg hover:shadow-black/40"
            >
              Get Started Free
            </Link>
            <Link
              href="/login"
              className="bg-white/10 hover:bg-white/20 border border-white/30 backdrop-blur-sm text-white font-semibold px-8 py-3.5 rounded-xl text-base transition-all duration-200"
            >
              Sign In
            </Link>
          </motion.div>

          <ScrollIndicator />
        </div>
      </section>

      {/* ── FEATURES ────────────────────────────────────────────────────────── */}
      <section id="features" className="relative py-32 px-6 bg-[#0f3a75]">
        <div
          className="absolute inset-0 opacity-20 pointer-events-none"
          style={{
            backgroundImage: `
              linear-gradient(rgba(255,255,255,0.08) 1px, transparent 1px),
              linear-gradient(90deg, rgba(255,255,255,0.08) 1px, transparent 1px)
            `,
            backgroundSize: "60px 60px",
          }}
        />
        <div className="relative max-w-6xl mx-auto">
          <SectionHeader />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            <FeatureCard icon="📤" title="Upload & Analyze"
              desc="Drop any blueprint PDF and let the AI immediately scan and interpret structural details, layout, and measurements."
              delay={0} />
            <FeatureCard icon="🏗️" title="Smart Blueprint Breakdown"
              desc="Automatically identifies rooms, layout structure, and generates organized material lists — lumber, drywall, concrete, fixtures, and more."
              delay={0.1} />
            <FeatureCard icon="💰" title="Cost Estimation"
              desc="AI-generated cost projections based on detected materials, square footage, and structural complexity."
              delay={0.2} />
            <FeatureCard icon="⚠️" title="Compliance Detection"
              desc="Reviews plans against current building codes. Flags violations, risks, and missing requirements before you submit."
              delay={0.3} />
            <FeatureCard icon="📑" title="Automated Permit Filing"
              desc="Automatically fills permit applications, attaches required documents, and submits directly to city and county systems. No portal navigation required."
              highlight delay={0.4} />
            <FeatureCard icon="⚡" title="Instant Results"
              desc="Full analysis in under 2 minutes. What used to take hours of manual work now takes seconds."
              delay={0.5} />
          </div>
        </div>
      </section>

      {/* ── STATS ───────────────────────────────────────────────────────────── */}
      <section className="py-24 px-6 border-y border-white/10 bg-[#1a56a0]">
        <div className="max-w-4xl mx-auto grid grid-cols-2 sm:grid-cols-4 gap-12">
          <StatBlock value="< 2min" label="Full analysis time" delay={0} />
          <StatBlock value="90%" label="Reduction in admin work" delay={0.1} />
          <StatBlock value="100+" label="Building codes checked" delay={0.2} />
          <StatBlock value="$0" label="Extra software needed" delay={0.3} />
        </div>
      </section>

      {/* ── VALUE PROPOSITION ───────────────────────────────────────────────── */}
      <section className="py-32 px-6 bg-[#0f3a75]">
        <div className="max-w-6xl mx-auto grid md:grid-cols-2 gap-16 items-center">
          <BeforeColumn />
          <AfterColumn />
        </div>
      </section>

      {/* ── CTA ─────────────────────────────────────────────────────────────── */}
      <section className="py-32 px-6 bg-[#1a56a0]">
        <CTASection />
      </section>

      {/* ── FOOTER ──────────────────────────────────────────────────────────── */}
      <footer className="border-t border-white/10 px-8 py-6 flex items-center justify-between text-white/30 text-sm bg-[#0f3a75]">
        <span className="font-semibold text-white/50">Axis Performance</span>
        <span>© 2026 · Built for contractors</span>
      </footer>
    </div>
  );
}
