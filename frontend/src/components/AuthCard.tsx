import type { ReactNode } from 'react'

/** Narrow centred card shared by the auth pages. */
export function AuthCard({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string
  subtitle?: ReactNode
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <div className="mx-auto max-w-md">
      <div className="card p-6 sm:p-8">
        <h1 className="text-2xl font-bold">{title}</h1>
        {subtitle && <p className="prose-muted mt-1.5">{subtitle}</p>}
        <div className="mt-6 space-y-4">{children}</div>
      </div>
      {footer && <div className="prose-muted mt-4 text-center">{footer}</div>}
    </div>
  )
}
