import { ImageResponse } from 'next/og'

export const runtime = 'edge'
export const alt = 'Roof Intelligence Report'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

const API_BASE = (process.env.NEXT_PUBLIC_API_URL || 'https://build-backend-jcp9.onrender.com').trim()

/**
 * The "Zillow card": a shared report link unfurls with the actual satellite
 * roof photo + measured size + price range. Every text-to-spouse becomes a
 * branded mini-listing. count=false keeps scrapers out of the open counter.
 */
export default async function OgImage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params

  let r: any = null
  try {
    const res = await fetch(`${API_BASE}/api/v1/instant-quote/report/${token}?count=false`)
    if (res.ok) r = await res.json()
  } catch { /* fall back to the generic card */ }

  const money = (v: number) => `$${Math.round(v).toLocaleString()}`
  const price = r?.price_low && r?.price_high ? `${money(r.price_low)} – ${money(r.price_high)}` : null
  const sqft = r?.roof_sqft ? `${Math.round(r.roof_sqft).toLocaleString()} ft² measured from satellite` : null
  const imagery = r?.imagery_url ? `${API_BASE}${r.imagery_url}` : null

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%', height: '100%', display: 'flex',
          background: 'linear-gradient(135deg, #040810 0%, #0c1c3d 100%)',
          color: 'white', fontFamily: 'sans-serif',
        }}
      >
        {imagery && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imagery}
            alt=""
            width={560}
            height={630}
            style={{ width: 560, height: 630, objectFit: 'cover' }}
          />
        )}
        <div
          style={{
            flex: 1, display: 'flex', flexDirection: 'column',
            justifyContent: 'center', padding: 56, gap: 18,
          }}
        >
          <div style={{ display: 'flex', fontSize: 22, letterSpacing: 6, color: '#93c5fd', textTransform: 'uppercase' }}>
            Roof Intelligence Report
          </div>
          <div style={{ display: 'flex', fontSize: 44, fontWeight: 700, lineHeight: 1.15 }}>
            {r?.address || 'Instant satellite roof estimate'}
          </div>
          {price && (
            <div style={{ display: 'flex', fontSize: 52, fontWeight: 800, color: '#6ee7b7' }}>
              {price}
            </div>
          )}
          {sqft && (
            <div style={{ display: 'flex', fontSize: 26, color: 'rgba(255,255,255,0.75)' }}>
              {sqft}
            </div>
          )}
          <div style={{ display: 'flex', fontSize: 24, color: 'rgba(255,255,255,0.55)', marginTop: 14 }}>
            Prepared by {r?.company_name || 'your local roofing pro'} · Powered by Axis
          </div>
        </div>
      </div>
    ),
    size,
  )
}
