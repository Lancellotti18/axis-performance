import * as React from 'react'
import { cn } from '@/lib/cn'

export interface PageHeaderProps {
  title: string
  description?: string
  eyebrow?: string
  actions?: React.ReactNode
  className?: string
}

export function PageHeader({ title, description, eyebrow, actions, className }: PageHeaderProps) {
  return (
    <div className={cn('mb-8 flex items-start justify-between gap-6', className)}>
      <div className="min-w-0">
        {eyebrow && (
          <div className="text-xs font-semibold uppercase tracking-widest text-brand-600 mb-2">
            {eyebrow}
          </div>
        )}
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-ink-strong truncate">
          {title}
        </h1>
        {description && (
          <p className="text-sm text-ink-muted mt-1.5 max-w-2xl">{description}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2 flex-shrink-0">{actions}</div>}
    </div>
  )
}
