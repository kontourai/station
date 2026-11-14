import type { SessionMessageAnchor } from '@kontourai/station-contracts/surface-deep-link';
import { createContext, type ReactNode, useContext } from 'react';

/** The consumed Chat session intent, including bounded exact-message lookup. */
export interface SessionReaderBinding {
  apiBase: string;
  /** Deep-linked session id of whichever placement supplied it, if any. */
  sessionId?: string;
  messageAnchor?: SessionMessageAnchor;
  /** Reveal the selected record's evidence for this activation. */
  focus?: 'evidence';
  /**
   * Monotonic activation identity, including repeated intents for the same
   * session. Supplied by the region placement, which is the only one that
   * delivers an intent at all.
   */
  intentToken?: number;
  /** Region placement only, for the same reason as `intentToken`. */
}

const SessionReaderContext = createContext<SessionReaderBinding | null>(null);

export function SessionReaderBindingProvider({
  binding,
  children,
}: {
  binding: SessionReaderBinding;
  children: ReactNode;
}) {
  return (
    <SessionReaderContext.Provider value={binding}>
      {children}
    </SessionReaderContext.Provider>
  );
}

export function useSessionReaderBinding(): SessionReaderBinding | null {
  return useContext(SessionReaderContext);
}
