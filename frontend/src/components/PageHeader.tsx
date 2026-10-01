import { ModePanel } from '../demo/ModePanel'
import { Disclaimer } from './Callout'
import type { Feature } from '../features'

/** Title row + FEATURES description + the scope disclaimer (page_setup + disclaimer in Streamlit). */
export function PageHeader({ feature }: { feature: Feature }) {
  return (
    <>
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
      <ModePanel />
    </>
  )
}
