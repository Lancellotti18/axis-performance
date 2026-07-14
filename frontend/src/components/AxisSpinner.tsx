'use client'

/**
 * AxisSpinner — two half-circle arcs that swing toward each other, almost
 * touch, then swing back the other way. Used to signal "computing / not final
 * yet" states (e.g. roof measurements pending edge confirmation).
 */
export default function AxisSpinner({ size = 44, color = '#3b82f6' }: { size?: number; color?: string }) {
  const s = size
  return (
    <span style={{ display: 'inline-block', width: s, height: s, position: 'relative' }} aria-label="loading">
      <svg viewBox="0 0 50 50" width={s} height={s} style={{ display: 'block' }}>
        {/* faint full track */}
        <circle cx="25" cy="25" r="20" fill="none" stroke={color} strokeOpacity="0.12" strokeWidth="4" />
        {/* two 150° arcs, opposite each other, that oscillate toward + away */}
        <circle className="axsp-arc axsp-a" cx="25" cy="25" r="20" fill="none" stroke={color} strokeWidth="4"
          strokeLinecap="round" strokeDasharray="52.3 10.5" />
        <circle className="axsp-arc axsp-b" cx="25" cy="25" r="20" fill="none" stroke={color} strokeWidth="4"
          strokeLinecap="round" strokeDasharray="52.3 10.5" />
      </svg>
      <style>{`
        .axsp-arc { transform-origin: 25px 25px; }
        .axsp-a { animation: axsp-swingA 1.5s ease-in-out infinite; }
        .axsp-b { animation: axsp-swingB 1.5s ease-in-out infinite; }
        @keyframes axsp-swingA {
          0%   { transform: rotate(0deg); }
          50%  { transform: rotate(160deg); }
          100% { transform: rotate(0deg); }
        }
        @keyframes axsp-swingB {
          0%   { transform: rotate(180deg); }
          50%  { transform: rotate(340deg); }
          100% { transform: rotate(180deg); }
        }
      `}</style>
    </span>
  )
}
