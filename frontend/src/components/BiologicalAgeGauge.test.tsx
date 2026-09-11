import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { BiologicalAgeScore } from '../api/types'
import { BiologicalAgeGauge } from './BiologicalAgeGauge'
import { BIOLOGICAL_AGE_DISCLAIMER } from './biologicalAgeUtils'

function score(overrides: Partial<BiologicalAgeScore> = {}): BiologicalAgeScore {
  return {
    score_over_time: [10, 20, 30],
    final_score: 30,
    scale_label: 'synthetic age index, 0 (youthful reference) - 100 (senescent reference)',
    formula_note: 'age_index = 100 * (1 - mean(...))',
    valid: true,
    ...overrides,
  }
}

describe('BiologicalAgeGauge', () => {
  it('renders the final score and the mandatory disclaimer together', () => {
    render(<BiologicalAgeGauge score={score({ final_score: 42.3 })} />)
    expect(screen.getByTestId('biological-age-value')).toHaveTextContent('42.3')
    expect(screen.getByTestId('biological-age-disclaimer')).toHaveTextContent(BIOLOGICAL_AGE_DISCLAIMER)
  })

  it('shows a fully-senescent-end score (100) without crashing', () => {
    render(<BiologicalAgeGauge score={score({ final_score: 100 })} />)
    expect(screen.getByTestId('biological-age-value')).toHaveTextContent('100.0')
    expect(screen.getByTestId('biological-age-disclaimer')).toBeInTheDocument()
  })

  it('never crashes and still shows the disclaimer when the score is null/absent', () => {
    render(<BiologicalAgeGauge score={null} />)
    expect(screen.getByTestId('biological-age-disclaimer')).toHaveTextContent(BIOLOGICAL_AGE_DISCLAIMER)
    expect(screen.queryByTestId('biological-age-value')).not.toBeInTheDocument()
  })

  it('never crashes and still shows the disclaimer when the score is explicitly invalid', () => {
    render(<BiologicalAgeGauge score={score({ valid: false, final_score: null, score_over_time: [] })} />)
    expect(screen.getByTestId('biological-age-disclaimer')).toHaveTextContent(BIOLOGICAL_AGE_DISCLAIMER)
    expect(screen.queryByTestId('biological-age-value')).not.toBeInTheDocument()
  })

  it('clamps an out-of-range score defensively rather than rendering garbage', () => {
    render(<BiologicalAgeGauge score={score({ final_score: 150 })} />)
    expect(screen.getByTestId('biological-age-value')).toHaveTextContent('100.0')
  })
})
