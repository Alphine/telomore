import { Link } from 'react-router-dom'

export function NotFound() {
  return (
    <div className="mx-auto max-w-md text-center">
      <h1 className="text-3xl font-bold">Page not found</h1>
      <p className="prose-muted mt-2">There is nothing at this address.</p>
      <Link className="btn-primary mt-6" to="/">
        Back to Home
      </Link>
    </div>
  )
}
