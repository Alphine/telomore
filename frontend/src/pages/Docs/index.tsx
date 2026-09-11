// Public, unauthenticated "Docs" page -- an in-app README-style explanation
// of the program plus the full content of docs/MODEL.md and
// docs/SCIENTIFIC_SCOPE.md, so a prospective user can read what this lab
// actually is and how it works before registering, without leaving the app.
//
// The three source files live outside `frontend/` (repo root README.md,
// docs/MODEL.md, docs/SCIENTIFIC_SCOPE.md). Vite's `?raw` import suffix
// inlines their content as plain strings at *build time* -- this is a
// static, dated snapshot of the source docs, not a live fetch, matching the
// discipline already established for `BUILD_INFO` / the Landing stat pills
// (see `pages/Landing.tsx`): it goes stale if the source `.md` files change
// without a rebuild, which is an accepted trade-off, not a bug (see
// `frontend/README.md` "Docs page"). `vite.config.ts`'s `server.fs.allow`
// is what lets the dev server (not just `vite build`) read these paths.
import { Suspense, lazy, useEffect, useMemo, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'

import readmeSource from '../../../../README.md?raw'
import modelSource from '../../../../docs/MODEL.md?raw'
import scopeSource from '../../../../docs/SCIENTIFIC_SCOPE.md?raw'
import { PageHeader } from '../../components/PageHeader'
import type { Feature } from '../../features'
import { extractHeadings } from './toc'

// Lazy, exactly like InterpretPanel.tsx's `LazyMarkdown` -- react-markdown
// only downloads when a markdown document is actually shown, keeping it out
// of the main bundle Landing/auth pages pay for. A *static* import here
// would pull MarkdownView (and react-markdown) into the main chunk anyway,
// since App.tsx imports Docs eagerly, defeating InterpretPanel's own lazy
// boundary for the same module (confirmed via `vite build`'s
// INEFFECTIVE_DYNAMIC_IMPORT warning when this was tried).
const LazyMarkdown = lazy(() => import('../../components/MarkdownView'))

const DOCS_FEATURE: Feature = {
  icon: '📖',
  title: 'Docs',
  description:
    'A README-style explanation of the program, plus the full model specification and the scientific-scope ' +
    'discipline this lab follows -- read this before registering or digging into any lab tool.',
  path: '/guide', // not `/docs` -- see features.ts's PUBLIC_NAV_LINKS comment
}

type DocKey = 'overview' | 'model' | 'scope'

interface DocEntry {
  label: string
  filename: string
  source: string
}

const DOCS: Record<DocKey, DocEntry> = {
  overview: { label: 'Overview', filename: 'README.md', source: readmeSource },
  model: { label: 'Model & Methods', filename: 'docs/MODEL.md', source: modelSource },
  scope: { label: 'Scientific Scope', filename: 'docs/SCIENTIFIC_SCOPE.md', source: scopeSource },
}

const DOC_ORDER: DocKey[] = ['overview', 'model', 'scope']

function isDocKey(v: string | null): v is DocKey {
  return v === 'overview' || v === 'model' || v === 'scope'
}

export function Docs() {
  const [params, setParams] = useSearchParams()
  const activeKey: DocKey = isDocKey(params.get('doc')) ? (params.get('doc') as DocKey) : 'overview'
  const active = DOCS[activeKey]
  const contentRef = useRef<HTMLDivElement>(null)

  const toc = useMemo(() => extractHeadings(active.source), [active.source])

  // MarkdownView renders react-markdown output with no heading ids of its
  // own; the TOC is built from the same raw source in the same order, so we
  // assign the extracted slugs onto the actual <h1>/<h2> DOM nodes in
  // document order, without touching MarkdownView itself. This has to be a
  // MutationObserver rather than a plain effect keyed on `toc`: MarkdownView
  // is loaded through <Suspense> (see LazyMarkdown above), so its real
  // content -- the headings -- appears asynchronously, after the chunk
  // resolves, with no re-render of *this* component to re-key an effect on.
  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    const assignIds = () => {
      el.querySelectorAll('h1, h2').forEach((h, i) => {
        const entry = toc[i]
        if (entry) h.id = entry.slug
      })
    }
    assignIds()
    const observer = new MutationObserver(assignIds)
    observer.observe(el, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [toc])

  function setDoc(key: DocKey) {
    const next = new URLSearchParams(params)
    next.set('doc', key)
    setParams(next)
  }

  return (
    <div className="space-y-6" id="doc-top">
      <PageHeader feature={DOCS_FEATURE} />

      <div className="flex flex-wrap gap-1 border-b border-slate-200 dark:border-slate-800" role="tablist" aria-label="Documentation">
        {DOC_ORDER.map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={activeKey === key}
            data-testid={`docs-tab-${key}`}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition ${
              activeKey === key
                ? 'border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-300'
                : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
            }`}
            onClick={() => setDoc(key)}
          >
            {DOCS[key].label}
          </button>
        ))}
      </div>

      <p className="prose-muted text-xs" data-testid="docs-source-caption">
        Showing <code className="font-mono">{active.filename}</code> -- baked into this build at compile time; re-run{' '}
        <code className="font-mono">npm run build</code> to pick up source-file edits.
      </p>

      <div className="grid gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
        {toc.length > 0 && (
          <nav aria-label="On this page" className="order-last lg:order-first">
            <div className="card sticky top-24 max-h-[70vh] space-y-2 overflow-auto p-4 text-sm">
              <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
                On this page
              </p>
              <ul className="space-y-1">
                {toc.map((entry) => (
                  <li key={entry.slug} className={entry.level === 2 ? 'ps-3' : ''}>
                    <a href={`#${entry.slug}`} className="link block truncate">
                      {entry.text}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </nav>
        )}

        <div className="min-w-0">
          <div ref={contentRef}>
            <Suspense fallback={<pre className="mono-block whitespace-pre-wrap text-xs">{active.source}</pre>}>
              <LazyMarkdown source={active.source} />
            </Suspense>
          </div>
          <div className="pt-6">
            <a href="#doc-top" className="link text-sm">
              ↑ Back to top
            </a>
          </div>
        </div>
      </div>
    </div>
  )
}
