/**
 * The narrow authority an inbound webhook may hold.  An omitted `starts`
 * list is intentionally an empty grant, never a wildcard.
 */
export interface InboundWebhookStartGrant {
  agentId: string;
  /** Omitted means a direct (non-project) turn only. */
  projectSlug?: string;
}

/** One named, independently revocable HMAC credential. */
export interface InboundWebhookToken {
  id: string;
  name: string;
  /** Local-only HMAC secret. Never project this to an API response or logs. */
  secret: string;
  revokedAt?: string;
  starts?: InboundWebhookStartGrant[];
}

/** Private Station-home configuration for the inbound webhook listener. */
export interface InboundWebhookConfiguration {
  schemaVersion: 1;
  /** Must be exactly true for any request to start a turn. */
  enabled?: boolean;
  tokens?: InboundWebhookToken[];
}
