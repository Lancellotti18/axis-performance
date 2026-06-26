'use client'
/**
 * HeroImageScene — crisp, single-image cinematic hero.
 *
 * Drop-in replacement for HouseScrollScene's API (children + onProgress +
 * trackHeightVh) but renders ONE high-resolution still with a subtle
 * scroll-driven parallax/zoom instead of a frame sequence. A single 4K image
 * is always crystal clear (the browser scales it cleanly) — no per-frame
 * upscaling blur — while the scroll progress still drives the overlay phase
 * cards exactly as before.
 */
import { useCallback, useEffect, useRef } from 'react'

interface Props {
  /** Path to the hero image (public/). */
  image: string
  /** Children render absolutely on top (overlay content). */
  children?: React.ReactNode
  /** Height of the scroll track in vh. */
  trackHeightVh?: number
  /** Called every frame with scroll progress (0..1) — drives overlay reveals. */
  onProgress?: (progress: number) => void
}

export default function HeroImageScene({
  image,
  children,
  trackHeightVh = 400,
  onProgress,
}: Props) {
  const trackRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const rafRef = useRef<number | null>(null)

  const onScroll = useCallback(() => {
    if (rafRef.current != null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      const track = trackRef.current
      if (!track) return
      const rect = track.getBoundingClientRect()
      const trackH = track.offsetHeight - window.innerHeight
      const progress = Math.max(0, Math.min(1, -rect.top / (trackH || 1)))
      // Slow cinematic push-in + slight rise (Ken Burns). GPU transform only.
      const img = imgRef.current
      if (img) {
        const scale = 1.06 + progress * 0.12
        const ty = progress * -3
        img.style.transform = `scale(${scale}) translateY(${ty}%)`
      }
      onProgress?.(progress)
    })
  }, [onProgress])

  useEffect(() => {
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll, { passive: true })
    onScroll()
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    }
  }, [onScroll])

  return (
    <div ref={trackRef} className="relative" style={{ height: `${trackHeightVh}vh` }}>
      <div className="sticky top-0 h-screen w-full overflow-hidden bg-[#02060f]">
        {/* The crisp hero image */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={imgRef}
          src={image}
          alt="Modern home at dusk with its roof being measured by a glowing AI digital-twin scan"
          className="absolute inset-0 h-full w-full object-cover will-change-transform"
          style={{
            transform: 'scale(1.06)',
            transformOrigin: '50% 42%',
            // light, GPU-cheap punch so it reads crisp + premium
            filter: 'contrast(1.05) saturate(1.06)',
          }}
          draggable={false}
          fetchPriority="high"
        />

        {/* Gentle corner vignette only — keeps the subject clean + crisp */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(ellipse 95% 85% at 50% 45%, transparent 0%, transparent 68%, rgba(2,6,18,0.45) 100%)',
          }}
        />
        {/* Edge fades blending into the dark page chrome */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-[#02060f] via-[#02060f]/35 to-transparent" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-[#02060f] via-[#02060f]/55 to-transparent" />
        {/* Faint brand glow, pushed to a corner for depth */}
        <div
          className="pointer-events-none absolute -bottom-40 -right-40 h-[560px] w-[560px] rounded-full opacity-[0.16] blur-3xl"
          style={{ background: 'radial-gradient(circle, rgba(74,144,226,0.3), transparent 60%)' }}
        />

        {children}
      </div>
    </div>
  )
}
