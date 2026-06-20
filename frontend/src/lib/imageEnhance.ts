/**
 * Client-side satellite-tile enhancement for roof tracing.
 *
 * This is the honest replacement for the AI "sharpen" feature. It does NOT
 * invent detail (no hallucinated shingles) — it redistributes the detail
 * that's already in the pixels so roof-plane boundaries, ridges, hips, and
 * valleys become easier for a human to see and trace:
 *
 *   1. Contrast stretch — remap the luminance histogram between the 1st and
 *      99th percentile so dark roofs in shadow use the full tonal range.
 *   2. Clarity (local contrast) — a large-radius unsharp mask. This is the
 *      single most effective operation for revealing roof-plane edges; it
 *      amplifies the local contrast exactly where plane boundaries live.
 *   3. Detail sharpen — a small-radius unsharp mask that crispens fine lines
 *      (ridge caps, drip edges).
 *   4. Edge overlay (optional) — a Sobel gradient thresholded and painted in
 *      cyan over the image, so the contractor can literally SEE where the
 *      strongest linear features are. Helps locate ridges/valleys on hazy
 *      imagery. Off by default (it also highlights driveways/tree lines).
 *
 * Everything runs on a <canvas> with typed-array math. A 4096×2732 retina
 * tile enhances in ~150–350ms on modern hardware. The result is returned as
 * an object-URL (Blob) which is far lighter than a base64 data URL.
 *
 * IMPORTANT: measurements are NEVER computed from the enhanced image — the
 * metres-per-pixel scale comes from the original tile. This is visualization
 * only, same contract as the old sharpen feature.
 */
import { proxiedTileUrl } from '@/lib/tileProxy'

export interface EnhanceOptions {
  /** Percentile contrast stretch. 0 disables. Default 0.01 (1%–99%). */
  contrastStretch: number
  /** Local-contrast "clarity" strength, 0–1.5. Default 0.6. */
  clarity: number
  /** Fine-detail sharpening strength, 0–1.5. Default 0.4. */
  sharpness: number
  /** Paint Sobel edges over the image. Default false. */
  edgeOverlay: boolean
  /** Edge overlay opacity 0–1. Default 0.5. */
  edgeOverlayOpacity: number
}

export const DEFAULT_ENHANCE: EnhanceOptions = {
  contrastStretch: 0.01,
  clarity: 0.6,
  sharpness: 0.4,
  edgeOverlay: false,
  edgeOverlayOpacity: 0.5,
}

export interface EnhanceResult {
  /** object-URL of the enhanced PNG; revoke when no longer displayed */
  url: string
  width: number
  height: number
  revoke: () => void
}


/**
 * Enhance a satellite tile. Loads the image, applies the enabled operations,
 * and returns a Blob URL. Throws if the image can't be loaded (e.g. CORS).
 */
export async function enhanceTile(
  imageUrl: string,
  opts: Partial<EnhanceOptions> = {},
): Promise<EnhanceResult> {
  const o: EnhanceOptions = { ...DEFAULT_ENHANCE, ...opts }
  const img = await loadImage(imageUrl)
  const w = img.naturalWidth
  const h = img.naturalHeight

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('2D canvas context unavailable')
  ctx.drawImage(img, 0, 0)
  const imageData = ctx.getImageData(0, 0, w, h)

  if (o.contrastStretch > 0) contrastStretch(imageData, o.contrastStretch)
  if (o.clarity > 0) unsharpMask(imageData, Math.max(8, Math.round(Math.min(w, h) / 90)), o.clarity)
  if (o.sharpness > 0) unsharpMask(imageData, 1, o.sharpness)
  if (o.edgeOverlay) edgeOverlay(imageData, o.edgeOverlayOpacity)

  ctx.putImageData(imageData, 0, 0)

  const blob = await canvasToBlob(canvas)
  const url = URL.createObjectURL(blob)
  return { url, width: w, height: h, revoke: () => URL.revokeObjectURL(url) }
}


// ─── Operations ───────────────────────────────────────────────────────

/**
 * Percentile-based contrast stretch. Builds a luminance histogram, finds the
 * `pct` and `1-pct` cut points, and linearly remaps each RGB channel so those
 * cut points map to 0 and 255. Preserves color (applies the same luminance
 * remap curve to all three channels).
 */
function contrastStretch(imageData: ImageData, pct: number): void {
  const { data, width, height } = imageData
  const n = width * height
  const hist = new Uint32Array(256)
  for (let i = 0; i < n; i++) {
    const j = i * 4
    const lum = (data[j] * 0.299 + data[j + 1] * 0.587 + data[j + 2] * 0.114) | 0
    hist[lum]++
  }
  const loCount = n * pct
  const hiCount = n * (1 - pct)
  let lo = 0
  let hi = 255
  let acc = 0
  for (let v = 0; v < 256; v++) {
    acc += hist[v]
    if (acc >= loCount) { lo = v; break }
  }
  acc = 0
  for (let v = 0; v < 256; v++) {
    acc += hist[v]
    if (acc >= hiCount) { hi = v; break }
  }
  if (hi <= lo) return
  const scale = 255 / (hi - lo)
  const lut = new Uint8ClampedArray(256)
  for (let v = 0; v < 256; v++) {
    lut[v] = Math.max(0, Math.min(255, (v - lo) * scale))
  }
  for (let i = 0; i < n; i++) {
    const j = i * 4
    data[j] = lut[data[j]]
    data[j + 1] = lut[data[j + 1]]
    data[j + 2] = lut[data[j + 2]]
  }
}

