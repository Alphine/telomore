import * as RadixSwitch from '@radix-ui/react-switch'
import type { ComponentPropsWithoutRef } from 'react'

import { cn } from '../../lib/cn'

export function Switch({ className, ...props }: ComponentPropsWithoutRef<typeof RadixSwitch.Root>) {
  return (
    <RadixSwitch.Root
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-slate-300 transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-2 dark:bg-slate-700 dark:focus-visible:ring-offset-slate-950',
        'data-[state=checked]:bg-teal-600 disabled:cursor-not-allowed disabled:opacity-50 dark:data-[state=checked]:bg-teal-500',
        className,
      )}
      {...props}
    >
      <RadixSwitch.Thumb className="block h-4 w-4 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[18px]" />
    </RadixSwitch.Root>
  )
}
