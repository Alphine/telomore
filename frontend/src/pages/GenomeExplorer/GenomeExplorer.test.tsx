import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { mockFetch, renderApp } from '../../test/helpers'
import { GenomeExplorer } from './index'

vi.mock('../../components/charts/Plot', () => ({
  Plot: ({ ariaLabel }: { ariaLabel?: string }) => <div data-testid="plot">{ariaLabel}</div>,
}))

const GENOME = {
  toy: true,
  genes: [
    { name: 'TOY-CHK', role: 'checkpoint', dna: 'ATGGCCTAA', mrna: 'AUGGCCUAA', protein: 'MA', profile: { missense: 0.6, synonymous: 0.4 } },
  ],
}
const series = { generation: [0, 1], alive_fraction: [1, 1], mean_burden: [0, 1], extinct: false }
const LINEAGE = {
  toy: true,
  normal: { ...series, 'TOY-CHK_functional': [1, 1], 'TOY-REP_functional': [1, 1] },
  damaged: { ...series, 'TOY-CHK_functional': [0, 0], 'TOY-REP_functional': [0, 0] },
  model_bridge: { normal: { checkpoint_strength: 0.5, replication_error_rate: 0.001 }, damaged: { checkpoint_strength: 0, replication_error_rate: 0.003 } },
}

afterEach(() => vi.unstubAllGlobals())

describe('GenomeExplorer', () => {
  it('renders the toy genome, classifies a clicked mutation and runs lineages', async () => {
    mockFetch({
      'GET /api/sequence/genome': { status: 200, body: GENOME },
      'POST /api/sequence/mutate': {
        status: 200,
        body: {
          toy: true, gene: 'TOY-CHK', position: 5, ref: 'C', alt: 'T', codon_index: 1, ref_codon: 'GCC', alt_codon: 'GCT',
          ref_aa: 'A', alt_aa: 'A', effect: 'synonymous', mutated_dna: 'ATGGCTTAA', mutated_mrna: 'AUGGCUUAA', mutated_protein: 'MA',
        },
      },
      'POST /api/sequence/lineage': { status: 200, body: LINEAGE },
    })
    renderApp(<GenomeExplorer />)

    await screen.findByTestId('codon-grid')
    expect(screen.getAllByText(/synthetic/i).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByLabelText('base 5 C'))
    fireEvent.click(screen.getByRole('button', { name: 'T' }))
    expect((await screen.findByTestId('mutation-result')).textContent).toMatch(/synonymous/)

    fireEvent.click(screen.getByRole('button', { name: /Run lineages/ }))
    await waitFor(() => expect(screen.getAllByTestId('plot')).toHaveLength(4))
    expect(screen.getByText(/checkpoint_strength/)).toBeTruthy()
  })
})