/**
 * Unsharp mask: out = in + amount * (in - blurred). Large radius gives "clarity"
 * (local contrast), small radius gives fine sharpening. Operates per-channel.
 */
function unsharpMask(imageData: ImageData, radius: number, amount: number): void {
  const { data, width, height } = imageData
  const n = width * height
  // Extract channels
  const r = new Float32Array(n)
  const g = new Float32Array(n)
  const b = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const j = i * 4
    r[i] = data[j]; g[i] = data[j + 1]; b[i] = data[j + 2]
  }
  const rb = boxBlur(r, width, height, radius)
  const gb = boxBlur(g, width, height, radius)
  const bb = boxBlur(b, width, height, radius)
  for (let i = 0; i < n; i++) {
    const j = i * 4
    data[j]     = clamp255(r[i] + amount * (r[i] - rb[i]))
    data[j + 1] = clamp255(g[i] + amount * (g[i] - gb[i]))
    data[j + 2] = clamp255(b[i] + amount * (b[i] - bb[i]))
  }
}

/**
 * Separable box blur using a sliding window running-sum — O(n) regardless of
 * radius. Two passes (horizontal then vertical) approximate a Gaussian well
 * enough for unsharp masking.
 */
function boxBlur(src: Float32Array, w: number, h: number, radius: number): Float32Array {
  const tmp = new Float32Array(src.length)
  const out = new Float32Array(src.length)
  const win = radius * 2 + 1

  // Horizontal pass: src → tmp
  for (let y = 0; y < h; y++) {
    const row = y * w
    let sum = 0
    for (let x = -radius; x <= radius; x++) {
      sum += src[row + clampIdx(x, w)]
    }
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / win
      const add = src[row + clampIdx(x + radius + 1, w)]
      const sub = src[row + clampIdx(x - radius, w)]
      sum += add - sub
    }
  }

  // Vertical pass: tmp → out
  for (let x = 0; x < w; x++) {
    let sum = 0
    for (let y = -radius; y <= radius; y++) {
      sum += tmp[clampIdx(y, h) * w + x]
    }
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / win
      const add = tmp[clampIdx(y + radius + 1, h) * w + x]
      const sub = tmp[clampIdx(y - radius, h) * w + x]
      sum += add - sub
    }
  }
  return out
}

/**
 * Sobel gradient overlay. Strong gradients (roof edges, road edges) get
 * painted toward cyan proportional to gradient strength × opacity.
 */
function edgeOverlay(imageData: ImageData, opacity: number): void {
  const { data, width, height } = imageData
  const n = width * height
  const lum = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const j = i * 4
    lum[i] = data[j] * 0.299 + data[j + 1] * 0.587 + data[j + 2] * 0.114
  }
  // Find max gradient for normalization (sampled)
  let maxG = 1
  const grad = new Float32Array(n)
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x
      const gx = (lum[i - width + 1] + 2 * lum[i + 1] + lum[i + width + 1])
               - (lum[i - width - 1] + 2 * lum[i - 1] + lum[i + width - 1])
      const gy = (lum[i + width - 1] + 2 * lum[i + width] + lum[i + width + 1])
               - (lum[i - width - 1] + 2 * lum[i - width] + lum[i - width + 1])
      const m = Math.hypot(gx, gy)
      grad[i] = m
      if (m > maxG) maxG = m
    }
  }
  // Only paint the top ~25% strongest edges so the overlay isn't noise
  const threshold = maxG * 0.22
  for (let i = 0; i < n; i++) {
    if (grad[i] < threshold) continue
    const strength = Math.min(1, (grad[i] - threshold) / (maxG - threshold)) * opacity
    const j = i * 4
    // Blend toward cyan (0, 255, 255)
    data[j]     = clamp255(data[j]     * (1 - strength) + 0   * strength)
    data[j + 1] = clamp255(data[j + 1] * (1 - strength) + 255 * strength)
    data[j + 2] = clamp255(data[j + 2] * (1 - strength) + 255 * strength)
  }
}


// ─── Helpers ────────────────────────────────────────────────────────────

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v
}

function clampIdx(i: number, max: number): number {
  return i < 0 ? 0 : i >= max ? max - 1 : i
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Could not load image (CORS or network)'))
    // Route provider tiles through the backend proxy so the canvas read isn't
    // blocked by missing CORS headers (blob:/data: pass through unchanged).
    img.src = proxiedTileUrl(url)
  })
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => (blob ? resolve(blob) : reject(new Error('canvas.toBlob returned null'))),
      'image/png',
    )
  })
}
