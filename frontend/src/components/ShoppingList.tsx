'use client'

/**
 * Shopping list for a checked material list.
 *
 * The compliance check answers "is this list allowed?". The next question is
 * always "where do I buy it and what does it cost" — and the vendor pricing to
 * answer that already existed for project materials while an uploaded list had
 * no route to it. This is that route.
 *
 * Prices are never invented. A line with no verifiable product page shows as
 * unpriced rather than estimated: a made-up number on a material order costs
 * real money.
 */
import { useState } from 'react'
import toast from 'react-hot-toast'
import { api } from '@/lib/api'
import type { ShoppingList as ShoppingListData } from '@/lib/api'

interface ParsedMaterial { item_name: string; quantity?: number | null; unit?: string | null }

export default function ShoppingList({ materials, city }: {
  materials: ParsedMaterial[]
  city?: string
}) {
  const [data, setData] = useState<ShoppingListData | null>(null)
  const [loading, setLoading] = useState(false)

  async function build() {
    setLoading(true)
    try {
      setData(await api.materialCheck.shoppingList(
        materials.map(m => ({ item_name: m.item_name, quantity: m.quantity ?? null, unit: m.unit ?? 'each' })),
        city,
      ))
    } catch (e) {
      toast.error(e instanceof Error ? e.message.replace(/\[HTTP \d+\]\s*/, '').slice(0, 160) : 'Could not price the list')
    } finally {
      setLoading(false)
    }
  }

  const money = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

  if (!data) {
    return (
      <div className="rounded-xl border border-[#dededc] bg-[#f8f8f7] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-[#1a1a1a]">Build a shopping list</div>
            <div className="text-[12px] text-[#6b7280]">
              Find real product pages and current prices for these {materials.length} items.
            </div>
          </div>
          <button onClick={() => void build()} disabled={loading || materials.length === 0}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-50">
            {loading ? 'Pricing…' : 'Price this list'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-[#dededc] bg-[#f8f8f7]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#dededc] px-4 py-3">
        <div>
          <div className="text-sm font-semibold text-[#1a1a1a]">Shopping list</div>
          <div className="text-[12px] text-[#6b7280]">
            {data.priced_count} of {data.items.length} priced
            {data.unpriced_count > 0 && ` · ${data.unpriced_count} need a manual look`}
          </div>
        </div>
        <div className="text-right">
          <div className="text-lg font-bold text-[#1a1a1a]">{money(data.subtotal)}</div>
          <div className="max-w-[240px] text-[11px] text-[#6b7280]">{data.subtotal_note}</div>
        </div>
      </div>

      {!data.tavily_configured && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-[12px] text-amber-900">
          Live retail search is off (no search key configured), so only trade distributors are listed —
          they quote rather than publish prices.
        </div>
      )}

      <div className="divide-y divide-[#dededc]">
        {data.items.map((row, i) => (
          <div key={i} className="px-4 py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-[#1a1a1a]">{row.item_name}</div>
                <div className="text-[11px] text-[#6b7280]">
                  {row.quantity ? `${row.quantity} ${row.unit}` : 'No quantity on the list'}
                  {row.best?.price != null && ` · best ${money(row.best.price)} at ${row.best.vendor}`}
                </div>
              </div>
              <div className="text-sm font-semibold text-[#1a1a1a]">
                {row.line_total != null ? money(row.line_total)
                  : <span className="text-[12px] font-normal text-[#6b7280]">
                      {row.priced ? 'add a qty for a total' : 'no verified price'}
                    </span>}
              </div>
            </div>

            {row.options.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {row.options.map((o, j) => (
                  <a key={j} href={o.url} target="_blank" rel="noopener noreferrer"
                    className="rounded-md border border-[#dededc] bg-white px-2 py-1 text-[11px] font-medium text-[#1a1a1a] hover:bg-[#eeeeed]">
                    {o.vendor}
                    {o.price != null
                      ? <span className="ml-1.5 font-bold">{money(o.price)}</span>
                      : <span className="ml-1.5 text-[#6b7280]">quote</span>}
                  </a>
                ))}
              </div>
            )}
            {row.options.length === 0 && (
              <div className="mt-1.5 text-[11px] text-[#6b7280]">
                No product page found for this line — search your supplier directly.
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="border-t border-[#dededc] px-4 py-2.5 text-[11px] text-[#6b7280]">
        Retail prices come from live product pages and move. Trade distributors (ABC, Beacon, SRS)
        quote rather than publish, so they show without a number — they are usually the cheaper buy.
      </div>
    </div>
  )
}
