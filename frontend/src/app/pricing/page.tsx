import type { Metadata } from 'next'

import PricingTables from './PricingTables'

export const metadata: Metadata = {
  title: 'Pricing — Axis Roofing Performance',
  description:
    'Three plans. Every tool included on all of them — you only choose how many roof reports and crews you need. Month to month, cancel anytime.',
}

export default function PricingPage() {
  return <PricingTables />
}
