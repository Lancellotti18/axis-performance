'use client'
import { ButtonHTMLAttributes, forwardRef, ReactNode } from 'react'

type Variant = 'primary' | 'secondary' | 'dark' | 'ghost'
type Size = 'sm' | 'md' | 'lg'

export interface AxisButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  leadingIcon?: ReactNode
  trailingIcon?: ReactNode
  loading?: boolean
  glow?: boolean
}

const variantClass: Record<Variant, string> = {
  primary:   'axis-btn--primary',
  secondary: '',
  dark:      'axis-btn--dark',
  ghost:     'axis-btn--ghost',
}

const sizeClass: Record<Size, string> = {
  sm: 'axis-btn--sm',
  md: '',
  lg: 'axis-btn--lg',
}

export const AxisButton = forwardRef<HTMLButtonElement, AxisButtonProps>(function AxisButton(
  {
    variant = 'secondary',
    size = 'md',
    leadingIcon,
    trailingIcon,
    loading,
    glow,
    disabled,
    className = '',
    children,
    ...rest
  },
  ref,
) {
  const cls = [
    'axis-btn',
    variantClass[variant],
    sizeClass[size],
    glow ? 'axis-anim-pulse' : '',
    'axis-sweep',
    className,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button ref={ref} className={cls} disabled={disabled || loading} {...rest}>
      {loading ? (
        <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
        </svg>
      ) : (
        leadingIcon && <span className="inline-flex">{leadingIcon}</span>
      )}
      <span>{children}</span>
      {!loading && trailingIcon && <span className="inline-flex">{trailingIcon}</span>}
    </button>
  )
})
