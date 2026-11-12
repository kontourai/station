import type { ApiRequestScope } from '@kontourai/station-sdk';
import { createContext, useContext } from 'react';

export interface BrowserActivityScope {
  apiBase: string;
  requestScope: ApiRequestScope;
  projectSlug: string;
  threadIds: readonly string[];
  conversationKey: string;
}

export const BrowserActivityContext =
  createContext<BrowserActivityScope | null>(null);
export const useBrowserActivityScope = () => useContext(BrowserActivityContext);

/** The caller must supply the conversation's captured authority, not the viewer's target. */
export function BrowserActivityProvider({
  enabled,
  apiBase,
  requestScope,
  hostAuthority,
  routeKind,
  readOnly,
  session,
  children,
}: {
  enabled: boolean;
  apiBase: string;
  requestScope?: ApiRequestScope & { isCurrent(): boolean };
  hostAuthority?: ApiRequestScope & { isCurrent(): boolean };
  routeKind?: string;
  readOnly: boolean;
  session: {
    id: string;
    conversationId?: string | null;
    currentSessionId?: string | null;
    projectSlug?: string | null;
  };
  children: React.ReactNode;
}) {
  const scope =
    enabled &&
    !readOnly &&
    routeKind === 'host' &&
    requestScope &&
    hostAuthority &&
    requestScope.authorityKey === hostAuthority.authorityKey &&
    apiBase === hostAuthority.apiBase &&
    apiBase === requestScope.apiBase &&
    hostAuthority.isCurrent() &&
    requestScope.isCurrent() &&
    session.projectSlug
      ? {
          apiBase,
          requestScope,
          projectSlug: session.projectSlug,
          threadIds: [
            session.id,
            session.conversationId,
            session.currentSessionId,
          ].filter((id): id is string => Boolean(id)),
          conversationKey: session.conversationId ?? session.id,
        }
      : null;
  return (
    <BrowserActivityContext.Provider value={scope}>
      {children}
    </BrowserActivityContext.Provider>
  );
}
