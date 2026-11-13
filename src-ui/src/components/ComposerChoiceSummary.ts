import { createContext } from 'react';

/** Choices publish their existing accessible labels; setup never re-resolves policy. */
export const ComposerChoiceSummary = createContext<
  ((id: string, label: string | undefined) => void) | null
>(null);
