import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'Axis Performance — AI Blueprint & Permit Platform',
  description: 'Upload blueprints, get instant room detection, material lists, cost estimates, compliance checks, and automated permit filing.',
  keywords: ['blueprint analysis', 'permit filing', 'construction estimating', 'AI', 'material takeoff'],
  authors: [{ name: 'Axis Performance' }],
  openGraph: {
    title: 'Axis Performance — AI Blueprint & Permit Platform',
    description: 'Analyze blueprints in minutes. File permits automatically.',
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
      <body className={inter.className}>{children}</body>
    </html>
  )
}
