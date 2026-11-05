import { createContext, type ReactNode, useContext } from 'react';
import type { StationConnection } from '../../connections/station-connection';
import type { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';

/** Explicit host/read-only adapters may lack a Station lease during adoption. */
export interface ConversationConnection {
  apiBase: string;
  requestScope?: NonNullable<ReturnType<typeof useHostRequestAuthorityScope>>;
  station?: StationConnection;
}

const ConnectionContext = createContext<ConversationConnection | null>(null);

export function ConversationConnectionProvider({
  value,
  children,
}: {
  value: ConversationConnection;
  children: ReactNode;
}) {
  return (
    <ConnectionContext.Provider value={value}>
      {children}
    </ConnectionContext.Provider>
  );
}

export function useConversationConnection() {
  const connection = useContext(ConnectionContext);
  if (!connection)
    throw new Error('ConversationConnectionProvider is required');
  return connection;
}

/** Transitional read-only Task/detail adapters are migrated in P2. */
export function useOptionalConversationConnection() {
  return useContext(ConnectionContext);
}
