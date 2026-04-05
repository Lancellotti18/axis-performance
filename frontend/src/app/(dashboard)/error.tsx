'use client'
import { useEffect } from 'react'

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[Dashboard error]', error)
  }, [error])

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-slate-50 px-6">
      <div className="bg-white rounded-2xl p-8 max-w-2xl w-full shadow-lg border border-red-100">
        <h2 className="text-lg font-bold text-red-600 mb-2">Page Error</h2>
        <p className="text-slate-500 text-sm mb-4">Copy the error below and send it to support.</p>
        <pre className="bg-slate-50 rounded-xl p-4 text-xs text-red-700 overflow-auto max-h-64 mb-5 border border-red-100 whitespace-pre-wrap break-all">
          {error?.message || 'Unknown error'}
          {'\n\n'}
          {error?.stack || ''}
        </pre>
        <button
          onClick={reset}
          className="bg-blue-600 hover:bg-blue-700 text-white font-semibold px-5 py-2.5 rounded-xl text-sm transition-all"
        >
          Try again
        </button>
      </div>
    </div>
  )
}
