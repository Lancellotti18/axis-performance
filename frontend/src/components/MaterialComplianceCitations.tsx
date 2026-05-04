'use client'

/**
 * Shared citation UI for the materials code-compliance results — used by both
 * the standalone `/material-check` page and the inline compliance block on a
 * project page. Shows contractors EXACTLY which document each material was
 * checked against (URL, title, jurisdiction, and a snippet) so nothing in the
 * checklist is mystery-AI output.
 */

export type CitationSource = {
  title: string
  url: string
  snippet: string
  category?: string
  jurisdiction?: string
}

export type CitationFallback = {
  title: string
  url: string
  note: string
}

export type CitedItem = {
  code_reference?: string
  code_reference_url?: string | null
  code_reference_title?: string
  code_reference_snippet?: string
  code_reference_jurisdiction?: string
  code_reference_fallback?: CitationFallback
  rule_quote?: string
  verified?: boolean
}

const ExternalIcon = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="inline-block ml-0.5 -translate-y-px">
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <polyline points="15 3 21 3 21 9" />
    <line x1="10" y1="14" x2="21" y2="3" />
  </svg>
)

/**
 * Inline citation rendered inside each checklist row. Shows the verified
 * source link + jurisdiction + a short snippet, OR the base-code fallback
 * note when no jurisdiction-specific source was retrieved.
 */
