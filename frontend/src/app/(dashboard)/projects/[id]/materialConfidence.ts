/**
 * Client-side confidence scoring for material estimates.
 *
 * The backend estimator falls back to $10.00 with a warning when it has no
 * base price on file, and live vendor lookups sometimes come back empty.
 * Rather than trust the full list blindly, we classify each row so the UI
 * can flag "needs review" items before the contractor sends an estimate
 * to a client. This mirrors Procore / Togal's confidence surfacing.
 *
 * Reviewed IDs are persisted in localStorage per project so an explicit
 * user confirmation sticks across reloads without needing a backend write.
 */

export type ConfidenceLevel = 'high' | 'medium' | 'low'

export interface ConfidenceResult {
  level: ConfidenceLevel
  reasons: string[]
}

const FALLBACK_PRICE = 10.0

interface VendorLike {
  price?: number | null
  url?: string
}

interface MaterialLike {
  unit_cost?: number | null
  quantity?: number | null
  vendor_options?: unknown
  price_unverified?: boolean     // may come from backend someday
}

function parseVendors(raw: unknown): VendorLike[] {
  if (Array.isArray(raw)) return raw as VendorLike[]
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? (parsed as VendorLike[]) : []
    } catch {
      return []
    }
  }
  return []
}

export function computeMaterialConfidence(m: MaterialLike): ConfidenceResult {
  const reasons: string[] = []
  const unit_cost = typeof m.unit_cost === 'number' ? m.unit_cost : 0
  const vendors = parseVendors(m.vendor_options)
  const anyVendorPrice = vendors.some(v => typeof v.price === 'number' && (v.price as number) > 0)

  if (m.price_unverified) reasons.push('Backend flagged: no base price on file')
  if (unit_cost === 0) reasons.push('Unit cost is $0')
  if (unit_cost === FALLBACK_PRICE && !anyVendorPrice) {
    reasons.push('Unit cost matches $10 placeholder with no live price')
  }
  if (vendors.length === 0) reasons.push('No vendor sources attached')
  else if (!anyVendorPrice) reasons.push('Vendors attached but none returned a price')

  // Quantity sanity — if it's a clean big round number AND there's no live
  // signal, surface as a weak warning.
  const qty = typeof m.quantity === 'number' ? m.quantity : 0
  if (qty > 0 && qty % 500 === 0 && !anyVendorPrice) {
    reasons.push('Quantity is a round number (may be a default)')
  }

  let level: ConfidenceLevel
  if (reasons.length === 0) level = 'high'
  else if (anyVendorPrice && unit_cost > 0 && unit_cost !== FALLBACK_PRICE) level = 'medium'
  else if (unit_cost === 0 || unit_cost === FALLBACK_PRICE) level = 'low'
  else level = 'medium'

  return { level, reasons }
}

const STORAGE_PREFIX = 'buildai.reviewedMaterials.'

export function loadReviewedIds(projectId: string): Set<string> {
  if (typeof window === 'undefined') return new Set()
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + projectId)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? new Set<string>(parsed) : new Set()
  } catch {
    return new Set()
  }
}

export function saveReviewedIds(projectId: string, ids: Set<string>) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_PREFIX + projectId, JSON.stringify([...ids]))
  } catch {
    /* ignore quota errors */
  }
}
