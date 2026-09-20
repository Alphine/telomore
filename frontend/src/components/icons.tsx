// Stroke-based line icons (20x20 viewbox, currentColor) for the pre-login
// Showcase page (pages/Showcase.tsx) -- replaces emoji glyphs with scalable,
// recolorable SVG for a more scientific/premium feel. Kept local to this
// page rather than threaded through `features.ts`'s icon field (still an
// emoji string, used by Layout's sidebar nav and the in-app Landing
// dashboard) to keep this change targeted.
import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

const base = {
  viewBox: '0 0 20 20',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

/** Telomere-capped double helix -- the app's logomark, replacing the 🧬 emoji. */
export function LogoMark({ className }: { className?: string }) {
  const id = 'tl-logo-grad'
  return (
    <svg viewBox="0 0 32 32" fill="none" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="32" y2="32">
          <stop stopColor="#0ea5e9" />
          <stop offset="1" stopColor="#7c3aed" />
        </linearGradient>
      </defs>
      <path d="M10 4c6 4 6 8 0 12s-6 8 0 12" stroke={`url(#${id})`} strokeWidth={2.3} strokeLinecap="round" />
      <path d="M22 4c-6 4-6 8 0 12s6 8 0 12" stroke={`url(#${id})`} strokeWidth={2.3} strokeLinecap="round" />
      <line x1="10.5" y1="8" x2="21.5" y2="8" stroke={`url(#${id})`} strokeWidth={1.4} strokeLinecap="round" />
      <line x1="10.5" y1="16" x2="21.5" y2="16" stroke={`url(#${id})`} strokeWidth={1.4} strokeLinecap="round" />
      <line x1="10.5" y1="24" x2="21.5" y2="24" stroke={`url(#${id})`} strokeWidth={1.4} strokeLinecap="round" />
      <circle cx="10" cy="4" r="2.1" fill={`url(#${id})`} />
      <circle cx="22" cy="4" r="2.1" fill={`url(#${id})`} />
      <circle cx="10" cy="28" r="2.1" fill={`url(#${id})`} />
      <circle cx="22" cy="28" r="2.1" fill={`url(#${id})`} />
    </svg>
  )
}

export function FlaskIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M8 3h4" />
      <path d="M9 3v5l-4.2 7.3A1.5 1.5 0 0 0 6.1 17.5h7.8a1.5 1.5 0 0 0 1.3-2.2L11 8V3" />
      <path d="M7 13h6" />
    </svg>
  )
}

export function HelixIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M6 2.5c4 2.5 4 5 0 7.5s-4 5 0 7.5" />
      <path d="M14 2.5c-4 2.5-4 5 0 7.5s4 5 0 7.5" />
      <line x1="6.3" y1="5" x2="13.7" y2="5" />
      <line x1="6" y1="10" x2="14" y2="10" />
      <line x1="6.3" y1="15" x2="13.7" y2="15" />
    </svg>
  )
}

export function ScatterIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M3 3v14h14" />
      <path d="M6 13 9 9l3.5-2L16 5.5" strokeDasharray="1 2.6" />
      <circle cx="6" cy="13" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="9" cy="9" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="7" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="16" cy="5.5" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function TornadoIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <line x1="3" y1="4.5" x2="17" y2="4.5" />
      <line x1="5.5" y1="8.5" x2="14.5" y2="8.5" />
      <line x1="4" y1="12.5" x2="16" y2="12.5" />
      <line x1="7" y1="16.5" x2="13" y2="16.5" />
    </svg>
  )
}

export function GridIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="3" y="3" width="6" height="6" rx="1.2" />
      <rect x="11" y="3" width="6" height="6" rx="1.2" />
      <rect x="3" y="11" width="6" height="6" rx="1.2" />
      <rect x="11" y="11" width="6" height="6" rx="1.2" />
    </svg>
  )
}

export function ScaleIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <line x1="10" y1="3" x2="10" y2="16" />
      <line x1="4" y1="6" x2="16" y2="6" />
      <path d="M4 6 1.5 11a2.5 2.5 0 0 0 5 0z" />
      <path d="M16 6l2.5 5a2.5 2.5 0 0 1-5 0z" />
      <line x1="7" y1="17" x2="13" y2="17" />
    </svg>
  )
}

