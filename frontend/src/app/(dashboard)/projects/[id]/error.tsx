'use client'
import { useEffect } from 'react'

export default function ProjectError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[ProjectPage error]', error)
  }, [error])

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] px-6">
      <div className="bg-white rounded-2xl p-8 max-w-xl w-full shadow-lg border border-red-100">
        <h2 className="text-lg font-bold text-red-600 mb-2">Something went wrong</h2>
        <p className="text-slate-600 text-sm mb-4">
          The project page encountered an error. The details below will help fix it.
        </p>
        <pre className="bg-slate-50 rounded-xl p-4 text-xs text-red-700 overflow-auto max-h-48 mb-5 border border-red-100">
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
