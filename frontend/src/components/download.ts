// Client-side file exports (the Streamlit pages used st.download_button with
// telomere_lab.experiments.artifacts.simulation_json / simulation_csv /
// evolution_json; here the result JSON is what the API already returned).
import type { GenerationRecord, SimulationTimeseries } from '../api/types'

export function downloadText(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function downloadJson(filename: string, value: unknown): void {
  downloadText(filename, JSON.stringify(value, null, 2), 'application/json')
}

type Cell = number | string | boolean | null | undefined

function cell(v: Cell): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
  return String(v)
}

/** Columns -> CSV (header row + one row per index), like DataFrame.to_csv(index=False). */
export function csvFromColumns(columns: Record<string, Cell[]>): string {
  const names = Object.keys(columns)
  const rows = Math.max(0, ...names.map((n) => columns[n].length))
  const lines = [names.join(',')]
  for (let i = 0; i < rows; i++) lines.push(names.map((n) => cell(columns[n][i])).join(','))
  return lines.join('\n') + '\n'
}

/** Same columns/order as SimulationResult.timeseries_frame(). */
export function timeseriesCsv(ts: SimulationTimeseries): string {
  return csvFromColumns(ts as unknown as Record<string, Cell[]>)
}

/** Same columns/order as EvolutionResult.history_frame(). */
export function historyCsv(history: GenerationRecord[]): string {
  const genes = Array.from(new Set(history.flatMap((h) => Object.keys(h.best_genome))))
  const columns: Record<string, Cell[]> = {
    generation: history.map((h) => h.generation),
    best_fitness: history.map((h) => h.best_fitness),
    mean_fitness: history.map((h) => h.mean_fitness),
    median_fitness: history.map((h) => h.median_fitness),
    diversity: history.map((h) => h.diversity),
    n_invalid: history.map((h) => h.n_invalid),
    evaluations: history.map((h) => h.evaluations_so_far),
    elapsed_seconds: history.map((h) => h.elapsed_seconds),
  }
  for (const g of genes) columns[`best_${g}`] = history.map((h) => h.best_genome[g])
  return csvFromColumns(columns)
}
