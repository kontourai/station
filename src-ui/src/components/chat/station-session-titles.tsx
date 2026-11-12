/**
 * #3418: Session titles for Station tool phrases ("Waited for “Fix login”").
 * A Station tool call carries a Session's id, never its title; the reader
 * knows the titles of the Sessions it can list. A row outside this provider,
 * or a Session the list does not hold, reads "a Session": a phrase never
 * guesses a name.
 *
 * Only a title someone gave or Station generated (`displayTitle`) is used.
 * The generic "<engine> session" fallback the Session list shows is not a
 * name, so the phrase keeps "a Session" instead.
 */
import { useOrchestrationSessionsQuery } from '@kontourai/station-sdk';
import { createContext, type ReactNode, useContext, useMemo } from 'react';

type SessionTitle = (sessionId: string) => string | undefined;

const StationSessionTitles = createContext<SessionTitle | undefined>(undefined);

export function StationSessionTitlesProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { data: sessions } = useOrchestrationSessionsQuery();
  const sessionTitle = useMemo<SessionTitle>(() => {
    const titles = new Map<string, string>();
    for (const session of sessions ?? []) {
      const title = session.displayTitle?.trim();
      if (title) titles.set(session.threadId, title);
    }
    return (sessionId) => titles.get(sessionId);
  }, [sessions]);
  return (
    <StationSessionTitles.Provider value={sessionTitle}>
      {children}
    </StationSessionTitles.Provider>
  );
}

/** The provider's title lookup, or undefined outside it. */
export function useStationSessionTitle(): SessionTitle | undefined {
  return useContext(StationSessionTitles);
}
