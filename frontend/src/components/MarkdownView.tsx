import Markdown from 'react-markdown'

// react-markdown renders to React elements (no innerHTML) and drops raw HTML
// by default, so model output is displayed without any sanitisation step of
// our own. Imported lazily by InterpretPanel so the parser only downloads
// when a narrative is actually shown.
export default function MarkdownView({ source }: { source: string }) {
  return (
    <div className="prose-narrative" data-testid="markdown-view">
      <Markdown>{source}</Markdown>
    </div>
  )
}
