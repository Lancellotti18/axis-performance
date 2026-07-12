import type { Metadata } from 'next'

const API_BASE = (process.env.NEXT_PUBLIC_API_URL || 'https://build-backend-jcp9.onrender.com').trim()

/**
 * Server layout for the homeowner report: per-report page title + social
 * preview so a report texted to a spouse unfurls like a listing card
 * (address + price range), not a generic app link. Uses count=false so link
 * scrapers don't inflate the "re-opened their report" speed-to-lead signal.
 */
export async function generateMetadata(
  { params }: { params: Promise<{ token: string }> },
): Promise<Metadata> {
  const { token } = await params
  const fallback: Metadata = {
    title: 'Your Roof Intelligence Report',
    description: 'Satellite-measured roof size and instant price range — see the full report.',
  }
  try {
    const res = await fetch(`${API_BASE}/api/v1/instant-quote/report/${token}?count=false`, {
      next: { revalidate: 300 },
    })
    if (!res.ok) return fallback
    const r = await res.json()
    const title = r.address ? `Roof Report — ${r.address}` : 'Your Roof Intelligence Report'
    const price = r.price_low && r.price_high
      ? `$${Math.round(r.price_low).toLocaleString()}–$${Math.round(r.price_high).toLocaleString()} estimated`
      : 'Instant satellite roof estimate'
    const sqft = r.roof_sqft ? ` · ${Math.round(r.roof_sqft).toLocaleString()} ft² measured` : ''
    return {
      title,
      description: `${price}${sqft} · prepared by ${r.company_name || 'your roofing contractor'}.`,
      openGraph: {
        title,
        description: `${price}${sqft}`,
        type: 'website',
      },
    }
  } catch {
    return fallback
  }
}

export default function ReportLayout({ children }: { children: React.ReactNode }) {
  return children
}
