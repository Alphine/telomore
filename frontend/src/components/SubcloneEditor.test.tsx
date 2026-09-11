import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'

import type { ModelConfig } from '../api/types'
import { SubcloneEditor } from './SubcloneEditor'
import { BOUNDS } from '../test/fixtures'

function Harness({ onState }: { onState: (c: ModelConfig) => void }) {
  const [cfg, setCfg] = useState<ModelConfig>({ ...BOUNDS.demo })
  return (
    <SubcloneEditor
      bounds={BOUNDS}
      value={cfg}
      onChange={(next) => {
        setCfg(next)
        onState(next)
      }}
    />
  )
}

describe('SubcloneEditor', () => {
  it('is off by default and enabling it seeds a valid 50/50 pair', () => {
    const states: ModelConfig[] = []
    render(<Harness onState={(c) => states.push(c)} />)
    expect(screen.queryByTestId('clone-row-0')).not.toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Enable sub-clone competition'))
    expect(states.at(-1)!.subclones).toEqual([
      { name: 'clone A', initial_fraction: 0.5, overrides: {} },
      { name: 'clone B', initial_fraction: 0.5, overrides: {} },
    ])
    expect(screen.getByText(/Total initial fraction: 1\.000/)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('adding a row rebalances all fractions evenly', () => {
    const states: ModelConfig[] = []
    render(<Harness onState={(c) => states.push(c)} />)
    fireEvent.click(screen.getByLabelText('Enable sub-clone competition'))

    fireEvent.click(screen.getByRole('button', { name: '+ Add clone' }))
    expect(states.at(-1)!.subclones).toHaveLength(3)
    expect(screen.getByText(/Total initial fraction: 1\.000/)).toBeInTheDocument()
  })

  it('warns via an alert when fractions do not sum to 1.0', () => {
    render(<Harness onState={() => {}} />)
    fireEvent.click(screen.getByLabelText('Enable sub-clone competition'))
    const fractionInputs = screen.getAllByLabelText('Initial fraction')
    fireEvent.change(fractionInputs[0], { target: { value: '0.9' } })
    expect(screen.getByRole('alert')).toHaveTextContent('must sum to 1.0')
  })

  it('removing a clone drops the row and disables removal below two clones', () => {
    render(<Harness onState={() => {}} />)
    fireEvent.click(screen.getByLabelText('Enable sub-clone competition'))
    expect(screen.getAllByTestId(/clone-row-/)).toHaveLength(2)
    const removeButtons = screen.getAllByText('✕ Remove')
    expect(removeButtons[0]).toBeDisabled() // only 2 clones: cannot go below 2
  })

  it('toggling an override shows a bounded number field seeded from the config scalar', () => {
    render(<Harness onState={() => {}} />)
    fireEvent.click(screen.getByLabelText('Enable sub-clone competition'))
    const overrideToggle = screen.getAllByLabelText(/Override repair_rate for/)[0]
    fireEvent.click(overrideToggle)
    const field = screen.getAllByLabelText(/repair_rate value for/)[0] as HTMLInputElement
    expect(Number(field.value)).toBe(BOUNDS.demo.repair_rate)
  })
})
