"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { motion, useAnimation, useInView } from "framer-motion";

// ─── Blueprint SVG Animation ──────────────────────────────────────────────────

function BlueprintHouse() {
  return (
    <svg viewBox="0 0 800 500" className="w-full h-full" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <pattern id="smallGrid" width="20" height="20" patternUnits="userSpaceOnUse">
          <path d="M 20 0 L 0 0 0 20" fill="none" stroke="rgba(96,165,250,0.15)" strokeWidth="0.5" />
        </pattern>
        <pattern id="grid" width="100" height="100" patternUnits="userSpaceOnUse">
          <rect width="100" height="100" fill="url(#smallGrid)" />
          <path d="M 100 0 L 0 0 0 100" fill="none" stroke="rgba(96,165,250,0.25)" strokeWidth="1" />
        </pattern>
        <filter id="glow">
          <feGaussianBlur stdDeviation="2" result="coloredBlur" />
          <feMerge><feMergeNode in="coloredBlur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>

      <rect width="800" height="500" fill="url(#grid)" />

      {/* Foundation */}
      <motion.rect x="150" y="400" width="500" height="20" rx="2"
        fill="none" stroke="rgba(147,197,253,0.9)" strokeWidth="2.5" filter="url(#glow)"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }}
        transition={{ duration: 0.6, delay: 0.3 }} />

      {/* Walls */}
      <motion.line x1="150" y1="420" x2="150" y2="260"
        stroke="rgba(147,197,253,0.9)" strokeWidth="2.5" filter="url(#glow)"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5, delay: 0.9 }} />
      <motion.line x1="650" y1="420" x2="650" y2="260"
        stroke="rgba(147,197,253,0.9)" strokeWidth="2.5" filter="url(#glow)"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5, delay: 1.0 }} />

      {/* Roof */}
      <motion.line x1="120" y1="260" x2="400" y2="120"
        stroke="rgba(147,197,253,0.9)" strokeWidth="2.5" filter="url(#glow)"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.7, delay: 1.5 }} />
      <motion.line x1="680" y1="260" x2="400" y2="120"
        stroke="rgba(147,197,253,0.9)" strokeWidth="2.5" filter="url(#glow)"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.7, delay: 1.6 }} />
      <motion.line x1="120" y1="260" x2="680" y2="260"
        stroke="rgba(147,197,253,0.9)" strokeWidth="2.5" filter="url(#glow)"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.8, delay: 2.2 }} />

      {/* Door */}
      <motion.rect x="340" y="330" width="60" height="90" rx="2"
        fill="none" stroke="rgba(147,197,253,0.8)" strokeWidth="2" filter="url(#glow)"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4, delay: 2.5 }} />
      <motion.circle cx="392" cy="378" r="4" fill="rgba(147,197,253,0.9)" filter="url(#glow)"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3, delay: 2.8 }} />

      {/* Left window */}
      <motion.rect x="190" y="300" width="80" height="70" rx="2"
        fill="none" stroke="rgba(147,197,253,0.8)" strokeWidth="2" filter="url(#glow)"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4, delay: 2.6 }} />
      <motion.line x1="230" y1="300" x2="230" y2="370"
        stroke="rgba(147,197,253,0.5)" strokeWidth="1"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3, delay: 2.9 }} />
      <motion.line x1="190" y1="335" x2="270" y2="335"
        stroke="rgba(147,197,253,0.5)" strokeWidth="1"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3, delay: 2.9 }} />

      {/* Right window */}
      <motion.rect x="530" y="300" width="80" height="70" rx="2"
        fill="none" stroke="rgba(147,197,253,0.8)" strokeWidth="2" filter="url(#glow)"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4, delay: 2.7 }} />
      <motion.line x1="570" y1="300" x2="570" y2="370"
        stroke="rgba(147,197,253,0.5)" strokeWidth="1"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3, delay: 3.0 }} />
      <motion.line x1="530" y1="335" x2="610" y2="335"
        stroke="rgba(147,197,253,0.5)" strokeWidth="1"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3, delay: 3.0 }} />

      {/* Driveway */}
      <motion.path d="M 310 420 L 270 490 L 530 490 L 490 420 Z"
        fill="none" stroke="rgba(147,197,253,0.5)" strokeWidth="1.5"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5, delay: 3.2 }} />

      {/* Chimney */}
      <motion.rect x="480" y="120" width="35" height="60" rx="2"
        fill="none" stroke="rgba(147,197,253,0.8)" strokeWidth="2" filter="url(#glow)"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4, delay: 2.3 }} />

      {/* Stick figure worker */}
      <motion.circle cx="220" cy="230" r="12" fill="none" stroke="rgba(147,197,253,0.9)" strokeWidth="1.5" filter="url(#glow)"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3, delay: 1.2 }} />
      <motion.line x1="220" y1="242" x2="220" y2="280" stroke="rgba(147,197,253,0.9)" strokeWidth="1.5"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3, delay: 1.3 }} />
      <motion.line x1="220" y1="255" x2="195" y2="240" stroke="rgba(147,197,253,0.9)" strokeWidth="1.5"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3, delay: 1.4 }} />
      <motion.line x1="220" y1="255" x2="245" y2="265" stroke="rgba(147,197,253,0.9)" strokeWidth="1.5"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3, delay: 1.4 }} />
      <motion.line x1="220" y1="280" x2="205" y2="305" stroke="rgba(147,197,253,0.9)" strokeWidth="1.5"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3, delay: 1.5 }} />
      <motion.line x1="220" y1="280" x2="235" y2="305" stroke="rgba(147,197,253,0.9)" strokeWidth="1.5"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3, delay: 1.5 }} />
      <motion.path d="M 185 232 L 178 225 M 178 225 L 183 220 M 183 220 L 190 227"
        fill="none" stroke="rgba(147,197,253,0.9)" strokeWidth="1.5"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3, delay: 1.6 }} />

      {/* Dimension lines */}
      <motion.g initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5, delay: 3.5 }}>
        <line x1="150" y1="450" x2="650" y2="450" stroke="rgba(96,165,250,0.4)" strokeWidth="1" strokeDasharray="4 4" />
        <line x1="150" y1="445" x2="150" y2="455" stroke="rgba(96,165,250,0.4)" strokeWidth="1" />
        <line x1="650" y1="445" x2="650" y2="455" stroke="rgba(96,165,250,0.4)" strokeWidth="1" />
        <text x="395" y="465" textAnchor="middle" fill="rgba(96,165,250,0.6)" fontSize="11" fontFamily="monospace">42&apos;-0&quot;</text>
        <line x1="710" y1="120" x2="710" y2="420" stroke="rgba(96,165,250,0.4)" strokeWidth="1" strokeDasharray="4 4" />
        <line x1="705" y1="120" x2="715" y2="120" stroke="rgba(96,165,250,0.4)" strokeWidth="1" />
        <line x1="705" y1="420" x2="715" y2="420" stroke="rgba(96,165,250,0.4)" strokeWidth="1" />
        <text x="735" y="275" textAnchor="middle" fill="rgba(96,165,250,0.6)" fontSize="11" fontFamily="monospace" transform="rotate(90, 735, 275)">24&apos;-0&quot;</text>
      </motion.g>

      {/* Room labels */}
      <motion.g initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5, delay: 3.8 }}>
        <text x="210" y="293" fill="rgba(96,165,250,0.7)" fontSize="9" fontFamily="monospace">BEDROOM</text>
        <text x="500" y="293" fill="rgba(96,165,250,0.7)" fontSize="9" fontFamily="monospace">LIVING RM</text>
        <text x="348" y="390" fill="rgba(96,165,250,0.7)" fontSize="9" fontFamily="monospace">ENTRY</text>
      </motion.g>
    </svg>
  );
}

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
      transition={{ delay: 4.2 }}
    >
      <motion.div
        animate={{ y: [0, 5, 0] }}
        transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
        className="flex flex-col items-center gap-0.5"
      >
        <svg width="18" height="11" viewBox="0 0 18 11" fill="none">
          <path d="M1 1L9 9L17 1" stroke="rgba(147,197,253,0.7)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <svg width="24" height="14" viewBox="0 0 24 14" fill="none">
          <path d="M1 1L12 12L23 1" stroke="rgba(147,197,253,0.4)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </motion.div>
      <span className="text-xs text-blue-300/40 font-mono tracking-widest uppercase mt-1">scroll</span>
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
          ? "bg-blue-600/10 border-blue-500/40 hover:border-blue-400/60"
          : "bg-slate-900/60 border-slate-800 hover:border-slate-700"
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
      <h3 className={`text-lg font-bold mb-2 ${highlight ? "text-blue-300" : "text-white"}`}>{title}</h3>
      <p className="text-slate-400 text-sm leading-relaxed">{desc}</p>
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
      <div className="text-4xl font-black text-blue-400 mb-1">{value}</div>
      <div className="text-slate-400 text-sm">{label}</div>
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
      <div className="text-blue-400 text-xs font-bold tracking-widest uppercase mb-4">Platform Overview</div>
      <h2 className="text-4xl sm:text-5xl font-black text-white mb-5 leading-tight">
        AI-Powered Permit &<br />Blueprint Automation
      </h2>
      <p className="text-slate-400 text-lg max-w-2xl mx-auto">
        Everything a contractor needs — from raw blueprint to approved permit — automated in one platform.
      </p>
    </motion.div>
  );
}

