/**
 * Canonical conversation message contract. The definition lives in
 * station-shared so the server and client share one shape; re-exported here so
 * server modules can import it from a stable domain path.
 */
export type {
  ConversationMessage,
  MessagePart,
} from '@kontourai/station-shared/conversation-message';
