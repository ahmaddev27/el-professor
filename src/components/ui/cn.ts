import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// tailwind-merge only knows Tailwind's default scale. Without this it would not
// see `rounded-control` and `rounded-full` as the same property, and a caller's
// override would be appended instead of replacing the component default.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      borderRadius: ['control', 'surface'],
    },
    classGroups: {
      shadow: [{ shadow: ['raised', 'overlay'] }],
      'font-family': [{ font: ['ui'] }],
    },
  },
});

/** Join class names, letting later Tailwind classes override earlier ones. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
