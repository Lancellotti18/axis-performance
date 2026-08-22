'use client'

/**
 * RoofScanSpinner — a unique, on-brand loading indicator for roof work.
 * A gable-roof outline draws itself while a scan line sweeps top-to-bottom and
 * the corner nodes pulse — reads as "Axis is measuring/analyzing the roof",
 * not a generic spinner. Pure SVG + CSS, no dependencies.
 */
export default function RoofScanSpinner({
  size = 30,
  label,
  className = '',
}: {
  size?: number
  label?: string
  className?: string
}) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <svg width={size} height={size} viewBox="0 0 48 48" fill="none" role="status" aria-label={label || 'Loading'}>
        <defs>
          <clipPath id="rs-clip">
            <path d="M6 23 L24 7 L42 23 L42 41 L6 41 Z" />
          </clipPath>
        </defs>
        {/* faint static house */}
        <path d="M6 23 L24 7 L42 23 L42 41 L6 41 Z" stroke="rgba(148,163,184,0.20)" strokeWidth="2" strokeLinejoin="round" />
        {/* self-drawing outline */}
        <path className="rs-outline" d="M6 23 L24 7 L42 23 L42 41 L6 41 Z"
          stroke="#3b82f6" strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" />
        {/* ridge line */}
        <path className="rs-ridge" d="M24 7 L24 41" stroke="#60a5fa" strokeWidth="1.4" opacity="0.5" />
        {/* scan sweep, clipped to the roof shape */}
        <g clipPath="url(#rs-clip)">
          <rect className="rs-sweep" x="4" y="0" width="40" height="4" fill="#93c5fd" />
        </g>
        {/* pulsing corner nodes */}
        <circle className="rs-node" cx="24" cy="7" r="2.4" fill="#60a5fa" />
        <circle className="rs-node rs-node-2" cx="6" cy="23" r="2" fill="#60a5fa" />
        <circle className="rs-node rs-node-3" cx="42" cy="23" r="2" fill="#60a5fa" />
      </svg>
      {label && <span className="text-xs font-medium text-[#2d2d2d]">{label}</span>}

      <style jsx>{`
        .rs-outline {
          stroke-dasharray: 132;
          stroke-dashoffset: 132;
          animation: rs-draw 2.4s ease-in-out infinite;
        }
        .rs-ridge {
          stroke-dasharray: 34;
          stroke-dashoffset: 34;
          animation: rs-draw 2.4s ease-in-out infinite;
          animation-delay: 0.5s;
        }
        .rs-sweep {
          animation: rs-scan 2.4s ease-in-out infinite;
        }
        .rs-node { animation: rs-pulse 1.6s ease-in-out infinite; }
        .rs-node-2 { animation-delay: 0.25s; }
        .rs-node-3 { animation-delay: 0.5s; }
        @keyframes rs-draw {
          0% { stroke-dashoffset: 132; }
          55% { stroke-dashoffset: 0; }
          100% { stroke-dashoffset: 0; }
        }
        @keyframes rs-scan {
          0%, 15% { transform: translateY(6px); opacity: 0; }
          25% { opacity: 0.9; }
          80% { transform: translateY(40px); opacity: 0.9; }
          100% { transform: translateY(42px); opacity: 0; }
        }
        @keyframes rs-pulse {
          0%, 100% { opacity: 0.35; transform: scale(0.8); transform-box: fill-box; transform-origin: center; }
          50% { opacity: 1; transform: scale(1.15); transform-box: fill-box; transform-origin: center; }
        }
        @media (prefers-reduced-motion: reduce) {
          .rs-outline, .rs-ridge, .rs-sweep, .rs-node { animation: none; }
          .rs-outline, .rs-ridge { stroke-dashoffset: 0; }
        }
      `}</style>
    </span>
  )
}
