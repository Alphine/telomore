import type { HTMLAttributes } from 'react'

import { cn } from '../../lib/cn'

/** Loading placeholder; the pulse is disabled under prefers-reduced-motion by Tailwind's motion-safe variant. */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      className={cn('rounded-md bg-slate-200/80 motion-safe:animate-pulse dark:bg-slate-800', className)}
      {...props}
    />
  )
}