export function CitationInline({ item }: { item: CitedItem }) {
  const verifiedUrl = item.verified && item.code_reference_url ? item.code_reference_url : null
  const fallback = !verifiedUrl ? item.code_reference_fallback : null

  if (verifiedUrl) {
    return (
      <div className="mt-2 rounded-lg border border-blue-100 bg-blue-50/50 px-3 py-2">
        <div className="flex items-center justify-between gap-2 mb-1">
          <span className="text-[10px] font-bold text-blue-600 uppercase tracking-wider">Checked against</span>
          {item.code_reference_jurisdiction && (
            <span className="text-[10px] text-slate-500 font-medium">{item.code_reference_jurisdiction}</span>
          )}
        </div>
        <a
          href={verifiedUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-700 hover:text-blue-800 hover:underline text-xs font-semibold break-words leading-snug"
        >
          {item.code_reference_title || item.code_reference || verifiedUrl}
          <ExternalIcon />
        </a>
        {item.code_reference && item.code_reference_title && (
          <div className="text-slate-500 text-[10px] mt-0.5 font-medium">{item.code_reference}</div>
        )}
        {item.code_reference_snippet && (
          <p className="text-slate-600 text-xs mt-1.5 leading-relaxed">{item.code_reference_snippet}</p>
        )}
      </div>
    )
  }

  if (fallback) {
    return (
      <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Checked against (base code)</span>
        </div>
        <a
          href={fallback.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-slate-700 hover:text-blue-700 hover:underline text-xs font-semibold break-words leading-snug"
        >
          {fallback.title}
          <ExternalIcon />
        </a>
        <p className="text-slate-500 text-xs mt-1.5 leading-relaxed italic">{fallback.note}</p>
      </div>
    )
  }

  return null
}

/**
 * Professional disclaimer panel. Tells the contractor exactly what this
 * check is — and isn't — so they don't substitute it for an AHJ review,
 * a structural engineer, or a site inspection.
 */
export function ComplianceLimitations({ className = '' }: { className?: string }) {
  return (
    <aside
      className={`bg-white rounded-2xl px-5 py-4 ${className}`}
      style={{
        boxShadow: '0 2px 12px rgba(59,130,246,0.07)',
        border: '1px solid rgba(219,234,254,0.8)',
      }}
    >
      <div className="flex items-start gap-3 mb-3">
        <div className="flex-shrink-0 w-7 h-7 rounded-full bg-amber-50 border border-amber-100 flex items-center justify-center mt-0.5">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </div>
        <div className="flex-1">
          <div className="text-slate-800 font-bold text-sm">Scope of this compliance check</div>
          <p className="text-slate-500 text-xs mt-1 leading-relaxed">
            This tool cross-references your materials against publicly published
            building codes for the jurisdiction you selected. It is a
            <strong className="text-slate-700"> pre-submittal review aid</strong>,
            not an official approval.
          </p>
        </div>
      </div>

      <div className="border-t pt-3" style={{ borderColor: 'rgba(219,234,254,0.6)' }}>
        <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">
          What this check will <span className="text-amber-600">not</span> do
        </div>
        <ul className="space-y-2">
          {[
            {
              title: 'Replace your AHJ’s review',
              body: 'Building officials interpret code; this tool only suggests. The Authority Having Jurisdiction has final say on every compliance question for your project.',
            },
            {
              title: 'Catch design-level issues',
              body: 'Egress paths, structural load paths, occupancy load, and fire separation distances require a licensed architect or engineer. Material selection alone cannot prove a design is sound.',
            },
            {
              title: 'Verify on-site installation',
              body: 'Code compliance depends on how a material is installed, not just what is specified. A field inspection by a qualified inspector or third-party verifier is still required.',
            },
          ].map((row, i) => (
            <li key={i} className="flex items-start gap-2.5">
              <div className="flex-shrink-0 mt-1.5 w-1.5 h-1.5 rounded-full bg-slate-300" />
              <div className="flex-1">
                <div className="text-slate-700 text-xs font-semibold">{row.title}</div>
                <div className="text-slate-500 text-xs leading-relaxed mt-0.5">{row.body}</div>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="border-t mt-3 pt-3" style={{ borderColor: 'rgba(219,234,254,0.6)' }}>
        <p className="text-slate-400 text-[11px] leading-relaxed">
          Always confirm flagged items with your local building department before
          construction. The "Sources used" panel above shows every document this
          check pulled from — click through to verify any citation yourself.
        </p>
      </div>
    </aside>
  )
}

/**
 * Full bibliography of every research result Tavily fetched for this
 * compliance check. Rendered at the bottom of the results panel so the
 * contractor can see exactly which documents were searched.
 */
export function CitationBibliography({
  sources,
  baseCode,
  className = '',
}: {
  sources?: CitationSource[]
  baseCode?: CitationFallback
  className?: string
}) {
  const list = sources || []
  if (list.length === 0 && !baseCode) return null

  // Group by category so the panel reads like a real reference list.
  const grouped: Record<string, CitationSource[]> = {}
  for (const s of list) {
    const cat = s.category || 'general'
    if (!grouped[cat]) grouped[cat] = []
    grouped[cat].push(s)
  }
  const categories = Object.keys(grouped).sort()

  return (
    <details
      className={`group bg-white rounded-2xl overflow-hidden ${className}`}
      style={{
        boxShadow: '0 2px 12px rgba(59,130,246,0.07)',
        border: '1px solid rgba(219,234,254,0.8)',
      }}
    >
      <summary className="cursor-pointer select-none list-none px-5 py-4 flex items-center justify-between hover:bg-blue-50/40 transition-colors">
        <div className="flex items-center gap-2">
          <svg
            className="group-open:rotate-90 transition-transform text-slate-400"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
          <span className="text-slate-800 font-bold text-sm">Sources used in this check</span>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-50 border border-blue-100 text-blue-600 font-semibold">
            {list.length}
          </span>
        </div>
        <span className="text-slate-400 text-xs">expand</span>
      </summary>

      <div className="px-5 pb-5 pt-1 space-y-4">
        <p className="text-slate-500 text-xs leading-relaxed">
          Every checklist item above was cross-referenced against these documents — pulled
          live from official .gov, municipal code, and ICC sources. Nothing is fabricated.
        </p>

        {categories.map((cat) => (
          <div key={cat}>
            <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2 capitalize">
              {cat}
            </div>
            <div className="space-y-2">
              {grouped[cat].map((s, i) => (
                <div
                  key={`${cat}-${i}`}
                  className="rounded-lg border border-slate-100 bg-slate-50/50 px-3 py-2"
                >
                  <div className="flex items-start justify-between gap-3 mb-1">
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-700 hover:text-blue-800 hover:underline text-xs font-semibold break-words leading-snug flex-1"
                    >
                      {s.title}
                      <ExternalIcon />
                    </a>
                    {s.jurisdiction && (
                      <span className="text-[10px] text-slate-500 font-medium flex-shrink-0 mt-0.5">
                        {s.jurisdiction}
                      </span>
                    )}
                  </div>
                  {s.snippet && (
                    <p className="text-slate-600 text-xs leading-relaxed">{s.snippet}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}

        {baseCode && (
          <div className="border-t pt-3" style={{ borderColor: 'rgba(219,234,254,0.6)' }}>
            <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">
              Base code reference
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
              <a
                href={baseCode.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-slate-700 hover:text-blue-700 hover:underline text-xs font-semibold break-words leading-snug"
              >
                {baseCode.title}
                <ExternalIcon />
              </a>
              <p className="text-slate-500 text-xs mt-1 leading-relaxed italic">{baseCode.note}</p>
            </div>
          </div>
        )}
      </div>
    </details>
  )
}
