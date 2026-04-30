'use client'
import { HTMLAttributes, ReactNode } from 'react'

export interface DataPulseProps extends HTMLAttributes<HTMLSpanElement> {
  /** Show the live-pulse dot. Default true. */
  live?: boolean
  children?: ReactNode
}

export function DataPulse({ live = true, className = '', children, ...rest }: DataPulseProps) {
  return (
    <span className={`${live ? 'axis-pulse' : 'inline-flex items-center gap-1.5'} ${className}`} {...rest}>
      <span>{children}</span>
    </span>
  )
}
