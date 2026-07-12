import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import { Toaster } from 'react-hot-toast'
import './globals.css'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: {
    default: 'Axis Performance — Instant Roof Quotes & Roofing CRM',
    template: '%s · Axis Performance',
  },
  description:
    'Turn your website into your best salesperson: instant satellite-verified roof quotes that become scored, exclusive leads in your CRM. Flat pricing, unlimited seats.',
  keywords: ['roofing CRM', 'instant roof quote', 'roof measurement software', 'Roofr alternative', 'roofing leads', 'satellite roof measurement'],
  authors: [{ name: 'Axis Performance' }],
  openGraph: {
    title: 'Axis Performance — Instant Roof Quotes & Roofing CRM',
    description: 'Instant satellite roof quotes → scored, exclusive leads → your CRM. Stop buying leads. Start owning them.',
    type: 'website',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className={inter.className}>
        {children}
        <Toaster
          position="top-right"
          toastOptions={{
            duration: 4000,
            style: {
              borderRadius: '12px',
              background: '#0f172a',
              color: '#f8fafc',
              fontSize: '14px',
            },
            success: { iconTheme: { primary: '#10b981', secondary: '#0f172a' } },
            error: { iconTheme: { primary: '#ef4444', secondary: '#0f172a' } },
          }}
        />
      </body>
    </html>
  )
}