// ─── Before / After sections ──────────────────────────────────────────────────

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
          <li key={i} className="flex items-start gap-3 text-slate-400">
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
      <div className="absolute -inset-4 bg-blue-600/5 rounded-3xl border border-blue-500/10" />
      <div className="relative p-2">
        <div className="text-blue-400 text-xs font-bold tracking-widest uppercase mb-4">With Axis</div>
        <h3 className="text-3xl font-black text-white mb-8">
          Automated in <span className="text-blue-400">seconds</span>
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
            <li key={i} className="flex items-start gap-3 text-slate-300">
              <span className="mt-1 w-5 h-5 rounded-full bg-blue-500/20 border border-blue-500/40 flex items-center justify-center flex-shrink-0">
                <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                  <path d="M1 4L3.5 6.5L9 1" stroke="rgba(96,165,250,0.9)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
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
        <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-blue-200">
          per project.
        </span>
      </h2>
      <p className="text-slate-400 text-lg mb-10">
        Join contractors automating their blueprint workflow with Axis Performance.
      </p>
      <Link
        href="/register"
        className="inline-block bg-blue-600 hover:bg-blue-500 text-white font-bold px-10 py-4 rounded-xl text-lg transition-all duration-200 hover:shadow-xl hover:shadow-blue-600/30"
      >
        Start for Free
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
    <div className="min-h-screen bg-[#050d1a] text-white font-sans overflow-x-hidden">

      {/* ── NAV ─────────────────────────────────────────────────────────────── */}
      <motion.nav
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-8 py-4 bg-[#050d1a]/80 backdrop-blur-md border-b border-blue-900/30"
      >
        <div className="flex items-center gap-2.5">
          <svg width="26" height="26" viewBox="0 0 28 28" fill="none">
            <rect x="2" y="2" width="24" height="24" rx="4" stroke="rgba(96,165,250,0.8)" strokeWidth="1.5" />
            <line x1="7" y1="8" x2="21" y2="8" stroke="rgba(96,165,250,0.8)" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="7" y1="12" x2="17" y2="12" stroke="rgba(96,165,250,0.5)" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="7" y1="16" x2="19" y2="16" stroke="rgba(96,165,250,0.5)" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="7" y1="20" x2="14" y2="20" stroke="rgba(96,165,250,0.3)" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <span className="text-base font-bold tracking-tight text-white">Axis Performance</span>
        </div>

        <Link
          href="/login"
          className="text-white text-sm font-medium px-5 py-2 rounded-lg border border-white/20 hover:border-white/50 hover:bg-white/5 transition-all duration-200"
        >
          Sign In
        </Link>
      </motion.nav>

      {/* ── HERO ────────────────────────────────────────────────────────────── */}
      <section className="relative min-h-screen flex flex-col items-center justify-center overflow-hidden pt-20">

        {/* Blueprint unroll: covers the screen, then slides off left→right */}
        <motion.div
          className="absolute inset-0 bg-[#050d1a] origin-left z-10"
          initial={{ scaleX: 1 }}
          animate={{ scaleX: 0 }}
          transition={{ duration: 1.2, ease: [0.76, 0, 0.24, 1] }}
        />

        {/* Radial blue glow */}
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_60%_at_50%_60%,rgba(37,99,235,0.12),transparent)] pointer-events-none" />

        {/* Blueprint animation — sits behind everything */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 1.2, delay: 1.0 }}
          className="absolute inset-0 flex items-center justify-center px-8"
        >
          <div className="w-full max-w-4xl opacity-55">
            <BlueprintHouse />
          </div>
        </motion.div>

        {/* Hero text — sits on top of blueprint */}
        <div className="relative z-20 flex flex-col items-center text-center px-6">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 1.4 }}
            className="inline-flex items-center gap-2 bg-blue-500/10 border border-blue-500/25 text-blue-300 text-xs font-semibold px-4 py-2 rounded-full mb-6 tracking-widest uppercase"
          >
            <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-pulse" />
            AI-Powered Blueprint Platform
          </motion.div>

          <motion.h1
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 1.6 }}
            className="text-6xl sm:text-7xl font-black tracking-tight mb-6 leading-none"
            style={{ textShadow: "0 0 60px rgba(96,165,250,0.25)" }}
          >
            Axis
            <br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-blue-200">
              Performance
            </span>
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 1.9 }}
            className="text-slate-400 text-lg max-w-md mb-10 leading-relaxed"
          >
            Upload a blueprint. Get instant room detection, material lists, cost
            estimates, compliance checks — and automatic permit filing.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 2.1 }}
            className="flex flex-col sm:flex-row gap-4"
          >
            <Link
              href="/register"
              className="bg-blue-600 hover:bg-blue-500 text-white font-bold px-8 py-3.5 rounded-xl text-base transition-all duration-200 hover:shadow-lg hover:shadow-blue-600/30"
            >
              Get Started Free
            </Link>
            <Link
              href="/login"
              className="bg-white/5 hover:bg-white/10 border border-white/15 text-white font-semibold px-8 py-3.5 rounded-xl text-base transition-all duration-200"
            >
              Sign In
            </Link>
          </motion.div>

          <ScrollIndicator />
        </div>
      </section>

      {/* ── FEATURES ────────────────────────────────────────────────────────── */}
      <section id="features" className="relative py-32 px-6">
        <div
          className="absolute inset-0 opacity-25 pointer-events-none"
          style={{
            backgroundImage: `
              linear-gradient(rgba(59,130,246,0.1) 1px, transparent 1px),
              linear-gradient(90deg, rgba(59,130,246,0.1) 1px, transparent 1px)
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
      <section className="py-24 px-6 border-y border-blue-900/30 bg-blue-950/20">
        <div className="max-w-4xl mx-auto grid grid-cols-2 sm:grid-cols-4 gap-12">
          <StatBlock value="< 2min" label="Full analysis time" delay={0} />
          <StatBlock value="90%" label="Reduction in admin work" delay={0.1} />
          <StatBlock value="100+" label="Building codes checked" delay={0.2} />
          <StatBlock value="$0" label="Extra software needed" delay={0.3} />
        </div>
      </section>

      {/* ── VALUE PROPOSITION ───────────────────────────────────────────────── */}
      <section className="py-32 px-6">
        <div className="max-w-6xl mx-auto grid md:grid-cols-2 gap-16 items-center">
          <BeforeColumn />
          <AfterColumn />
        </div>
      </section>

      {/* ── CTA ─────────────────────────────────────────────────────────────── */}
      <section className="py-32 px-6">
        <CTASection />
      </section>

      {/* ── FOOTER ──────────────────────────────────────────────────────────── */}
      <footer className="border-t border-blue-900/30 px-8 py-6 flex items-center justify-between text-slate-600 text-sm">
        <span className="font-semibold text-slate-500">Axis Performance</span>
        <span>© 2025 · Built for contractors</span>
      </footer>
    </div>
  );
}
