'use client'

/**
 * Lightweight photo-map view.
 *
 * Renders a grid of Esri satellite tiles covering every geotagged photo in
 * the project, with click-to-open pins positioned via Web Mercator → pixel
 * projection. Intentionally dependency-free (no Leaflet / Mapbox / react-
 * map-gl) so the Vercel build stays lean.
 */
import { useMemo, useState } from 'react'
import type { Photo } from '@/types'

const TILE_SIZE = 256
const MIN_ZOOM = 3
const MAX_ZOOM = 19

type Projected = { x: number; y: number; tx: number; ty: number; pxInTile: number; pyInTile: number }

function project(lat: number, lng: number, z: number): Projected {
  const sin = Math.sin((lat * Math.PI) / 180)
  const x = ((lng + 180) / 360) * Math.pow(2, z)
  const y = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * Math.pow(2, z)
  const tx = Math.floor(x)
  const ty = Math.floor(y)
  return {
    x, y, tx, ty,
    pxInTile: (x - tx) * TILE_SIZE,
    pyInTile: (y - ty) * TILE_SIZE,
  }
}

function esriTile(z: number, x: number, y: number): string {
  return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`
}

/** Pick the highest zoom where the bbox fits within `maxTiles` in both axes. */
function chooseZoom(points: { lat: number; lng: number }[], maxTiles: number): number {
  for (let z = MAX_ZOOM; z >= MIN_ZOOM; z--) {
    const xs = points.map(p => project(p.lat, p.lng, z).x)
    const ys = points.map(p => project(p.lat, p.lng, z).y)
    const spanX = Math.max(...xs) - Math.min(...xs)
    const spanY = Math.max(...ys) - Math.min(...ys)
    if (spanX <= maxTiles - 0.5 && spanY <= maxTiles - 0.5) return z
  }
  return MIN_ZOOM
}

export default function PhotoMapView({
  photos,
  onSelect,
}: {
  photos: Photo[]
  onSelect: (photo: Photo) => void
}) {
  const [hovered, setHovered] = useState<string | null>(null)

  const geoPhotos = useMemo(
    () => photos.filter(p => typeof p.latitude === 'number' && typeof p.longitude === 'number'),
    [photos],
  )

  const grid = useMemo(() => {
    if (geoPhotos.length === 0) return null
    const pts = geoPhotos.map(p => ({ lat: p.latitude as number, lng: p.longitude as number }))
    // Target ~3x3 tiles (768px square) — plenty for a job site, and keeps
    // pins large enough to click. If only 1 point, bump zoom to show detail.
    const zoom = pts.length === 1 ? 18 : chooseZoom(pts, 3)
    const xs = pts.map(p => project(p.lat, p.lng, zoom).x)
    const ys = pts.map(p => project(p.lat, p.lng, zoom).y)
    const midX = (Math.min(...xs) + Math.max(...xs)) / 2
    const midY = (Math.min(...ys) + Math.max(...ys)) / 2
    // 3x3 tile grid centered on the cluster mid-point.
    const originTx = Math.floor(midX - 1.5)
    const originTy = Math.floor(midY - 1.5)
    const offsetPxX = (midX - originTx - 1.5) * TILE_SIZE    // how far right the mid is inside the grid center
    const offsetPyY = (midY - originTy - 1.5) * TILE_SIZE
    const tiles: { x: number; y: number; col: number; row: number }[] = []
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        tiles.push({ x: originTx + col, y: originTy + row, col, row })
      }
    }
    const gridPx = TILE_SIZE * 3
    return { zoom, originTx, originTy, tiles, gridPx, offsetPxX, offsetPyY }
  }, [geoPhotos])

  if (geoPhotos.length === 0) {
    return (
      <div className="bg-white rounded-2xl p-12 text-center" style={{ boxShadow: '0 1px 3px rgba(15,23,42,0.06)' }}>
        <div className="text-5xl mb-4"></div>
        <div className="text-slate-700 font-semibold mb-1">No geotagged photos yet</div>
        <div className="text-slate-400 text-sm">
          Photos captured with the Guided Capture wizard (or any upload that allowed location access)
          will appear here on the map.
        </div>
      </div>
    )
  }

  const g = grid!
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>
          <strong className="text-slate-700">{geoPhotos.length}</strong> geotagged photo{geoPhotos.length === 1 ? '' : 's'}
        </span>
        <span className="text-slate-400">Esri World Imagery · zoom {g.zoom}</span>
      </div>

      <div className="relative bg-slate-900 rounded-2xl overflow-hidden" style={{ aspectRatio: '1 / 1', maxWidth: 720, margin: '0 auto' }}>
        {/* Tile grid — rendered as a CSS grid for easy positioning */}
        <div
          className="absolute inset-0"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gridTemplateRows: 'repeat(3, 1fr)',
          }}
        >
          {g.tiles.map(t => (
            <img
              key={`${t.x}-${t.y}`}
              src={esriTile(g.zoom, t.x, t.y)}
              alt=""
              loading="lazy"
              draggable={false}
              style={{ width: '100%', height: '100%', display: 'block', objectFit: 'cover' }}
            />
          ))}
        </div>

        {/* Pins */}
        {geoPhotos.map(p => {
          const proj = project(p.latitude as number, p.longitude as number, g.zoom)
          // Pin position in px within our 3-tile grid (grid is 3 * TILE_SIZE px = 768)
          const pxInGrid = (proj.tx - g.originTx) * TILE_SIZE + proj.pxInTile
          const pyInGrid = (proj.ty - g.originTy) * TILE_SIZE + proj.pyInTile
          const leftPct = (pxInGrid / (3 * TILE_SIZE)) * 100
          const topPct = (pyInGrid / (3 * TILE_SIZE)) * 100
          const isHover = hovered === p.id
          return (
            <button
              key={p.id}
              onClick={() => onSelect(p)}
              onMouseEnter={() => setHovered(p.id)}
              onMouseLeave={() => setHovered(null)}
              className="absolute -translate-x-1/2 -translate-y-full flex flex-col items-center transition-transform"
              style={{ left: `${leftPct}%`, top: `${topPct}%`, transform: `translate(-50%, -100%) scale(${isHover ? 1.1 : 1})` }}
              title={p.filename}
            >
              <span className="w-7 h-7 rounded-full border-2 border-white bg-red-500 shadow-lg shadow-red-900/40 flex items-center justify-center text-white text-xs font-bold"></span>
              {isHover && (
                <span className="mt-1 bg-slate-900/90 text-white text-[10px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap max-w-[180px] truncate">
                  {p.filename}
                </span>
              )}
            </button>
          )
        })}

        {/* Attribution */}
        <div className="absolute bottom-1 right-2 text-[9px] text-white/70 bg-black/30 px-1.5 rounded">
          Tiles © Esri
        </div>
      </div>
    </div>
  )
}
