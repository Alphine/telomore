import { Suspense, lazy } from 'react'
import type { Data, Layout } from 'plotly.js-dist-min'

// Code-split: plotly.js only downloads when a chart is actually rendered.
const LazyPlotlyPlot = lazy(() => import('./PlotlyPlot'))

export interface Figure {
  data: Data[]
  layout: Partial<Layout>
}

export function Plot({ figure, ariaLabel }: { figure: Figure; ariaLabel?: string }) {
  const height = figure.layout.height ?? 340
  return (
    <div className="card overflow-hidden p-2">
      <Suspense
        fallback={
          <div
            className="animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800"
            style={{ height }}
            aria-label="Loading chart"
          />
        }
      >
        <LazyPlotlyPlot data={figure.data} layout={figure.layout} ariaLabel={ariaLabel} />
      </Suspense>
    </div>
  )
}
