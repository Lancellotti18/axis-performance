/**
 * Axis Roofing Performance — distinct roof lines from per-facet edge records.
 *
 * Edges are stored once per facet, so the line where two planes meet exists
 * TWICE: once as facet A's edge, once as facet B's. Anything that counts raw
 * edge records therefore counts shared lines double — which is why the panel
 * could insist "5 edges still need confirming" while the editor showed nothing
 * left to confirm, and why linear footage came out inflated.
 *
 * This is the frontend mirror of `edge_totals_by_type` in
 * `backend/app/services/geometry_service.py`. Same tolerance, same
 * representative-picking rules, so the count the contractor reads and the
 * totals the order is built from can never disagree. Change one, change both.
 */
import type { EdgeType, Facet, LabeledEdge } from './RoofFacetEditor'

/** Interior lines only exist where two planes meet — never an eave or a rake. */
const INTERIOR_EDGE_TYPES = new Set(['valley', 'hip', 'ridge'])

/**
 * Coincidence tolerance in image-fraction units (polygons are stored 0..1).
 * ~0.006 is about 12px on a 2048px tile: more than hand-tracing jitter, less
 * than the gap between two genuinely different roof lines.
 */
const COINCIDENCE_TOL = 0.006

type Segment = [[number, number], [number, number]]

function segmentOf(edge: LabeledEdge, polyByLabel: Map<string, Facet['polygon']>): Segment | null {
  const poly = polyByLabel.get(edge.facetLabel)
  if (!poly || poly.length < 2) return null
  const n = poly.length
  const i = edge.vertexIndexStart
  const j = edge.vertexIndexEnd ?? (i + 1) % n
  if (!Number.isInteger(i) || i < 0 || i >= n) return null
  if (!Number.isInteger(j) || j < 0 || j >= n) return null
  const p = poly[i]
  const q = poly[j]
  if (!p || !q) return null
  return [[p[0], p[1]], [q[0], q[1]]]
}

function segmentLength(s: Segment): number {
  return Math.hypot(s[1][0] - s[0][0], s[1][1] - s[0][1])
}

/** Do two segments describe the same physical line, in either direction? */
function sameSegment(a: Segment, b: Segment): boolean {
  // Tolerance shrinks for short edges so two small dormer edges sitting close
  // together are never fused just for falling inside a fixed distance.
  const tol = Math.min(COINCIDENCE_TOL, 0.3 * Math.min(segmentLength(a), segmentLength(b)))
  if (tol <= 0) return false
  const close = (p: [number, number], q: [number, number]) =>
    Math.abs(p[0] - q[0]) <= tol && Math.abs(p[1] - q[1]) <= tol
  return (close(a[0], b[0]) && close(a[1], b[1])) || (close(a[0], b[1]) && close(a[1], b[0]))
}

function betterRepresentative(cur: LabeledEdge, cand: LabeledEdge): boolean {
  if (cand.userConfirmed !== cur.userConfirmed) return cand.userConfirmed
  const curInterior = INTERIOR_EDGE_TYPES.has(cur.edgeType)
  const candInterior = INTERIOR_EDGE_TYPES.has(cand.edgeType)
  if (candInterior !== curInterior) return candInterior
  return false
}

export interface EdgeGroup {
  /** The label this roof line is counted under. */
  representative: LabeledEdge
  /** Every stored record describing this same line (1 for outline, 2 for shared). */
  members: LabeledEdge[]
  /** Confirmed if *either* side was confirmed — the line itself is settled. */
  confirmed: boolean
  shared: boolean
}

/**
 * Collapse per-facet edge records into one entry per physical roof line.
 * Edges whose geometry can't be resolved stay separate rather than being
 * dropped — a malformed polygon must not make a real roof line disappear.
 */
export function groupEdgesByLine(facets: Facet[], edges: LabeledEdge[]): EdgeGroup[] {
  const polyByLabel = new Map(facets.map(f => [f.label, f.polygon]))
  const groups: { seg: Segment | null; members: LabeledEdge[] }[] = []

  for (const e of edges) {
    const seg = segmentOf(e, polyByLabel)
    if (seg && segmentLength(seg) > 0) {
      const hit = groups.find(g => g.seg && sameSegment(g.seg, seg))
      if (hit) { hit.members.push(e); continue }
    }
    groups.push({ seg, members: [e] })
  }

  return groups.map(g => {
    let representative = g.members[0]
    for (const m of g.members.slice(1)) {
      if (betterRepresentative(representative, m)) representative = m
    }
    return {
      representative,
      members: g.members,
      confirmed: g.members.some(m => m.userConfirmed),
      shared: g.members.length > 1,
    }
  })
}

const sameRecord = (a: LabeledEdge, b: { facetLabel: string; vertexIndexStart: number }) =>
  a.facetLabel === b.facetLabel && a.vertexIndexStart === b.vertexIndexStart

/**
 * One entry per physical roof line, for review UIs. Reviewing a shared line
 * twice — once from each facet — is busywork that also makes the "remaining"
 * count tick down by two for one decision.
 */
export function distinctLines(facets: Facet[], edges: LabeledEdge[]): LabeledEdge[] {
  return groupEdgesByLine(facets, edges).map(g => g.representative)
}

/**
 * Set a type on the roof line containing `target`, confirming every record that
 * describes it. The contractor is ruling on a line, not on one facet's copy of
 * it, so both sides of a shared edge must move together — otherwise the twin
 * stays unconfirmed and the panel keeps asking about a line already settled.
 */
export function labelLine(
  facets: Facet[],
  edges: LabeledEdge[],
  target: { facetLabel: string; vertexIndexStart: number },
  edgeType: EdgeType,
): LabeledEdge[] {
  const group = groupEdgesByLine(facets, edges).find(g => g.members.some(m => sameRecord(m, target)))
  const members = group ? group.members : edges.filter(e => sameRecord(e, target))
  const inLine = new Set(members)
  return edges.map(e => (inLine.has(e) ? { ...e, edgeType, userConfirmed: true } : e))
}

export interface EdgeReviewCounts {
  /** Distinct roof lines with no type yet — the auto-labeler's job. */
  needsLabel: number
  /** Distinct roof lines that have a type nobody has signed off on. */
  needsConfirm: number
  /** Distinct roof lines in total. */
  totalLines: number
}

/**
 * What still needs the contractor's attention, counted in roof lines rather
 * than stored records. `needsLabel` and `needsConfirm` are deliberately
 * disjoint: an edge with no type can't also be waiting on confirmation, and
 * conflating the two is what produced the phantom "still need confirming".
 */
export function edgeReviewCounts(facets: Facet[], edges: LabeledEdge[]): EdgeReviewCounts {
  const groups = groupEdgesByLine(facets, edges)
  let needsLabel = 0
  let needsConfirm = 0
  for (const g of groups) {
    if (g.representative.edgeType === 'unlabeled') needsLabel++
    else if (!g.confirmed) needsConfirm++
  }
  return { needsLabel, needsConfirm, totalLines: groups.length }
}
