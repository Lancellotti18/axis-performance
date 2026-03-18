import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'BuildAI — AI-Powered Blueprint Analysis',
  description: 'Upload blueprints, get instant material lists, cost estimates, and detailed construction reports powered by AI.',
  keywords: ['blueprint analysis', 'construction estimating', 'AI', 'material takeoff'],
  authors: [{ name: 'BuildAI' }],
  openGraph: {
    title: 'BuildAI — AI-Powered Blueprint Analysis',
    description: 'Analyze blueprints in minutes. Get material lists, cost estimates, and reports.',
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
