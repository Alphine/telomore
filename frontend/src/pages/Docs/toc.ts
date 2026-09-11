// Pure helper for the Docs page's in-page table of contents. Split out of
// the component file for the same `react/only-export-components` reason as
// `scheduleUtils.ts` / `subclonesUtils.ts` / `ledger.ts`.

export interface TocEntry {
  level: 1 | 2
  text: string
  slug: string
}

/**
 * Extracts `#`/`##` ATX headings from a raw markdown source, in document
 * order, each with a slugified anchor id. Only levels 1-2 are collected --
 * MODEL.md's `###` sub-sections would make the list unwieldy as a jump list,
 * and the two top levels are enough to navigate a long document.
 *
 * Slugs are lowercase, non-alphanumeric runs collapsed to a single `-`, and
 * de-duplicated (`foo`, `foo-1`, `foo-2`, ...) so repeated heading text
 * (e.g. two "Output." headings) still gets distinct anchors.
 */
export function extractHeadings(markdown: string): TocEntry[] {
  const seen = new Map<string, number>()
  const entries: TocEntry[] = []
  let inFence = false
  for (const line of markdown.split('\n')) {
    // Skip ``` / ~~~ fenced code blocks -- a shell comment like `# 1. Foo`
    // inside a fence (README.md's Quick start has several) is not a heading.
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const match = /^(#{1,2})\s+(.+?)\s*$/.exec(line)
    if (!match) continue
    const level = match[1].length as 1 | 2
    const text = match[2].replace(/[`*_]/g, '').trim()
    if (!text) continue
    const base = slugify(text)
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    const slug = count === 0 ? base : `${base}-${count}`
    entries.push({ level, text, slug })
  }
  return entries
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
}
