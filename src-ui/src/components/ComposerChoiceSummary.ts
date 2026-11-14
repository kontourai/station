import { createContext } from 'react';

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
