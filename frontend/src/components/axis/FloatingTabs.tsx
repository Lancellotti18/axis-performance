'use client'
import { ReactNode } from 'react'

export interface FloatingTab<T extends string = string> {
  id: T
  label: string
  icon?: ReactNode
}

export interface FloatingTabsProps<T extends string = string> {
  tabs: ReadonlyArray<FloatingTab<T>>
  active: T
  onChange: (id: T) => void
  className?: string
}

export function FloatingTabs<T extends string = string>({
  tabs,
  active,
  onChange,
  className = '',
}: FloatingTabsProps<T>) {
  return (
    <div className={`axis-tabs ${className}`}>
      {tabs.map(t => (
        <button
          key={t.id}
          type="button"
          data-active={active === t.id}
          className="axis-tab"
          onClick={() => onChange(t.id)}
        >
          {t.icon && <span className="inline-flex">{t.icon}</span>}
          <span>{t.label}</span>
        </button>
      ))}
    </div>
  )
}
