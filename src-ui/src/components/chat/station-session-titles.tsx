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
  // Keyed on the titles alone, so a Session-list refresh that changes no
  // title does not re-render every tool row.
  const key = JSON.stringify(
    (sessions ?? []).flatMap((session) => {
      const title = session.displayTitle?.trim();
      return title ? [[session.threadId, title]] : [];
    }),
  );
  const sessionTitle = useMemo<SessionTitle>(() => {
    const titles = new Map<string, string>(JSON.parse(key));
    return (sessionId) => titles.get(sessionId);
  }, [key]);
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
