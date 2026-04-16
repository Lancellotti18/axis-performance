import * as React from 'react'
import { cn } from '@/lib/cn'

type Variant = 'default' | 'glass' | 'outline' | 'brand'

const variants: Record<Variant, string> = {
  default:
    'bg-white border border-slate-200 shadow-card',
  glass:
    'border backdrop-blur-md',
  outline:
    'bg-transparent border border-slate-300',
  brand:
    'bg-brand-50 border border-brand-100',
}

const glassStyle: React.CSSProperties = {
  background: 'rgba(255, 255, 255, 0.78)',
  borderColor: 'rgba(219, 234, 254, 0.9)',
  WebkitBackdropFilter: 'blur(16px)',
  backdropFilter: 'blur(16px)',
}

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: Variant
  padding?: 'none' | 'sm' | 'md' | 'lg'
}

export const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, variant = 'default', padding = 'md', style, ...props }, ref) => {
    const padMap = {
      none: '',
      sm: 'p-4',
      md: 'p-6',
      lg: 'p-8',
    } as const
    return (
      <div
        ref={ref}
        className={cn('rounded-2xl', variants[variant], padMap[padding], className)}
        style={variant === 'glass' ? { ...glassStyle, ...style } : style}
        {...props}
      />
    )
  },
)
Card.displayName = 'Card'

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mb-4 flex items-center justify-between', className)} {...props} />
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn('text-base font-semibold text-ink-strong', className)} {...props} />
}

export function CardDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-sm text-ink-muted mt-1', className)} {...props} />
}
