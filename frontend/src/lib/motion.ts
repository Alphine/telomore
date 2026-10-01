import { useReducedMotion } from 'framer-motion'

/** Shared enter animation for pages and cards; collapses to no motion when the user prefers reduced motion. */
export function useEnter(delay = 0) {
  const reduce = useReducedMotion()
  if (reduce) return { initial: false as const, animate: undefined, transition: { duration: 0 } }
  return {
    initial: { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.28, delay, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] },
  }
}
