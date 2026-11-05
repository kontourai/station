import { createContext, type ReactNode, useContext } from 'react';
import type { StationConnection } from '../../connections/station-connection';
import type { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import type { ChatMessage } from '../../types';
import type { MessageDeliveryState } from '../../utils/messageDeliveryState';
import type { DeliveryPort } from './DeliveryPort';

/** Explicit host/read-only adapters may lack a Station lease during adoption. */
export interface ConversationConnection {
  apiBase: string;
  requestScope?: NonNullable<ReturnType<typeof useHostRequestAuthorityScope>>;
  station?: StationConnection;
  /** Record adapters never write bookkeeping into the dock's tab store. */
  record?: {
    readOnly: boolean;
    onAnswered?: () => void;
    answeringDeniedReason?: string;
    deliveryFor?: (
      message: ChatMessage,
    ) => { state: MessageDeliveryState; port: DeliveryPort } | undefined;
  };
}

export const ConversationConnectionContext =
  createContext<ConversationConnection | null>(null);

export function ConversationConnectionProvider({
  value,
  children,
}: {
  value: ConversationConnection;
  children: ReactNode;
}) {
  return (
    <ConversationConnectionContext.Provider value={value}>
      {children}
    </ConversationConnectionContext.Provider>
  );
}

export function useConversationConnection() {
  const connection = useContext(ConversationConnectionContext);
  if (!connection)
    throw new Error('ConversationConnectionProvider is required');
  return connection;
}

/** Transitional read-only Task/detail adapters are migrated in P2. */
export function useOptionalConversationConnection() {
  return useContext(ConversationConnectionContext);
}
