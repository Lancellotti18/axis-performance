'use client'

/**
 * Public crew view — a phone-friendly, read-only photo gallery for a project.
 * No login: the token in the URL is the auth. Crews see the same phase groups,
 * captions, and markup the office added. Tap a photo to view it full-screen.
 */
import { use, useEffect, useState } from 'react'
import { api, type ProjectPhoto } from '@/lib/api'
import { PhotoMarkup, PHASE_ORDER, PHASE_META } from '@/app/(dashboard)/projects/[id]/ProjectPhotos'

export default function CrewGalleryPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params)
  const [data, setData] = useState<Awaited<ReturnType<typeof api.projectPhotos.publicGallery>> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [zoom, setZoom] = useState<ProjectPhoto | null>(null)

  useEffect(() => {
    api.projectPhotos.publicGallery(token)
      .then(setData)
      .catch(e => setError(e instanceof Error ? e.message.replace(/\[HTTP \d+\]\s*/, '') : 'This link is unavailable.'))
  }, [token])

  if (error) return (
    <div className="flex min-h-screen items-center justify-center bg-[#eeeeed] p-8 text-center">
      <div>
        <div className="text-lg font-semibold text-[#1a1a1a]">Photos unavailable</div>
        <div className="mt-1 text-sm text-[#6b7280]">{error}</div>
      </div>
    </div>
  )
  if (!data) return (
    <div className="flex min-h-screen items-center justify-center bg-[#eeeeed] text-sm text-[#6b7280]">Loading photos…</div>
  )

  const { project, photos } = data
  return (
    <div className="min-h-screen bg-[#eeeeed]">
      <div className="mx-auto max-w-3xl p-4 sm:p-6">
        <header className="mb-5 border-b border-[#dededc] pb-4">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-blue-400">Axis · Job photos</div>
          <h1 className="mt-1 text-xl font-bold text-[#1a1a1a]">{project.name || 'Project'}</h1>
          {(project.address || project.city) && (
            <p className="text-sm text-[#6b7280]">{[project.address, project.city].filter(Boolean).join(', ')}</p>
          )}
        </header>

        {photos.length === 0 && <div className="py-16 text-center text-sm text-[#6b7280]">No photos posted yet.</div>}

        {PHASE_ORDER.map(phase => {
          const inPhase = photos.filter(p => p.phase === phase)
          if (!inPhase.length) return null
          const meta = PHASE_META[phase]
          return (
            <section key={phase} className="mb-6">
              <div className="mb-2 flex items-center gap-2">
                <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide ${meta.chip}`}>{meta.label}</span>
                <span className="text-xs text-[#6b7280]">{inPhase.length} photo{inPhase.length === 1 ? '' : 's'}</span>
              </div>
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                {inPhase.map(p => (
                  <button key={p.id} onClick={() => setZoom(p)}
                    className={`group relative aspect-square overflow-hidden rounded-lg bg-[#f8f8f7] ring-1 ${meta.ring}`}>
                    {p.url
                      // eslint-disable-next-line @next/next/no-img-element
                      ? <img src={p.url} alt={p.caption || ''} loading="lazy" className="h-full w-full object-cover" />
                      : <div className="flex h-full items-center justify-center text-[10px] text-[#9ca3af]">unavailable</div>}
                    <PhotoMarkup annotations={p.annotations || []} />
                    {p.caption && (
                      <div className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/80 to-transparent px-2 pb-1.5 pt-4 text-left text-[10px] text-white">{p.caption}</div>
                    )}
                  </button>
                ))}
              </div>
            </section>
          )
        })}
      </div>

      {zoom && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/92 p-4" onClick={() => setZoom(null)}>
          <div className="relative max-h-[82vh] w-auto" onClick={e => e.stopPropagation()}>
            {zoom.url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={zoom.url} alt={zoom.caption || ''} className="block max-h-[82vh] w-auto rounded-lg" />
            )}
            <PhotoMarkup annotations={zoom.annotations || []} />
          </div>
          {zoom.caption && <div className="mt-3 max-w-lg text-center text-sm text-[#1a1a1a]">{zoom.caption}</div>}
          <button onClick={() => setZoom(null)} className="mt-3 rounded-lg bg-[#eeeeed] px-4 py-2 text-sm text-[#1a1a1a] hover:bg-white/20">Close</button>
        </div>
      )}
    </div>
  )
}