export function LedgerIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="4" y="2.5" width="12" height="15" rx="1.5" />
      <line x1="7" y1="6.5" x2="13" y2="6.5" />
      <line x1="7" y1="10" x2="13" y2="10" />
      <line x1="7" y1="13.5" x2="10.5" y2="13.5" />
    </svg>
  )
}

export function SearchSparkIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="8.4" cy="8.4" r="5" />
      <line x1="12.2" y1="12.2" x2="17" y2="17" />
      <line x1="8.4" y1="6" x2="8.4" y2="10.8" />
      <line x1="6" y1="8.4" x2="10.8" y2="8.4" />
    </svg>
  )
}

export function CheckIcon(props: IconProps) {
  return (
    <svg {...base} strokeWidth={1.8} {...props}>
      <path d="M4 10.5l4 4 8-9" />
    </svg>
  )
}

export function ChipIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="5" y="5" width="10" height="10" rx="1.5" />
      <line x1="8" y1="2" x2="8" y2="5" />
      <line x1="12" y1="2" x2="12" y2="5" />
      <line x1="8" y1="15" x2="8" y2="18" />
      <line x1="12" y1="15" x2="12" y2="18" />
      <line x1="2" y1="8" x2="5" y2="8" />
      <line x1="2" y1="12" x2="5" y2="12" />
      <line x1="15" y1="8" x2="18" y2="8" />
      <line x1="15" y1="12" x2="18" y2="12" />
    </svg>
  )
}

export function InfoIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="10" cy="10" r="7.25" />
      <line x1="10" y1="9" x2="10" y2="14" />
      <circle cx="10" cy="6.3" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function LightbulbIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M10 3.2a4.8 4.8 0 0 0-2.9 8.6c.6.5 1 1.2 1 2h3.8c0-.8.4-1.5 1-2A4.8 4.8 0 0 0 10 3.2z" />
      <line x1="8.2" y1="16.6" x2="11.8" y2="16.6" />
    </svg>
  )
}

export function BarsIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" {...props}>
      <line x1="3.5" y1="16.5" x2="16.5" y2="16.5" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" />
      <rect x="5" y="10.5" width="2.6" height="6" rx="0.4" />
      <rect x="8.7" y="6" width="2.6" height="10.5" rx="0.4" />
      <rect x="12.4" y="12.5" width="2.6" height="4" rx="0.4" />
    </svg>
  )
}

export function TargetIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="10" cy="10" r="6.5" />
      <circle cx="10" cy="10" r="3" />
      <circle cx="10" cy="10" r="0.7" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function RefreshIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4.2 10a5.8 5.8 0 0 1 10-4" />
      <path d="M15.8 10a5.8 5.8 0 0 1-10 4" />
      <path d="M14.3 3.3v3h-3" />
      <path d="M5.7 16.7v-3h3" />
    </svg>
  )
}

/** A single population-grid dot on the Showcase page's live simulation preview. */
export function ChromosomeDotIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" {...props}>
      <path d="M6 2v6c0 2.5 2 3 2 6s-2 3-2 6" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" />
      <path d="M14 2v6c0 2.5-2 3-2 6s2 3 2 6" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" />
      <circle cx="6" cy="2" r="1.3" fill="currentColor" />
      <circle cx="14" cy="2" r="1.3" fill="currentColor" />
      <circle cx="6" cy="18" r="1.3" fill="currentColor" />
      <circle cx="14" cy="18" r="1.3" fill="currentColor" />
    </svg>
  )
}

/** Icon for each `Feature.path` (features.ts), for the Showcase page's feature grid. */
export const FEATURE_ICONS: Record<string, (props: IconProps) => JSX.Element> = {
  '/simulate': FlaskIcon,
  '/evolve': HelixIcon,
  '/pareto': ScatterIcon,
  '/sensitivity': TornadoIcon,
  '/gxe': GridIcon,
  '/compare': ScaleIcon,
  '/experiments': LedgerIcon,
  '/active-learning': SearchSparkIcon,
  '/genome': HelixIcon,
}
