import { createContext, type RefObject } from 'react';

/** Choices publish their existing accessible labels; setup never re-resolves policy. */
export const ComposerChoiceSummary = createContext<
  | ((
      id: string,
      label: string | undefined,
      safety?: string,
      changed?: boolean,
    ) => void)
  | null
>(null);

/**
 * Closes the Run setup panel a choice sits in, for a choice that opens its
 * own dialog where two stacked overlays would not fit (a phone).
 */
export const ComposerRunSetupClose = createContext<(() => void) | null>(null);

export const ComposerTextarea = createContext<
  RefObject<HTMLTextAreaElement | null> | undefined
>(undefined);
