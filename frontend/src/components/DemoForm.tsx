import type { FormEvent, FormHTMLAttributes } from 'react'

import { useIsDemo } from '../demo/context'
import { LockedFormNote } from '../demo/ModePanel'

/**
 * Drop-in `<form>`. In live mode it is exactly a `<form>`. In demo mode every
 * control inside is natively disabled (via a `<fieldset disabled>`), submitting
 * is a no-op, and a note explains why and offers the access request. The
 * `className` goes on the fieldset so layout utilities (`space-y-*`, grids)
 * keep applying to the same children.
 */
export function DemoForm({ className, onSubmit, children, ...rest }: FormHTMLAttributes<HTMLFormElement>) {
  const demo = useIsDemo()
  if (!demo) {
    return (
      <form className={className} onSubmit={onSubmit} {...rest}>
        {children}
      </form>
    )
  }
  return (
    <form
      {...rest}
      onSubmit={(e: FormEvent<HTMLFormElement>) => e.preventDefault()}
      data-demo-locked="true"
    >
      <fieldset disabled className={['m-0 min-w-0 border-0 p-0', className].filter(Boolean).join(' ')}>
        <LockedFormNote />
        {children}
      </fieldset>
    </form>
  )
}
