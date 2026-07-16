'use client'

/**
 * AxisSpinner — two half-circle arcs that swing toward each other, almost
 * touch, then swing back the other way. Used to signal "computing / not final
 * yet" states (e.g. roof measurements pending edge confirmation).
 */
export default function AxisSpinner({ size = 44, color = '#3b82f6' }: { size?: number; color?: string }) {
  const s = size
  // Two 150° arcs that start opposite (forming a ring), swing TOWARD each other,
  // overlap ("knock"), then swing back apart — repeating. ease-in-out gives the
  // little deceleration at the meeting point that reads as a knock.
  return (
    <span style={{ display: 'inline-block', width: s, height: s, position: 'relative' }} aria-label="loading">
      <svg viewBox="0 0 50 50" width={s} height={s} style={{ display: 'block' }}>
        <circle cx="25" cy="25" r="20" fill="none" stroke={color} strokeOpacity="0.12" strokeWidth="4" />
        {/* single 150° arc each (dash 52.3 of a 125.66 circumference, rest gap) */}
        <circle className="axsp-arc axsp-a" cx="25" cy="25" r="20" fill="none" stroke={color} strokeWidth="4"
          strokeLinecap="round" strokeDasharray="52.3 73.4" />
        <circle className="axsp-arc axsp-b" cx="25" cy="25" r="20" fill="none" stroke={color} strokeWidth="4"
          strokeLinecap="round" strokeDasharray="52.3 73.4" />
      </svg>
      <style>{`
        .axsp-arc { transform-origin: 25px 25px; }
        .axsp-a { animation: axsp-a 1.25s ease-in-out infinite alternate; }
        .axsp-b { animation: axsp-b 1.25s ease-in-out infinite alternate; }
        /* Start opposite (a full ring), each swings ~110° toward the other,
           overlap ~40° ("bump"), then ease back apart. */
        @keyframes axsp-a { from { transform: rotate(0deg); }   to { transform: rotate(110deg); } }
        @keyframes axsp-b { from { transform: rotate(180deg); } to { transform: rotate(70deg); } }
      `}</style>
    </span>
  )
}
