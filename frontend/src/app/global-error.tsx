'use client'
import { useEffect } from 'react'

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[Global error]', error)
  }, [error])

  return (
    <html>
      <body>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: '#f8fafc', padding: '24px' }}>
          <div style={{ background: 'white', borderRadius: '16px', padding: '32px', maxWidth: '640px', width: '100%', boxShadow: '0 4px 24px rgba(0,0,0,0.08)', border: '1px solid #fecaca' }}>
            <h2 style={{ color: '#dc2626', fontWeight: 700, fontSize: '18px', marginBottom: '8px' }}>Application Error</h2>
            <p style={{ color: '#64748b', fontSize: '14px', marginBottom: '16px' }}>Copy the full error below and send it to support so this can be fixed.</p>
            <pre style={{ background: '#fef2f2', borderRadius: '12px', padding: '16px', fontSize: '12px', color: '#b91c1c', overflow: 'auto', maxHeight: '300px', marginBottom: '20px', border: '1px solid #fecaca', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {error?.message || 'Unknown error'}
              {'\n\n'}
              {error?.stack || ''}
            </pre>
            <button
              onClick={reset}
              style={{ background: '#2563eb', color: 'white', border: 'none', borderRadius: '12px', padding: '10px 20px', fontSize: '14px', fontWeight: 600, cursor: 'pointer' }}
            >
              Try again
            </button>
          </div>
        </div>
      </body>
    </html>
  )
}
