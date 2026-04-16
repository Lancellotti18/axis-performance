'use client'
import * as React from 'react'
import { cn } from '@/lib/cn'

interface TabsContextValue {
  value: string
  onChange: (v: string) => void
}

const TabsContext = React.createContext<TabsContextValue | null>(null)

function useTabsContext() {
  const ctx = React.useContext(TabsContext)
  if (!ctx) throw new Error('Tabs components must be used inside <Tabs>')
  return ctx
}

export interface TabsProps {
  value: string
  onValueChange: (v: string) => void
  children: React.ReactNode
  className?: string
}

export function Tabs({ value, onValueChange, children, className }: TabsProps) {
  return (
    <TabsContext.Provider value={{ value, onChange: onValueChange }}>
      <div className={cn('flex flex-col gap-4', className)}>{children}</div>
    </TabsContext.Provider>
  )
}

export function TabsList({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div
      role="tablist"
      className={cn(
        'inline-flex items-center gap-1 rounded-xl bg-slate-100 p-1 text-sm',
        className,
      )}
    >
      {children}
    </div>
  )
}

export interface TabsTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  value: string
}

export function TabsTrigger({ value, className, children, ...props }: TabsTriggerProps) {
  const ctx = useTabsContext()
  const active = ctx.value === value
  return (
    <button
      role="tab"
      type="button"
      aria-selected={active}
      onClick={() => ctx.onChange(value)}
      className={cn(
        'px-3.5 py-1.5 rounded-lg font-medium transition-all',
        active
          ? 'bg-white text-ink-strong shadow-card'
          : 'text-ink-muted hover:text-ink',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  )
}

export function TabsContent({
  value,
  children,
  className,
}: {
  value: string
  children: React.ReactNode
  className?: string
}) {
  const ctx = useTabsContext()
  if (ctx.value !== value) return null
  return <div className={className}>{children}</div>
}
