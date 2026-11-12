/**
 * #3418: Session titles for Station tool phrases ("Waited for “Fix login”").
 * Only a real `displayTitle` is used; anything else reads "a Session".
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
