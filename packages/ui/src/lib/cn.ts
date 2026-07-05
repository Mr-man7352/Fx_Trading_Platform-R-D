import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** FE-010 — canonical class combiner (clsx + tailwind-merge), shadcn convention. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
