// The only module that imports plotly.js (~4.5 MB minified). Loaded lazily
// by ./Plot.tsx so the landing/auth pages never pay for it.
import Plotly from 'plotly.js-dist-min'
import type { Data, Layout } from 'plotly.js-dist-min'
import createPlotlyComponent from 'react-plotly.js/factory'

const PlotComponent = createPlotlyComponent(Plotly)

export interface PlotlyPlotProps {
  data: Data[]
  layout: Partial<Layout>
  ariaLabel?: string
}

export default function PlotlyPlot({ data, layout, ariaLabel }: PlotlyPlotProps) {
  return (
    <div role="img" aria-label={ariaLabel ?? String(layout.title && typeof layout.title === 'object' ? layout.title.text : '')}>
      <PlotComponent
        data={data}
        layout={layout}
        config={{ displaylogo: false, responsive: true, modeBarButtonsToRemove: ['lasso2d', 'select2d'] }}
        useResizeHandler
        style={{ width: '100%', height: layout.height ?? 340 }}
      />
    </div>
  )
}
