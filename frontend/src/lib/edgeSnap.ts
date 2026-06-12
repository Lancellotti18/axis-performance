/**
 * Client-side edge snapping for the roof facet editor.
 *
 * When the contractor clicks near where they think a roof edge is, this
 * snaps the vertex to the highest-gradient pixel within a small radius —
 * which is almost always where the actual edge of the roof / shadow line
 * lives. Makes tracing on blurry satellite imagery dramatically more
 * accurate without changing the imagery itself.
 *
 * Implementation:
 *   1. On image load, compute a gradient-magnitude map (Sobel-ish).
 *      Stored as Float32Array of the same dimensions as the source image.
 *   2. On click, look up gradient magnitudes within `radius` pixels of
 *      the cursor; pick the brightest pixel as the snap target.
 *
 * The gradient map is cached per imageUrl so it only computes once per
 * tile load. ~80–150ms for a 2048×1366 retina tile on modern hardware.
 */

type EdgeMap = {
  url: string
  width: number
  height: number
  /** gradient magnitude per pixel, row-major (y * width + x) */
  gradient: Float32Array
  /** rolling max for snap-priority calculation (not stored; recomputed) */
  maxGradient: number
}

let cached: EdgeMap | null = null
let pending: Promise<EdgeMap> | null = null


/**
 * Build an edge map from the satellite image. Idempotent per URL; returns
 * the cached map immediately if already built for this URL. Pending
 * loads share the same Promise so concurrent callers don't double-compute.
 */
export async function buildEdgeMap(imageUrl: string): Promise<EdgeMap> {
  if (cached && cached.url === imageUrl) return cached
  if (pending) return pending

  pending = (async () => {
    const img = await loadImageElement(imageUrl)
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('Could not create 2D canvas context')
    ctx.drawImage(img, 0, 0)
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const gradient = computeGradientMap(imageData)
    let maxG = 0
    for (let i = 0; i < gradient.length; i++) {
      if (gradient[i] > maxG) maxG = gradient[i]
    }
    const edgeMap: EdgeMap = {
      url: imageUrl,
      width: canvas.width,
      height: canvas.height,
      gradient,
      maxGradient: maxG,
    }
    cached = edgeMap
    return edgeMap
  })()

  try {
    return await pending
  } finally {
    pending = null
  }
}


/**
 * Snap a point (in source-image pixel coords) to the nearest high-edge
 * pixel within `radius`. If no edge is sufficiently strong, returns the
 * original point unchanged.
 *
 * @param x_px source-image x in pixels
 * @param y_px source-image y in pixels
 * @param radius search radius in pixels (default 12)
 * @param minGradientFraction reject if the brightest pixel in radius has
 *   gradient below this fraction of the global max. Prevents snapping to
 *   flat areas (e.g. middle of a roof plane). Default 0.10 (~10%).
 */
export function snapToNearestEdge(
  x_px: number,
  y_px: number,
  radius: number = 12,
  minGradientFraction: number = 0.10,
): { x: number; y: number; snapped: boolean; gradient: number } {
  if (!cached) {
    return { x: x_px, y: y_px, snapped: false, gradient: 0 }
  }
  const { width, height, gradient, maxGradient } = cached
  const cx = Math.round(x_px)
  const cy = Math.round(y_px)

  let bestX = cx
  let bestY = cy
  let bestG = -1

  const xLo = Math.max(1, cx - radius)
  const xHi = Math.min(width - 2, cx + radius)
  const yLo = Math.max(1, cy - radius)
  const yHi = Math.min(height - 2, cy + radius)

  for (let py = yLo; py <= yHi; py++) {
    for (let px = xLo; px <= xHi; px++) {
      const g = gradient[py * width + px]
      // Apply a small distance penalty so we prefer closer edges over
      // slightly stronger but further ones — keeps the snap subjectively
      // "near the click."
      const dx = px - cx
      const dy = py - cy
      const distPenalty = 1.0 - Math.sqrt(dx * dx + dy * dy) / (radius * 2.5)
      const score = g * Math.max(0, distPenalty)
      if (score > bestG) {
        bestG = score
        bestX = px
        bestY = py
      }
    }
  }

  const minAcceptable = maxGradient * minGradientFraction
  if (bestG < minAcceptable) {
    return { x: x_px, y: y_px, snapped: false, gradient: bestG }
  }
  return { x: bestX, y: bestY, snapped: true, gradient: bestG }
}


/**
 * Clear cache (e.g. when a new tile loads).
 * Call this from the editor when imageUrl changes.
 */
export function clearEdgeCache(): void {
  cached = null
  pending = null
}


// ─── Helpers ────────────────────────────────────────────────────────

function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = e => reject(e)
    img.src = url
  })
}


/**
 * Sobel-style gradient magnitude per pixel. Uses luminance:
 *   L = 0.299*R + 0.587*G + 0.114*B
 *
 * Returns Float32Array of width*height. Border pixels (1px wide) are 0.
 */
function computeGradientMap(imageData: ImageData): Float32Array {
  const { data, width, height } = imageData
  const lum = new Float32Array(width * height)
  for (let i = 0; i < width * height; i++) {
    const j = i * 4
    lum[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2]
  }

  const grad = new Float32Array(width * height)
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      // Sobel 3×3 kernels
      const tl = lum[(y - 1) * width + (x - 1)]
      const tc = lum[(y - 1) * width + x]
      const tr = lum[(y - 1) * width + (x + 1)]
      const ml = lum[y * width + (x - 1)]
      const mr = lum[y * width + (x + 1)]
      const bl = lum[(y + 1) * width + (x - 1)]
      const bc = lum[(y + 1) * width + x]
      const br = lum[(y + 1) * width + (x + 1)]
      const gx = (tr + 2 * mr + br) - (tl + 2 * ml + bl)
      const gy = (bl + 2 * bc + br) - (tl + 2 * tc + tr)
      grad[y * width + x] = Math.hypot(gx, gy)
    }
  }
  return grad
}
