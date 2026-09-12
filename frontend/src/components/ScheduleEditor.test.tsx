import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { ModelConfig } from '../api/types'
import { ScheduleEditor } from './ScheduleEditor'
import { BOUNDS } from '../test/fixtures'

function Harness({ onState, onLoadPreset }: { onState: (c: ModelConfig) => void; onLoadPreset?: (n: string, c: ModelConfig) => void }) {
  const [cfg, setCfg] = useState<ModelConfig>({ ...BOUNDS.demo, cycles: 10 })
  return (
    <ScheduleEditor
      bounds={BOUNDS}
      value={cfg}
      onChange={(next) => {
        setCfg(next)
        onState(next)
      }}
      onLoadPreset={onLoadPreset}
    />
  )
}

describe('ScheduleEditor', () => {
  it('builds the exact ModelConfig.to_dict() schedule payload and omits the key when reset to constant', () => {
    const states: ModelConfig[] = []
    render(<Harness onState={(c) => states.push(c)} />)
    for (const name of BOUNDS.schedulable) expect(screen.getByLabelText(`Vary ${name} over time`)).not.toBeChecked()
    expect(screen.queryByLabelText(/Phases \(1–8\)/)).not.toBeInTheDocument()

    // Toggle stress_level on: 2 phases seeded with the scalar (demo 0.60).
    fireEvent.click(screen.getByLabelText('Vary stress_level over time'))
    expect(states.at(-1)!.schedule).toEqual({ phases: 2, values: { stress_level: [0.6, 0.6] } })
    expect(screen.getByText(/10 cycles → phases of 5, 5 cycles/)).toBeInTheDocument()

    // 3 phases -> padded with the last value; cycle ranges follow the core formula (4, 3, 3).
    fireEvent.change(screen.getByLabelText(/Phases \(1–8\)/), { target: { value: '3' } })
    expect(states.at(-1)!.schedule).toEqual({ phases: 3, values: { stress_level: [0.6, 0.6, 0.6] } })
    expect(screen.getByText(/phases of 4, 3, 3 cycles/)).toBeInTheDocument()
    expect(screen.getByText('0: 0–3')).toBeInTheDocument()
    expect(screen.getByText('2: 7–9')).toBeInTheDocument()

    // Edit phase 1 -> payload updates; scalar stays the phase-0 value.
    fireEvent.change(screen.getByLabelText('stress_level phase 1'), { target: { value: '0.25' } })
    expect(states.at(-1)!.schedule).toEqual({ phases: 3, values: { stress_level: [0.6, 0.25, 0.6] } })
    fireEvent.change(screen.getByLabelText('stress_level phase 0'), { target: { value: '0.9' } })
    expect(states.at(-1)!.stress_level).toBe(0.9)
    expect(states.at(-1)!.schedule).toEqual({ phases: 3, values: { stress_level: [0.9, 0.25, 0.6] } })

    // A second parameter joins with the same phase count.
    fireEvent.click(screen.getByLabelText('Vary repair_rate over time'))
    expect(states.at(-1)!.schedule).toEqual({ phases: 3, values: { stress_level: [0.9, 0.25, 0.6], repair_rate: [0.15, 0.15, 0.15] } })

    // Reset to constant -> no `schedule` key at all (not null).
    fireEvent.click(screen.getByRole('button', { name: 'Reset to constant' }))
    expect('schedule' in states.at(-1)!).toBe(false)
    expect(states.at(-1)!.stress_level).toBe(0.9)
    expect(screen.queryByLabelText(/Phases \(1–8\)/)).not.toBeInTheDocument()
  })

  it('offers the presets from /api/meta/bounds and disables unavailable parameters', () => {
    const onLoad = vi.fn()
    render(<Harness onState={() => {}} onLoadPreset={onLoad} />)
    fireEvent.click(screen.getByRole('button', { name: 'Load fasting demo' }))
    expect(onLoad).toHaveBeenCalledWith('demo_fasting', BOUNDS.presets.demo_fasting)

    // docs/EXPERIMENT_PROTOCOL.md Experiment G: same stress rhythm, an
    // evolved maintenance/repair response instead of the fixed baseline.
    fireEvent.click(screen.getByRole('button', { name: 'Load evolved fasting response' }))
    expect(onLoad).toHaveBeenCalledWith('demo_fasting_evolved', BOUNDS.presets.demo_fasting_evolved)

    render(
      <ScheduleEditor
        bounds={BOUNDS}
        value={BOUNDS.demo}
        onChange={() => {}}
        unavailable={new Map([['stress_level', 'derived from chip']])}
        idPrefix="x"
      />,
    )
    const toggles = screen.getAllByLabelText('Vary stress_level over time')
    expect(toggles.at(-1)).toBeDisabled()
  })
})
