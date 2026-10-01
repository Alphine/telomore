import * as RadixDialog from '@radix-ui/react-dialog'
import { CornerDownLeft, Search } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { useAccess } from '../access/context'
import { useAuth } from '../auth/context'
import { FOCI_LAB_URL, NAV_FEATURES, PUBLIC_NAV_LINKS } from '../features'
import { cn } from '../lib/cn'
import { useTheme } from '../theme/context'

interface Command {
  id: string
  label: string
  hint?: string
  group: string
  run: () => void
}

/** Ctrl/Cmd-K command palette: jump to any page, switch theme or mode, log in/out. */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate()
  const { setPreference } = useTheme()
  const { logout, status } = useAuth()
  const { isAdmin, canLive, mode, setPreferredMode } = useAccess()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLUListElement>(null)

  const go = useCallback(
    (path: string) => () => {
      navigate(path)
    },
    [navigate],
  )

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [{ id: 'home', label: 'Home', group: 'Go to', run: go('/') }]
    for (const f of PUBLIC_NAV_LINKS) list.push({ id: f.path, label: f.title, group: 'Go to', run: go(f.path) })
    for (const f of NAV_FEATURES) list.push({ id: f.path, label: f.title, hint: f.description, group: 'Features', run: go(f.path) })
    list.push({ id: 'foci', label: 'Foci Lab (opens in a new tab)', group: 'Go to', run: () => window.open(FOCI_LAB_URL, '_blank', 'noopener') })
    if (status === 'authenticated') {
      list.push({ id: 'account', label: 'Account and Pro access', group: 'Account', run: go('/account') })
      list.push({
        id: 'logout',
        label: 'Log out',
        group: 'Account',
        run: () => {
          logout()
          navigate('/')
        },
      })
    } else {
      list.push({ id: 'login', label: 'Log in', group: 'Account', run: go('/login') })
      list.push({ id: 'register', label: 'Create a free account', group: 'Account', run: go('/register') })
    }
    if (isAdmin) {
      list.push({ id: 'admin', label: 'Admin overview', group: 'Admin', run: go('/admin') })
      list.push({ id: 'admin-users', label: 'Admin: users', group: 'Admin', run: go('/admin/users') })
      list.push({ id: 'admin-requests', label: 'Admin: access requests', group: 'Admin', run: go('/admin/requests') })
      list.push({ id: 'admin-usage', label: 'Admin: usage log', group: 'Admin', run: go('/admin/usage') })
      list.push({ id: 'admin-audit', label: 'Admin: audit log', group: 'Admin', run: go('/admin/audit') })
    }
    if (canLive) {
      list.push({
        id: 'mode',
        label: mode === 'live' ? 'Switch to precomputed examples (demo mode)' : 'Switch to live compute',
        group: 'Settings',
        run: () => setPreferredMode(mode === 'live' ? 'demo' : 'live'),
      })
    }
    list.push({ id: 'theme-light', label: 'Theme: light', group: 'Settings', run: () => setPreference('light') })
    list.push({ id: 'theme-dark', label: 'Theme: dark', group: 'Settings', run: () => setPreference('dark') })
    list.push({ id: 'theme-system', label: 'Theme: follow system', group: 'Settings', run: () => setPreference('system') })
    return list
  }, [go, status, logout, navigate, isAdmin, canLive, mode, setPreferredMode, setPreference])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return commands
    return commands.filter((c) => `${c.label} ${c.group}`.toLowerCase().includes(q))
  }, [commands, query])

  useEffect(() => {
    if (!open) return
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [active, open])

  function choose(c: Command | undefined) {
    if (!c) return
    onOpenChange(false)
    c.run()
  }

  return (
    <RadixDialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setQuery('')
          setActive(0)
        }
        onOpenChange(o)
      }}
    >
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-slate-950/50 backdrop-blur-[2px] data-[state=open]:animate-[fade-in_120ms_ease-out]" />
        <RadixDialog.Content
          className="fixed left-1/2 top-[12vh] z-50 w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl focus:outline-none dark:border-slate-800 dark:bg-slate-900"
          aria-describedby={undefined}
        >
          <RadixDialog.Title className="sr-only">Command palette</RadixDialog.Title>
          <div className="flex items-center gap-2 border-b border-slate-200 px-4 dark:border-slate-800">
            <Search className="h-4 w-4 text-slate-500" aria-hidden />
            <input
              autoFocus
              role="combobox"
              aria-expanded
              aria-controls="cmdk-list"
              aria-activedescendant={filtered[active] ? `cmdk-${filtered[active].id}` : undefined}
              aria-label="Search pages and actions"
              placeholder="Go to a page or run an action…"
              className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-slate-400"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setActive(0)
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setActive((i) => Math.min(i + 1, filtered.length - 1))
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setActive((i) => Math.max(i - 1, 0))
                } else if (e.key === 'Enter') {
                  e.preventDefault()
                  choose(filtered[active])
                }
              }}
            />
            <kbd className="hidden rounded border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-500 sm:block dark:border-slate-700">Esc</kbd>
          </div>
          <ul id="cmdk-list" ref={listRef} role="listbox" aria-label="Results" className="max-h-80 overflow-y-auto p-2">
            {filtered.length === 0 && <li className="px-3 py-6 text-center text-sm text-slate-500">Nothing matches “{query}”.</li>}
            {filtered.map((c, i) => (
              <li
                key={c.id}
                id={`cmdk-${c.id}`}
                role="option"
                aria-selected={i === active}
                onMouseMove={() => setActive(i)}
                onClick={() => choose(c)}
                className={cn(
                  'flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm',
                  i === active ? 'bg-teal-50 text-teal-900 dark:bg-teal-500/10 dark:text-teal-100' : '',
                )}
              >
                <span className="min-w-0 truncate">{c.label}</span>
                <span className="flex shrink-0 items-center gap-2 text-xs text-slate-500">
                  {c.group}
                  {i === active && <CornerDownLeft className="h-3 w-3" aria-hidden />}
                </span>
              </li>
            ))}
          </ul>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

/** Global Ctrl/Cmd-K listener; returns [open, setOpen]. */
export function useCommandPaletteShortcut(): [boolean, (o: boolean) => void] {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return [open, setOpen]
}
