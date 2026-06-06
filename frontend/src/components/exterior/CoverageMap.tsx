'use client'

/**
 * Axis Performance — Photo coverage map.
 *
 * Simple top-down house diagram showing the four cardinal elevations + their
 * corner combinations. Each face is colored by status (good / minimal / missing)
 * based on the per-elevation photo counts returned by the backend
 * coverage_map() helper.
 *
 * Corner photos contribute half-credit to their two adjacent faces so the
 * contractor can satisfy coverage with fewer shots when they walk the corners.
 */

interface CoverageEntry {
  count: number
  effective_count?: number
  status: string         // 'good' | 'minimal' | 'missing'
}

interface Props {
  coverage: Record<string, CoverageEntry>
}

const STATUS_COLORS: Record<string, string> = {
  good: '#22c55e',
  minimal: '#f59e0b',
  missing: '#ef4444',
}

function fill(status: string | undefined): string {
  return STATUS_COLORS[status || 'missing'] || STATUS_COLORS.missing
}

export function CoverageMap({ coverage }: Props) {
  const c = coverage || {}
  const front = c.front || { count: 0, status: 'missing' }
  const right = c.right || { count: 0, status: 'missing' }
  const rear  = c.rear  || { count: 0, status: 'missing' }
  const left  = c.left  || { count: 0, status: 'missing' }

  const totalGood = ['front', 'right', 'rear', 'left'].filter(k => c[k]?.status === 'good').length

  return (
    <div className="rounded-lg border border-white/10 bg-slate-900/60 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">Photo coverage</h3>
          <p className="text-xs text-slate-400">{totalGood} of 4 elevations covered</p>
        </div>
        <Legend />
      </div>

      <svg viewBox="0 0 320 320" className="mx-auto block w-full max-w-[280px]">
        {/* House (top-down rectangle) */}
        <rect x={70} y={70} width={180} height={180} fill="#0f172a" stroke="#334155" strokeWidth={2} />

        {/* North (Front) — top face */}
        <FaceBar x1={70} y1={62} x2={250} y2={62} side="top"
                 status={front.status} label={`Front (${front.count})`} />
        {/* East (Right) — right face */}
        <FaceBar x1={258} y1={70} x2={258} y2={250} side="right"
                 status={right.status} label={`Right (${right.count})`} />
        {/* South (Rear) — bottom face */}
        <FaceBar x1={70} y1={258} x2={250} y2={258} side="bottom"
                 status={rear.status} label={`Rear (${rear.count})`} />
        {/* West (Left) — left face */}
        <FaceBar x1={62} y1={70} x2={62} y2={250} side="left"
                 status={left.status} label={`Left (${left.count})`} />

        {/* Compass */}
        <g transform="translate(290, 30)">
          <circle r={16} fill="#0f172a" stroke="#475569" strokeWidth={1.5} />
          <text x={0} y={-3} textAnchor="middle" fill="#cbd5e1" fontSize={9} fontWeight={700}>N</text>
          <line x1={0} y1={3} x2={0} y2={11} stroke="#cbd5e1" strokeWidth={1.5} />
        </g>
      </svg>

      <ul className="mt-3 grid grid-cols-2 gap-2 text-xs">
        {['front', 'right', 'rear', 'left'].map(face => {
          const entry = c[face] || { count: 0, status: 'missing', effective_count: 0 }
          return (
            <li key={face} className="flex items-center justify-between rounded bg-slate-800/50 px-2 py-1">
              <span className="capitalize text-slate-300">{face}</span>
              <span className="flex items-center gap-2">
                <span className="text-slate-400">{entry.count}</span>
                {entry.effective_count != null && entry.effective_count !== entry.count && (
                  <span className="text-slate-500">({entry.effective_count} eff.)</span>
                )}
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: fill(entry.status) }} />
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function FaceBar({ x1, y1, x2, y2, side, status, label }: {
  x1: number; y1: number; x2: number; y2: number;
  side: 'top' | 'right' | 'bottom' | 'left';
  status: string; label: string;
}) {
  const color = fill(status)
  const isHoriz = side === 'top' || side === 'bottom'
  const labelX = (x1 + x2) / 2
  const labelY = (y1 + y2) / 2
  return (
    <g>
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={10} strokeLinecap="round" />
      <text
        x={labelX} y={labelY}
        textAnchor="middle"
        dominantBaseline="middle"
        fill="#e2e8f0" fontSize={11}
        transform={isHoriz ? undefined : `rotate(${side === 'left' ? -90 : 90}, ${labelX}, ${labelY})`}
        dy={side === 'top' ? -10 : side === 'bottom' ? 16 : 0}
        dx={side === 'left' ? -10 : side === 'right' ? 10 : 0}
      >{label}</text>
    </g>
  )
}

function Legend() {
  return (
    <div className="flex gap-2 text-[10px] text-slate-400">
      {(['good', 'minimal', 'missing'] as const).map(s => (
        <span key={s} className="flex items-center gap-1">
          <span className="inline-block h-2 w-3 rounded" style={{ background: STATUS_COLORS[s] }} />
          {s}
        </span>
      ))}
    </div>
  )
}

export default CoverageMap
