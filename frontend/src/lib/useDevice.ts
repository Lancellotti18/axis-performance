'use client'

/**
 * What kind of device is this, really?
 *
 * Two questions the app used to conflate into one:
 *
 *  - HOW MUCH ROOM is there?  -> width. Drives layout (columns, rails, grids).
 *  - FINGER OR MOUSE?         -> pointer type. Drives hit targets, drag
 *                                behaviour, and whether hover-only affordances
 *                                are reachable at all.
 *
 * They are genuinely independent. An iPad Pro in landscape is 1366px — wider
 * than many laptops — so width alone hands it a desktop UI with 24px targets
 * and hover tooltips a finger can never trigger. A Surface is the opposite:
 * large screen AND touch.
 *
 * User-agent sniffing is not an option: iPadOS reports itself as macOS, so an
 * iPad is indistinguishable from a desktop Mac by UA string. Media queries are
 * the honest signal.
 *
 * SSR-safe: returns desktop-shaped defaults on the server and during the first
 * client frame, so nothing hydration-mismatches and the desktop path is what
 * renders when we do not yet know. Anything touch-specific is therefore
 * strictly additive — a mouse user can never be handed a touch layout.
 */
import { useEffect, useState } from 'react'

export interface DeviceInfo {
  /** Coarse pointer — a finger or stylus rather than a mouse. */
  isTouch: boolean
  /** The device cannot hover, so hover-only UI is unreachable. */
  canHover: boolean
  /** Viewport width buckets, matching Tailwind's breakpoints. */
  isPhone: boolean      // < 640px
  isTablet: boolean     // 640px .. 1024px
  isDesktop: boolean    // >= 1024px
  width: number
}

const DESKTOP: DeviceInfo = {
  isTouch: false, canHover: true,
  isPhone: false, isTablet: false, isDesktop: true,
  width: 1280,
}

export function useDevice(): DeviceInfo {
  const [info, setInfo] = useState<DeviceInfo>(DESKTOP)

  useEffect(() => {
    const coarse = window.matchMedia('(pointer: coarse)')
    const hover = window.matchMedia('(hover: hover)')

    const read = () => {
      const w = window.innerWidth
      setInfo({
        // maxTouchPoints is the backstop for browsers that report pointer
        // support oddly on hybrid machines.
        isTouch: coarse.matches || (navigator.maxTouchPoints ?? 0) > 0,
        canHover: hover.matches,
        isPhone: w < 640,
        isTablet: w >= 640 && w < 1024,
        isDesktop: w >= 1024,
        width: w,
      })
    }
    read()

    window.addEventListener('resize', read, { passive: true })
    window.addEventListener('orientationchange', read)
    coarse.addEventListener?.('change', read)
    hover.addEventListener?.('change', read)
    return () => {
      window.removeEventListener('resize', read)
      window.removeEventListener('orientationchange', read)
      coarse.removeEventListener?.('change', read)
      hover.removeEventListener?.('change', read)
    }
  }, [])

  return info
}
