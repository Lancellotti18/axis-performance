'use client'

/**
 * #4 — stage this project onto the crew dispatch board. Creates a linked job
 * (customer/property/squares reused) that lands in the dispatch tray ready to
 * assign to a crew. Idempotent: once added, links straight to the board.
 */
import { useState } from 'react'
import Link from 'next/link'
import toast from 'react-hot-toast'
import { api } from '@/lib/api'

export default function AddToDispatchButton({ projectId }: { projectId: string }) {
  const [busy, setBusy] = useState(false)
  const [added, setAdded] = useState(false)

  const add = async () => {
    setBusy(true)
    try {
      const r = await api.dispatch.addProject(projectId)
      setAdded(true)
      toast.success(r.message || 'Added to the dispatch board')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not add to dispatch')
    } finally { setBusy(false) }
  }

  if (added) {
    return (
      <Link href="/dispatch"
        className="flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition-all hover:bg-emerald-700">
        ✓ On dispatch — open board ↗
      </Link>
    )
  }
  return (
    <button onClick={add} disabled={busy}
      className="flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-all hover:bg-blue-700 disabled:opacity-50">
      {busy ? 'Adding…' : '🗓 Add to dispatch'}
    </button>
  )
}
