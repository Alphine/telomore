import * as RadixDialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import type { ComponentPropsWithoutRef, ReactNode } from 'react'

import { cn } from '../../lib/cn'

export const Dialog = RadixDialog.Root
export const DialogTrigger = RadixDialog.Trigger
export const DialogClose = RadixDialog.Close

interface DialogContentProps extends Omit<ComponentPropsWithoutRef<typeof RadixDialog.Content>, 'title'> {
  title: string
  description?: string
  /** `drawer` slides in from the right (row details); `modal` is centred. */
  variant?: 'modal' | 'drawer'
  footer?: ReactNode
}

export function DialogContent({
  title,
  description,
  variant = 'modal',
  footer,
  className,
  children,
  ...props
}: DialogContentProps) {
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className="fixed inset-0 z-40 bg-slate-950/50 backdrop-blur-[2px] data-[state=open]:animate-[fade-in_150ms_ease-out]" />
      <RadixDialog.Content
        className={cn(
          'fixed z-50 flex max-h-[90vh] flex-col border border-slate-200 bg-white shadow-xl focus:outline-none dark:border-slate-800 dark:bg-slate-900',
          variant === 'modal'
            ? 'left-1/2 top-1/2 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl'
            : 'right-0 top-0 h-full max-h-none w-full max-w-lg rounded-l-2xl',
          className,
        )}
        {...props}
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4 dark:border-slate-800">
          <div className="min-w-0">
            <RadixDialog.Title className="font-heading text-base font-semibold">{title}</RadixDialog.Title>
            <RadixDialog.Description className={description ? 'mt-1 text-sm text-slate-600 dark:text-slate-400' : 'sr-only'}>
              {description ?? title}
            </RadixDialog.Description>
          </div>
          <RadixDialog.Close
            aria-label="Close"
            className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 dark:hover:bg-slate-800"
          >
            <X className="h-4 w-4" aria-hidden />
          </RadixDialog.Close>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 px-5 py-3 dark:border-slate-800">
            {footer}
          </div>
        )}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  )
}
