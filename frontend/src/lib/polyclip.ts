/**
 * Polygon clipping for verify-not-trace facet generation.
 *
 * Google Solar knows the roof PLANES (count, measured pitch, azimuth) but only
 * returns crude bounding rectangles. OSM knows the building OUTLINE exactly but
 * not the planes. Intersecting them — footprint ∩ each plane's bbox — yields
 * facets whose outer edges lie on the real roof edge, with measured pitch:
 * close enough that the contractor verifies instead of traces.
 *
 * Sutherland–Hodgman: clips any subject polygon (the footprint, possibly
 * concave) against a CONVEX clipper (the plane's axis-aligned bbox rectangle).
 */

export type Pt = [number, number]

/** Clip `subject` (any simple polygon) to the axis-aligned rect [x0,y0,x1,y1]. */
export function clipPolygonToRect(subject: Pt[], x0: number, y0: number, x1: number, y1: number): Pt[] {
  if (subject.length < 3) return []
  const lo = { x: Math.min(x0, x1), y: Math.min(y0, y1) }
  const hi = { x: Math.max(x0, x1), y: Math.max(y0, y1) }

  // Each clip edge as inside-test + segment-intersection against that edge.
  type Edge = { inside: (p: Pt) => boolean; intersect: (a: Pt, b: Pt) => Pt }
  const edges: Edge[] = [
    { inside: p => p[0] >= lo.x, intersect: (a, b) => ixVert(a, b, lo.x) },
    { inside: p => p[0] <= hi.x, intersect: (a, b) => ixVert(a, b, hi.x) },
    { inside: p => p[1] >= lo.y, intersect: (a, b) => ixHorz(a, b, lo.y) },
    { inside: p => p[1] <= hi.y, intersect: (a, b) => ixHorz(a, b, hi.y) },
  ]

  let out = subject
  for (const e of edges) {
    const input = out
    out = []
    for (let i = 0; i < input.length; i++) {
      const cur = input[i]
      const prev = input[(i + input.length - 1) % input.length]
      const curIn = e.inside(cur)
      const prevIn = e.inside(prev)
      if (curIn) {
        if (!prevIn) out.push(e.intersect(prev, cur))
        out.push(cur)
      } else if (prevIn) {
        out.push(e.intersect(prev, cur))
      }
    }
    if (out.length === 0) return []
  }
  return dedupe(out)
}

function ixVert(a: Pt, b: Pt, x: number): Pt {
  const t = (x - a[0]) / ((b[0] - a[0]) || 1e-12)
  return [x, a[1] + t * (b[1] - a[1])]
}
function ixHorz(a: Pt, b: Pt, y: number): Pt {
  const t = (y - a[1]) / ((b[1] - a[1]) || 1e-12)
  return [a[0] + t * (b[0] - a[0]), y]
}

/** Drop consecutive duplicates + collinear midpoints (keeps polygons clean for
 *  the editor + the shared-edge detector). */
function dedupe(poly: Pt[], eps = 1e-6): Pt[] {
  const pts = poly.filter((p, i) => {
    const q = poly[(i + 1) % poly.length]
    return Math.abs(p[0] - q[0]) > eps || Math.abs(p[1] - q[1]) > eps
  })
  if (pts.length < 3) return []
  const out: Pt[] = []
  for (let i = 0; i < pts.length; i++) {
    const a = pts[(i + pts.length - 1) % pts.length]
    const b = pts[i]
    const c = pts[(i + 1) % pts.length]
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    if (Math.abs(cross) > 1e-9) out.push(b)
  }
  return out.length >= 3 ? out : pts
}

export function polygonArea(poly: Pt[]): number {
  let s = 0
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i]
    const [x2, y2] = poly[(i + 1) % poly.length]
    s += x1 * y2 - x2 * y1
  }
  return Math.abs(s) / 2
}

/**
 * Offset a simple polygon outward by `d` (same units as the points; pass
 * PIXEL coordinates — image fractions are anisotropic). Used to compensate
 * for roof OVERHANG: OSM footprints trace the walls, but the roof edge
 * extends past them by ~1-2 ft. Miter offset along vertex normals — accurate
 * for the gentle angles of building outlines.
 */
export function offsetPolygon(poly: Pt[], d: number): Pt[] {
  const n = poly.length
  if (n < 3 || d === 0) return poly

  // Winding: shoelace sign tells us which perpendicular points outward.
  let s = 0
  for (let i = 0; i < n; i++) {
    const [x1, y1] = poly[i]
    const [x2, y2] = poly[(i + 1) % n]
    s += x1 * y2 - x2 * y1
  }
  const ccw = s > 0

  const out: Pt[] = []
  for (let i = 0; i < n; i++) {
    const p = poly[(i + n - 1) % n]
    const c = poly[i]
    const q = poly[(i + 1) % n]
    // Unit normals of the two edges meeting at c (outward side by winding).
    const nrm = (a: Pt, b: Pt): Pt => {
      const dx = b[0] - a[0], dy = b[1] - a[1]
      const L = Math.hypot(dx, dy) || 1e-12
      return ccw ? [dy / L, -dx / L] : [-dy / L, dx / L]
    }
    const n1 = nrm(p, c)
    const n2 = nrm(c, q)
    // Miter direction = normalized normal sum; scale by miter length (capped
    // so near-collinear spikes can't explode).
    let mx = n1[0] + n2[0], my = n1[1] + n2[1]
    const mlen = Math.hypot(mx, my) || 1e-12
    mx /= mlen; my /= mlen
    const cosHalf = Math.max(0.35, (1 + n1[0] * n2[0] + n1[1] * n2[1]) / 2)  // cap ≈ 70° miter
    const scale = d / Math.sqrt(cosHalf)
    out.push([c[0] + mx * scale, c[1] + my * scale])
  }
  return out
}

/**
 * Weld nearly-coincident vertices ACROSS polygons to identical coordinates.
 * Auto-generated facets (Solar bboxes clipped to the footprint) have seams
 * that are close but not exact — and the edge classifier's shared-edge +
 * corner-angle logic depends on coincidence. Welding within `tol` makes
 * adjacent planes truly share edges, which is what fixes occasional
 * hip↔eave / ridge↔rake mislabels on auto-traced roofs.
 *
 * Pass PIXEL-space tolerance via tolX/tolY converted per axis by the caller.
 * First occurrence of a cluster wins; later vertices snap to it exactly.
 */
export function weldPolygons(polys: Pt[][], tolX: number, tolY: number): Pt[][] {
  const canon: Pt[] = []
  const snap = (p: Pt): Pt => {
    for (const c of canon) {
      if (Math.abs(c[0] - p[0]) <= tolX && Math.abs(c[1] - p[1]) <= tolY) return [c[0], c[1]]
    }
    canon.push([p[0], p[1]])
    return [p[0], p[1]]
  }
  return polys.map(poly => {
    const out = poly.map(snap)
    // Welding can collapse consecutive vertices — drop exact duplicates.
    return out.filter((p, i) => {
      const q = out[(i + 1) % out.length]
      return p[0] !== q[0] || p[1] !== q[1]
    })
  })
}
