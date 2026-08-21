/**
 * Browser-side image normalisation shared by every upload surface.
 *
 * iPhones shoot HEIC. Storage happily accepts the bytes and the filename gets
 * an .jpg extension, so an upload "succeeds" — but nothing can decode it: not
 * the gallery, not an <img>, and not ReportLab when it builds the PDF. The
 * photo silently vanishes downstream, which reads to the user as "it didn't
 * save". Convert before it ever leaves the browser.
 *
 * Native decoder first (fastest, and Safari can do it), heic2any as the
 * fallback — lazy-loaded so the WASM only downloads when a HEIC shows up.
 */
export function isHeic(file: File): boolean {
  return /^image\/hei[cf]$/i.test(file.type) || /\.(heic|heif)$/i.test(file.name)
}

export async function toUploadable(file: File): Promise<File> {
  if (!isHeic(file)) return file
  const name = file.name.replace(/\.(heic|heif)$/i, '.jpg') || 'photo.jpg'
  try {
    const url = URL.createObjectURL(file)
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url
    })
    if (img.naturalWidth) {
      const c = document.createElement('canvas')
      c.width = img.naturalWidth; c.height = img.naturalHeight
      c.getContext('2d')!.drawImage(img, 0, 0)
      const blob = await new Promise<Blob | null>(r => c.toBlob(r, 'image/jpeg', 0.9))
      URL.revokeObjectURL(url)
      if (blob) return new File([blob], name, { type: 'image/jpeg' })
    }
    URL.revokeObjectURL(url)
  } catch { /* fall through to the WASM decoder */ }
  const heic2any = (await import('heic2any')).default as
    (o: { blob: Blob; toType?: string; quality?: number }) => Promise<Blob | Blob[]>
  const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 })
  return new File([Array.isArray(out) ? out[0] : out], name, { type: 'image/jpeg' })
}
