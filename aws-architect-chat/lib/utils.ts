import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const D2_RESPONSE_SENTINEL = '---===D2_END===---';

export interface ParsedArchitectResponse {
  d2Text: string;
  explanation: string;
  hasSentinel: boolean;
}

export function parseArchitectResponse(response: string): ParsedArchitectResponse {
  const [d2Text = '', explanation = ''] = response.split(D2_RESPONSE_SENTINEL);

  return {
    d2Text: d2Text.trim(),
    explanation: explanation.trim(),
    hasSentinel: response.includes(D2_RESPONSE_SENTINEL),
  };
}
