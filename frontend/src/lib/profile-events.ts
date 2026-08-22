/**
 * A one-line signal that the business profile changed.
 *
 * Company name, phone and logo are read by several panels at once — the
 * settings form, the "finish your profile" banner, the report-branding card,
 * the permit portal — and each keeps its own copy in React state from its own
 * mount-time fetch. Saving in one left the others showing the old value until
 * something happened to remount them, which reads as "my edit didn't take".
 *
 * Same-tab listeners get a window event; other tabs get a BroadcastChannel
 * message, so a second window open on the dashboard corrects itself too.
 * Both are best-effort: this is a freshness nicety, never a correctness
 * dependency — the server is always the source of truth.
 */
const EVENT = 'axis:profile-updated'
const CHANNEL = 'axis-profile'

function channel(): BroadcastChannel | null {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return null
  try { return new BroadcastChannel(CHANNEL) } catch { return null }
}

/** Call after any successful write to the contractor profile. */
export function notifyProfileUpdated(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(EVENT))
  const ch = channel()
  if (ch) { try { ch.postMessage(EVENT) } finally { ch.close() } }
}

/** Subscribe to profile changes. Returns an unsubscribe function. */
export function onProfileUpdated(fn: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(EVENT, fn)
  const ch = channel()
  if (ch) ch.onmessage = () => fn()
  return () => {
    window.removeEventListener(EVENT, fn)
    if (ch) ch.close()
  }
}
