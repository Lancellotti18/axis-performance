import * as React from 'react'
import { cn } from '@/lib/cn'

const base =
  'w-full rounded-xl border bg-white text-ink placeholder:text-ink-faint transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-200 focus-visible:border-brand-400 disabled:opacity-60 disabled:cursor-not-allowed'

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean
  leadingIcon?: React.ReactNode
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, invalid, leadingIcon, ...props }, ref) => {
    const borderClass = invalid
      ? 'border-danger focus-visible:ring-red-200 focus-visible:border-danger'
      : 'border-slate-300'
    const padding = leadingIcon ? 'pl-10 pr-4 py-2.5' : 'px-4 py-2.5'
    const input = (
      <input
        ref={ref}
        className={cn(base, borderClass, padding, 'text-sm h-10', className)}
        {...props}
      />
    )
    if (!leadingIcon) return input
    return (
      <div className="relative">
        <div className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none flex items-center">
          {leadingIcon}
        </div>
        {input}
      </div>
    )
  },
)
Input.displayName = 'Input'

export interface LabelProps extends React.LabelHTMLAttributes<HTMLLabelElement> {}

export function Label({ className, ...props }: LabelProps) {
  return (
    <label
      className={cn('block text-sm font-medium text-ink mb-1.5', className)}
      {...props}
    />
  )
}

export interface FieldHintProps extends React.HTMLAttributes<HTMLParagraphElement> {
  tone?: 'muted' | 'error'
}

export function FieldHint({ className, tone = 'muted', ...props }: FieldHintProps) {
  const toneClass = tone === 'error' ? 'text-danger' : 'text-ink-muted'
  return <p className={cn('text-xs mt-1.5', toneClass, className)} {...props} />
}
