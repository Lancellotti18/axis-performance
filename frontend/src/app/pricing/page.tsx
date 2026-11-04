import type { Metadata } from 'next'

import { redirect } from 'next/navigation'

import { SHOW_PRICING } from '@/lib/pricing-visibility'
import PricingTables from './PricingTables'

export const metadata: Metadata = {
  title: 'Pricing — Axis Roofing Performance',
  description:
    'Three plans. Every tool included on all of them — you only choose how many roof reports and crews you need. Month to month, cancel anytime.',
}

export default function PricingPage() {
  if (!SHOW_PRICING) redirect('/#trial')
  return <PricingTables />
}
