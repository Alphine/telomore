import { Callout, Disclaimer } from '../components/Callout'
import type { Feature } from '../features'

/** Protected placeholder for a page whose real content arrives in Phase 3/4. */
export function Placeholder({ feature }: { feature: Feature }) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">
          <span aria-hidden className="mr-2">
            {feature.icon}
          </span>
          {feature.title}
        </h1>
        <p className="prose-muted mt-2 max-w-2xl">{feature.description}</p>
      </div>
      <Disclaimer />
      <Callout tone="warning">This page is being migrated from Streamlit (Phase 3/4).</Callout>
    </div>
  )
}
