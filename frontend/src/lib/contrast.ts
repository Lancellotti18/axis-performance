/**
 * Readable text on a contractor-chosen colour.
 *
 * The public quote page and roof report paint surfaces with the contractor's
 * accent colour but hardcoded their text colour — `text-white` in some places,
 * near-black in others. So a light accent made white text vanish and a dark
 * accent made dark text vanish, and the contractor could not see it because
 * they picked the colour themselves and the page looked fine to whoever chose
 * a mid-tone. Pick the ink from the background instead of assuming it.
 */

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

/** WCAG 2.x relative luminance. Returns null for anything that isn't a hex colour. */
export function luminance(hex: string): number | null {
  if (!hex || !HEX.test(hex)) return null
  let h = hex.slice(1)
  if (h.length === 3) h = h.split('').map(c => c + c).join('')
  const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const [r, g, b] = [0, 2, 4].map(i => f(parseInt(h.slice(i, i + 2), 16) / 255))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio between two hex colours, 1..21. Null if either is unparseable. */
export function contrastRatio(a: string, b: string): number | null {
  const la = luminance(a), lb = luminance(b)
  if (la == null || lb == null) return null
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

export const INK_LIGHT = '#ffffff'
export const INK_DARK = '#111827'   // slate-900; softer than pure black on colour

/**
 * The more readable of white / near-black against `bg`.
 *
 * Whichever wins on WCAG contrast ratio — not a luminance threshold, because a
 * fixed cutoff picks white on saturated mid-tones (a strong red, a mid green)
 * where near-black actually reads better.
 *
 * `fallback` is used when `bg` isn't a hex colour, so a blank or half-typed
 * value in the colour field can't blank out the page's text.
 */
export function readableInk(bg: string, fallback: string = INK_LIGHT): string {
  const withLight = contrastRatio(bg, INK_LIGHT)
  const withDark = contrastRatio(bg, INK_DARK)
  if (withLight == null || withDark == null) return fallback
  return withLight >= withDark ? INK_LIGHT : INK_DARK
}

/**
 * Ink for a surface painted with the `linear-gradient(brand -> darker brand)`
 * treatment used across the quote pages. The gradient only ever darkens, so the
 * brand colour itself is the lightest point — pass that and whatever reads
 * there reads across the whole sweep.
 */
export function readableInkOnBrand(brand: string): string {
  return readableInk(brand, INK_LIGHT)
}
