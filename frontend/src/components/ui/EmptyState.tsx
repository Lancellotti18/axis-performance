import * as React from 'react'
import { cn } from '@/lib/cn'

export interface EmptyStateProps {
  icon?: React.ReactNode
  title: string
  description?: string
  action?: React.ReactNode
  className?: string
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center rounded-2xl border border-dashed border-slate-300 bg-white/60 px-6 py-16',
        className,
      )}
    >
      {icon && (
        <div className="mb-4 w-12 h-12 rounded-xl bg-brand-50 text-brand-600 flex items-center justify-center">
          {icon}
        </div>
      )}
      <h3 className="text-base font-semibold text-ink-strong">{title}</h3>
      {description && <p className="text-sm text-ink-muted mt-1.5 max-w-md">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}
