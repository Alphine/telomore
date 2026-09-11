import { describe, expect, it } from 'vitest'

import { extractHeadings } from './toc'

describe('extractHeadings', () => {
  it('collects only # and ## headings, in document order, with slugified ids', () => {
    const md = [
      '# Title One',
      '',
      'Some body text with a `# not-a-heading` inside a code span.',
      '',
      '## Sub Section',
      '### Ignored (level 3)',
      '## Another: Sub/Section!',
      '```bash',
      '# a shell comment inside a fenced code block -- must NOT be treated as a heading',
      '```',
    ].join('\n')

    const entries = extractHeadings(md)
    expect(entries.map((e) => e.text)).toEqual(['Title One', 'Sub Section', 'Another: Sub/Section!'])
    expect(entries.map((e) => e.level)).toEqual([1, 2, 2])
    expect(entries[0].slug).toBe('title-one')
    expect(entries[1].slug).toBe('sub-section')
    expect(entries[2].slug).toBe('another-subsection')
  })

  it('de-duplicates repeated heading text with -1, -2, ... suffixes', () => {
    const entries = extractHeadings(['# Output', '## Output', '## Output'].join('\n'))
    expect(entries.map((e) => e.slug)).toEqual(['output', 'output-1', 'output-2'])
  })

  it('returns an empty list for a document with no headings', () => {
    expect(extractHeadings('just some\nplain text\nno headers here')).toEqual([])
  })

  it('extracts a non-trivial, matching heading count from the real docs/MODEL.md content', async () => {
    // Coupled to the real imported file on purpose (see frontend/README.md
    // "Docs page" for the rationale): rather than hardcoding an expected
    // heading count that would need updating on every doc edit, this
    // recomputes the expected count independently (a plain line-based
    // regex count) from the same source string, so the test only fails if
    // extractHeadings itself disagrees with that independent count -- not
    // whenever MODEL.md gains or loses a section.
    const modelSource = (await import('../../../../docs/MODEL.md?raw')).default
    const expectedCount = modelSource.split('\n').filter((line) => /^#{1,2}\s+\S/.test(line)).length
    const entries = extractHeadings(modelSource)
    expect(entries.length).toBe(expectedCount)
    expect(entries.length).toBeGreaterThan(5) // MODEL.md is long -- this must not be a near-empty TOC
    expect(new Set(entries.map((e) => e.slug)).size).toBe(entries.length) // every slug unique
  })
})
