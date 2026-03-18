"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { motion, useAnimation, useInView } from "framer-motion";

// ─── Real Blueprint Background ────────────────────────────────────────────────

function BlueprintBackground() {
  return (
    <svg
      className="absolute inset-0 w-full h-full"
      xmlns="http://www.w3.org/2000/svg"
      preserveAspectRatio="xMidYMid slice"
    >
      <defs>
        {/* Fine grid — 20px */}
        <pattern id="fine" width="20" height="20" patternUnits="userSpaceOnUse">
          <path d="M 20 0 L 0 0 0 20" fill="none" stroke="rgba(255,255,255,0.10)" strokeWidth="0.4" />
        </pattern>
        {/* Major grid — 100px */}
        <pattern id="major" width="100" height="100" patternUnits="userSpaceOnUse">
          <rect width="100" height="100" fill="url(#fine)" />
          <path d="M 100 0 L 0 0 0 100" fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="0.8" />
        </pattern>
        <filter id="glow">
          <feGaussianBlur stdDeviation="1.5" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>

      {/* Blueprint blue fill */}
      <rect width="100%" height="100%" fill="#1a56a0" />
      {/* Grid overlay */}
      <rect width="100%" height="100%" fill="url(#major)" />

      {/* ── FLOOR PLAN — left side ─────────────────────────────────────── */}
      {/* Outer walls */}
      <motion.rect x="60" y="120" width="320" height="260" rx="0"
        fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth="3"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4, delay: 0.4 }} />

      {/* Interior wall — vertical split */}
      <motion.line x1="220" y1="120" x2="220" y2="310"
        stroke="rgba(255,255,255,0.7)" strokeWidth="2"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3, delay: 0.7 }} />

      {/* Interior wall — horizontal */}
      <motion.line x1="60" y1="260" x2="220" y2="260"
        stroke="rgba(255,255,255,0.7)" strokeWidth="2"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3, delay: 0.8 }} />

      {/* Interior wall — right block */}
      <motion.line x1="220" y1="230" x2="380" y2="230"
        stroke="rgba(255,255,255,0.7)" strokeWidth="2"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3, delay: 0.9 }} />

      {/* Door arcs */}
      <motion.path d="M 220 310 Q 245 310 245 285" fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth="1"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3, delay: 1.1 }} />
      <motion.line x1="220" y1="310" x2="220" y2="285"
        stroke="rgba(255,255,255,0.4)" strokeWidth="0.8"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2, delay: 1.1 }} />

      <motion.path d="M 60 260 Q 60 235 85 235" fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth="1"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3, delay: 1.2 }} />
      <motion.line x1="60" y1="235" x2="85" y2="235"
        stroke="rgba(255,255,255,0.4)" strokeWidth="0.8"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2, delay: 1.2 }} />

      {/* Windows — tick marks */}
      {([
        [120, 120, 160, 120],
        [280, 120, 320, 120],
        [60, 160, 60, 200],
        [380, 145, 380, 185],
        [380, 285, 380, 325],
      ] as [number,number,number,number][]).map(([x1,y1,x2,y2], i) => (
        <motion.g key={i} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3, delay: 1.3 + i * 0.05 }}>
          <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="white" strokeWidth="4" />
          <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#1a56a0" strokeWidth="2" />
        </motion.g>
      ))}

      {/* Room labels */}
      <motion.g initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5, delay: 1.6 }}>
        <text x="128" y="195" fill="rgba(255,255,255,0.7)" fontSize="9" fontFamily="monospace" textAnchor="middle">BEDROOM</text>
        <text x="128" y="207" fill="rgba(255,255,255,0.5)" fontSize="7" fontFamily="monospace" textAnchor="middle">12&apos;-0&quot; × 14&apos;-0&quot;</text>
        <text x="305" y="175" fill="rgba(255,255,255,0.7)" fontSize="9" fontFamily="monospace" textAnchor="middle">LIVING ROOM</text>
        <text x="305" y="187" fill="rgba(255,255,255,0.5)" fontSize="7" fontFamily="monospace" textAnchor="middle">16&apos;-0&quot; × 18&apos;-0&quot;</text>
        <text x="128" y="240" fill="rgba(255,255,255,0.7)" fontSize="9" fontFamily="monospace" textAnchor="middle">BATHROOM</text>
        <text x="305" y="325" fill="rgba(255,255,255,0.7)" fontSize="9" fontFamily="monospace" textAnchor="middle">KITCHEN</text>
        <text x="305" y="337" fill="rgba(255,255,255,0.5)" fontSize="7" fontFamily="monospace" textAnchor="middle">14&apos;-0&quot; × 12&apos;-0&quot;</text>
      </motion.g>

      {/* Floor plan label */}
      <motion.g initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4, delay: 1.8 }}>
        <text x="220" y="406" fill="rgba(255,255,255,0.6)" fontSize="10" fontFamily="monospace" textAnchor="middle" letterSpacing="2">FLOOR PLAN</text>
        <line x1="100" y1="398" x2="150" y2="398" stroke="rgba(255,255,255,0.3)" strokeWidth="0.8" />
        <line x1="290" y1="398" x2="340" y2="398" stroke="rgba(255,255,255,0.3)" strokeWidth="0.8" />
      </motion.g>

      {/* ── DIMENSION LINES ───────────────────────────────────────────── */}
      <motion.g initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5, delay: 1.9 }}>
        {/* Width */}
        <line x1="60" y1="430" x2="380" y2="430" stroke="rgba(255,255,255,0.4)" strokeWidth="0.8" />
        <line x1="60" y1="424" x2="60" y2="436" stroke="rgba(255,255,255,0.4)" strokeWidth="0.8" />
        <line x1="380" y1="424" x2="380" y2="436" stroke="rgba(255,255,255,0.4)" strokeWidth="0.8" />
        <text x="220" y="445" fill="rgba(255,255,255,0.5)" fontSize="8" fontFamily="monospace" textAnchor="middle">32&apos;-0&quot;</text>
        {/* Height */}
        <line x1="28" y1="120" x2="28" y2="380" stroke="rgba(255,255,255,0.4)" strokeWidth="0.8" />
        <line x1="22" y1="120" x2="34" y2="120" stroke="rgba(255,255,255,0.4)" strokeWidth="0.8" />
        <line x1="22" y1="380" x2="34" y2="380" stroke="rgba(255,255,255,0.4)" strokeWidth="0.8" />
        <text x="16" y="255" fill="rgba(255,255,255,0.5)" fontSize="8" fontFamily="monospace" textAnchor="middle" transform="rotate(-90, 16, 255)">26&apos;-0&quot;</text>
      </motion.g>

      {/* ── ELEVATION VIEW — right side ───────────────────────────────── */}
      {/* Ground line */}
      <motion.line x1="460" y1="360" x2="780" y2="360"
        stroke="rgba(255,255,255,0.6)" strokeWidth="1.5"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5, delay: 0.5 }} />

      {/* Foundation block */}
      <motion.rect x="500" y="350" width="240" height="12" rx="0"
        fill="none" stroke="rgba(255,255,255,0.7)" strokeWidth="1.5"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3, delay: 0.6 }} />
      {/* Hatch foundation */}
      {[0,1,2,3,4,5].map(i => (
        <motion.line key={i} x1={500 + i*40} y1="362" x2={500 + i*40 - 10} y2="350"
          stroke="rgba(255,255,255,0.3)" strokeWidth="0.8"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2, delay: 0.65 }} />
      ))}

      {/* Walls */}
      <motion.line x1="500" y1="350" x2="500" y2="210"
        stroke="rgba(255,255,255,0.8)" strokeWidth="2"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4, delay: 0.8 }} />
      <motion.line x1="740" y1="350" x2="740" y2="210"
        stroke="rgba(255,255,255,0.8)" strokeWidth="2"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4, delay: 0.9 }} />

      {/* Roof */}
      <motion.line x1="480" y1="210" x2="620" y2="130"
        stroke="rgba(255,255,255,0.9)" strokeWidth="2.5"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5, delay: 1.2 }} />
      <motion.line x1="760" y1="210" x2="620" y2="130"
        stroke="rgba(255,255,255,0.9)" strokeWidth="2.5"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5, delay: 1.2 }} />
      <motion.line x1="480" y1="210" x2="760" y2="210"
        stroke="rgba(255,255,255,0.7)" strokeWidth="1.5"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4, delay: 1.3 }} />

      {/* Chimney */}
      <motion.rect x="680" y="140" width="24" height="45" rx="0"
        fill="none" stroke="rgba(255,255,255,0.7)" strokeWidth="1.5"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3, delay: 1.4 }} />

      {/* Front door (elevation) */}
      <motion.rect x="590" y="290" width="46" height="62"
        fill="none" stroke="rgba(255,255,255,0.75)" strokeWidth="1.5"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3, delay: 1.5 }} />
      <motion.circle cx="628" cy="321" r="3" fill="rgba(255,255,255,0.7)"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2, delay: 1.6 }} />

      {/* Windows (elevation) */}
      {([[520,265,60,45],[660,265,60,45]] as [number,number,number,number][]).map(([x,y,w,h], i) => (
        <motion.g key={i} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3, delay: 1.5 + i * 0.05 }}>
          <rect x={x} y={y} width={w} height={h} fill="none" stroke="rgba(255,255,255,0.75)" strokeWidth="1.5" />
          <line x1={x + w/2} y1={y} x2={x + w/2} y2={y + h} stroke="rgba(255,255,255,0.4)" strokeWidth="0.8" />
          <line x1={x} y1={y + h/2} x2={x + w} y2={y + h/2} stroke="rgba(255,255,255,0.4)" strokeWidth="0.8" />
        </motion.g>
      ))}

      {/* Elevation dimension lines */}
      <motion.g initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4, delay: 2.0 }}>
        <line x1="780" y1="210" x2="800" y2="210" stroke="rgba(255,255,255,0.3)" strokeWidth="0.8" />
        <line x1="780" y1="360" x2="800" y2="360" stroke="rgba(255,255,255,0.3)" strokeWidth="0.8" />
        <line x1="796" y1="210" x2="796" y2="360" stroke="rgba(255,255,255,0.35)" strokeWidth="0.8" />
        <text x="810" y="293" fill="rgba(255,255,255,0.45)" fontSize="8" fontFamily="monospace">12&apos;-0&quot;</text>

        <line x1="620" y1="100" x2="620" y2="125" stroke="rgba(255,255,255,0.4)" strokeWidth="0.8" />
        <circle cx="620" cy="128" r="3" fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="0.8" />
        <text x="628" y="120" fill="rgba(255,255,255,0.45)" fontSize="8" fontFamily="monospace">RIDGE</text>
      </motion.g>

      {/* Elevation label */}
      <motion.g initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4, delay: 2.1 }}>
        <text x="620" y="406" fill="rgba(255,255,255,0.6)" fontSize="10" fontFamily="monospace" textAnchor="middle" letterSpacing="2">FRONT ELEVATION</text>
        <line x1="490" y1="398" x2="540" y2="398" stroke="rgba(255,255,255,0.3)" strokeWidth="0.8" />
        <line x1="700" y1="398" x2="750" y2="398" stroke="rgba(255,255,255,0.3)" strokeWidth="0.8" />
      </motion.g>

      {/* ── TITLE BLOCK — bottom right ──────────────────────────────────── */}
      <motion.g initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5, delay: 2.3 }}>
        <rect x="590" y="440" width="220" height="55" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth="0.8" />
        <line x1="590" y1="455" x2="810" y2="455" stroke="rgba(255,255,255,0.2)" strokeWidth="0.5" />
        <line x1="590" y1="467" x2="810" y2="467" stroke="rgba(255,255,255,0.2)" strokeWidth="0.5" />
        <line x1="700" y1="440" x2="700" y2="495" stroke="rgba(255,255,255,0.2)" strokeWidth="0.5" />
        <text x="700" y="451" fill="rgba(255,255,255,0.6)" fontSize="8" fontFamily="monospace" textAnchor="middle" letterSpacing="1">AXIS PERFORMANCE</text>
        <text x="648" y="463" fill="rgba(255,255,255,0.4)" fontSize="7" fontFamily="monospace" textAnchor="middle">SCALE: 1/4&quot; = 1&apos;-0&quot;</text>
        <text x="755" y="463" fill="rgba(255,255,255,0.4)" fontSize="7" fontFamily="monospace" textAnchor="middle">SHEET A-1</text>
        <text x="648" y="480" fill="rgba(255,255,255,0.4)" fontSize="7" fontFamily="monospace" textAnchor="middle">DATE: 03.18.2026</text>
        <text x="755" y="480" fill="rgba(255,255,255,0.4)" fontSize="7" fontFamily="monospace" textAnchor="middle">REV: 00</text>
        <text x="700" y="491" fill="rgba(255,255,255,0.3)" fontSize="6" fontFamily="monospace" textAnchor="middle">RESIDENTIAL FLOOR PLAN + ELEVATION</text>
      </motion.g>

      {/* ── NORTH ARROW ──────────────────────────────────────────────────── */}
      <motion.g initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4, delay: 2.2 }}>
        <circle cx="430" cy="460" r="18" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="0.8" />
        <line x1="430" y1="448" x2="430" y2="472" stroke="rgba(255,255,255,0.6)" strokeWidth="1" />
        <polygon points="430,442 425,454 430,450 435,454" fill="rgba(255,255,255,0.8)" />
        <text x="430" y="440" fill="rgba(255,255,255,0.7)" fontSize="9" fontFamily="monospace" textAnchor="middle" fontWeight="bold">N</text>
      </motion.g>

      {/* ── DETAIL CALLOUTS ───────────────────────────────────────────────── */}
      <motion.g initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4, delay: 2.0 }}>
        <circle cx="380" cy="120" r="12" fill="none" stroke="rgba(255,255,255,0.45)" strokeWidth="0.8" />
        <line x1="380" y1="108" x2="380" y2="132" stroke="rgba(255,255,255,0.3)" strokeWidth="0.5" />
        <text x="380" y="123" fill="rgba(255,255,255,0.6)" fontSize="8" fontFamily="monospace" textAnchor="middle" fontWeight="bold">A</text>
        <text x="380" y="133" fill="rgba(255,255,255,0.35)" fontSize="6" fontFamily="monospace" textAnchor="middle">3/A2</text>
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
      transition={{ delay: 2.6 }}
    >
      <motion.div
        animate={{ y: [0, 5, 0] }}
        transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
        className="flex flex-col items-center gap-0.5"
      >
        <svg width="18" height="11" viewBox="0 0 18 11" fill="none">
          <path d="M1 1L9 9L17 1" stroke="rgba(255,255,255,0.6)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <svg width="24" height="14" viewBox="0 0 24 14" fill="none">
          <path d="M1 1L12 12L23 1" stroke="rgba(255,255,255,0.3)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
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
        transition={{ duration: 0.5 }}
        className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-8 py-4 bg-[#1a56a0]/80 backdrop-blur-md border-b border-white/10"
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

        <Link
          href="/login"
          className="text-white text-sm font-medium px-5 py-2 rounded-lg border border-white/30 hover:border-white/70 hover:bg-white/10 transition-all duration-200"
        >
          Sign In
        </Link>
      </motion.nav>

      {/* ── HERO ────────────────────────────────────────────────────────────── */}
      <section className="relative min-h-screen flex flex-col items-center justify-center overflow-hidden pt-20">

        {/* Blueprint unroll reveal */}
        <motion.div
          className="absolute inset-0 bg-[#1a56a0] origin-left z-10"
          initial={{ scaleX: 1 }}
          animate={{ scaleX: 0 }}
          transition={{ duration: 1.0, ease: [0.76, 0, 0.24, 1] }}
        />

        {/* Full-screen blueprint background */}
        <div className="absolute inset-0">
          <BlueprintBackground />
        </div>

        {/* Darkening vignette so text is readable */}
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_60%_70%_at_50%_50%,rgba(10,40,90,0.55),transparent)] pointer-events-none" />

        {/* Hero text */}
        <div className="relative z-20 flex flex-col items-center text-center px-6">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 1.2 }}
            className="inline-flex items-center gap-2 bg-white/10 border border-white/25 text-white text-xs font-semibold px-4 py-2 rounded-full mb-6 tracking-widest uppercase"
          >
            <span className="w-1.5 h-1.5 bg-white rounded-full animate-pulse" />
            AI-Powered Blueprint Platform
          </motion.div>

          <motion.h1
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 1.4 }}
            className="text-6xl sm:text-7xl font-black tracking-tight mb-6 leading-none"
            style={{ textShadow: "0 2px 30px rgba(0,0,0,0.4)" }}
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
            className="text-white/75 text-lg max-w-md mb-10 leading-relaxed"
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
              className="bg-white text-blue-700 font-bold px-8 py-3.5 rounded-xl text-base transition-all duration-200 hover:bg-blue-50 hover:shadow-lg hover:shadow-black/30"
            >
              Get Started Free
            </Link>
            <Link
              href="/login"
              className="bg-white/10 hover:bg-white/20 border border-white/30 text-white font-semibold px-8 py-3.5 rounded-xl text-base transition-all duration-200"
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
