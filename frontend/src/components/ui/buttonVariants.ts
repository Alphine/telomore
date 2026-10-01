import { cva } from 'class-variance-authority'

export const buttonVariants = cva(
  'inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium transition-colors ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-2 ' +
    'focus-visible:ring-offset-white dark:focus-visible:ring-offset-slate-950 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary:
          'bg-teal-600 text-white shadow-sm hover:bg-teal-700 dark:bg-teal-500 dark:text-slate-950 dark:hover:bg-teal-400',
        outline:
          'border border-slate-300 bg-white text-slate-800 shadow-sm hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800',
        ghost: 'text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
        danger: 'bg-rose-600 text-white shadow-sm hover:bg-rose-700 dark:bg-rose-500 dark:hover:bg-rose-400',
        link: 'text-teal-700 underline-offset-4 hover:underline dark:text-teal-400',
      },
      size: {
        sm: 'h-8 px-3 text-xs',
        md: 'h-9 px-4 text-sm',
        lg: 'h-11 px-6 text-sm',
        icon: 'h-9 w-9 text-sm',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
)
