import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

// react-markdown renders to React elements (no innerHTML) and drops raw HTML
// by default, so model output is displayed without any sanitisation step of
// our own. Imported lazily by InterpretPanel so the parser only downloads
// when a narrative is actually shown.
// remarkGfm enables GFM tables (among other GFM extensions) -- without it,
// pipe-table syntax in docs/MODEL.md and LLM-narrated output rendered as raw
// "| a | b |" text instead of an actual table.
export default function MarkdownView({ source }: { source: string }) {
  return (
    <div className="prose-narrative" data-testid="markdown-view">
      <Markdown remarkPlugins={[remarkGfm]}>{source}</Markdown>
    </div>
  )
}
