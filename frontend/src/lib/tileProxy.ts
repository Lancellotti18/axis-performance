/**
 * Tile proxy helper.
 *
 * Reading a cross-origin satellite tile into a <canvas> throws a tainted-canvas
 * SecurityError when the provider doesn't send CORS headers — which silently
 * breaks clarity enhancement, snap-to-edge, and edge refinement. Routing the
 * tile through the backend proxy (which returns Access-Control-Allow-Origin: *)
 * makes it canvas-readable.
 *
 * Only http(s) PROVIDER tile URLs are proxied. blob:/data: URLs (e.g. the
 * enhanced tile, which is already same-origin) and already-proxied URLs pass
 * through untouched.
 */

const API_BASE = (process.env.NEXT_PUBLIC_API_URL || 'https://build-backend-jcp9.onrender.com').trim()

const PROXY_PATH = '/api/v1/roofing/v2/imagery/proxy'

// Hosts whose tiles we route through the proxy (mirror of the backend allowlist).
const PROXY_HOSTS = [
  'arcgisonline.com',
  'maptiler.com',
  'mapbox.com',
  'virtualearth.net',
]

/**
 * Return a canvas-readable URL for a tile. Provider URLs are wrapped through the
 * backend proxy; blob:/data:/already-proxied URLs are returned unchanged.
 */
export function proxiedTileUrl(url: string): string {
  if (!url) return url
  if (url.startsWith('blob:') || url.startsWith('data:')) return url
  if (url.includes(PROXY_PATH)) return url
  let host = ''
  try {
    host = new URL(url, API_BASE).hostname.toLowerCase()
  } catch {
    return url
  }
  const shouldProxy = PROXY_HOSTS.some(h => host === h || host.endsWith('.' + h))
  if (!shouldProxy) return url
  return `${API_BASE}${PROXY_PATH}?url=${encodeURIComponent(url)}`
}
