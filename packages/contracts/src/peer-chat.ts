export const PEER_CHAT_UPLOAD_GRANT_HEADER =
  'X-Station-Attachment-Upload-Grant';
export const PEER_CHAT_REFUSAL_CODE = 'peer_chat_target_refused';
export const PEER_CHAT_PRE_EFFECT_CODES = [
  'provider_turn_in_progress',
  'provider_session_starting',
  'inbox_stale_head',
  'inbox_key_conflict',
  'client_turn_input_conflict',
] as const;

export interface PeerChatConnectionV1 {
  version: 1;
  environmentId: string;
  stationName: string;
  /** Public credential lineage, never credential bytes or a credential digest. */
  principalNamespace: string;
  receiver: { delegationLocalConversationV1: boolean };
  ceiling: { read: boolean; operate: boolean; localConversation: boolean };
}

export interface PeerChatTargetRefusalV1 {
  version: 1;
  failureAuthority: 'target';
  environmentId: string;
  remoteStatus: 401 | 403 | 409;
  refusalCode?: (typeof PEER_CHAT_PRE_EFFECT_CODES)[number];
  disposition: 'refused-before-dispatch';
  mutationKey?: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, max = 512): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    [...value].every(
      (character) =>
        character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
    )
  );
}

export function parsePeerChatConnection(
  value: unknown,
): PeerChatConnectionV1 | null {
  const body = record(value);
  const receiver = record(body?.receiver);
  const ceiling = record(body?.ceiling);
  if (
    body?.version !== 1 ||
    !text(body.environmentId, 200) ||
    !text(body.stationName, 120) ||
    !text(body.principalNamespace) ||
    typeof receiver?.delegationLocalConversationV1 !== 'boolean' ||
    typeof ceiling?.read !== 'boolean' ||
    typeof ceiling.operate !== 'boolean' ||
    typeof ceiling.localConversation !== 'boolean'
  )
    return null;
  if (ceiling.localConversation && !receiver.delegationLocalConversationV1)
    return null;
  return {
    version: 1,
    environmentId: body.environmentId,
    stationName: body.stationName,
    principalNamespace: body.principalNamespace,
    receiver: {
      delegationLocalConversationV1: receiver.delegationLocalConversationV1,
    },
    ceiling: {
      read: ceiling.read,
      operate: ceiling.operate,
      localConversation: ceiling.localConversation,
    },
  };
}

/** Callers must additionally require the source envelope and current bound request authority. */
export function parsePeerChatTargetRefusal(
  value: unknown,
  expected: { environmentId: string; mutationKey?: string },
): PeerChatTargetRefusalV1 | null {
  const body = record(value);
  const details = record(body?.details);
  const refusalCode = PEER_CHAT_PRE_EFFECT_CODES.find(
    (code) => code === details?.refusalCode,
  );
  if (
    body?.success !== false ||
    body.code !== PEER_CHAT_REFUSAL_CODE ||
    details?.version !== 1 ||
    details.failureAuthority !== 'target' ||
    details.environmentId !== expected.environmentId ||
    !text(details.environmentId, 200) ||
    (details.remoteStatus !== 401 &&
      details.remoteStatus !== 403 &&
      details.remoteStatus !== 409) ||
    (details.remoteStatus === 409 && !refusalCode) ||
    (details.remoteStatus !== 409 && details.refusalCode !== undefined) ||
    details.disposition !== 'refused-before-dispatch' ||
    details.mutationKey !== expected.mutationKey ||
    (details.mutationKey !== undefined && !text(details.mutationKey, 200))
  )
    return null;
  return {
    version: 1,
    failureAuthority: 'target',
    environmentId: details.environmentId,
    remoteStatus: details.remoteStatus,
    disposition: 'refused-before-dispatch',
    ...(details.remoteStatus === 409
      ? {
          refusalCode,
        }
      : {}),
    ...(expected.mutationKey === undefined
      ? {}
      : { mutationKey: expected.mutationKey }),
  };
}

/**
 * Continuing a conversation on a paired Station. The source Station reads its
 * own transcript and sends it, bounded, to the receiver, which saves it as the
 * new conversation's carried context (`POST /agents/:slug/conversation-imports`).
 * The conversation identity does not move: the receiver owns a new
 * conversation, and the source conversation is left as it was.
 */
/** The paired Station definitely refused the import; nothing was created there. */
export const PEER_CONVERSATION_HANDOFF_REFUSAL_CODE =
  'peer_conversation_handoff_refused';
/** The paired Station refused this Station's credential (scope, origin, auth). */
export const PEER_CONVERSATION_HANDOFF_ACCESS_CODE =
  'peer_conversation_handoff_access_refused';
/**
 * The paired Station takes imports only from a Station paired with it as a
 * Station; this one reaches it with a person's device credential.
 */
export const PEER_CONVERSATION_HANDOFF_PAIRING_CODE =
  'peer_conversation_handoff_pairing_required';
/** The receiver's own code for a caller that is not a paired Station. */
export const PAIRED_STATION_REQUIRED_CODE = 'paired_station_required';
/**
 * The import this key saved was deleted before its first turn; nothing of it
 * remains, so a new request (a new key) is safe.
 */
export const CONVERSATION_IMPORT_DELETED_CODE = 'conversation_import_deleted';
export const PEER_CONVERSATION_HANDOFF_MAX_MESSAGES = 400;
/**
 * Bytes of carried message text AS JSON-ENCODED on the wire (escapes such as
 * `\u0001` count six bytes), so the request stays under the receiver's body
 * ceiling whatever the text holds.
 */
export const PEER_CONVERSATION_HANDOFF_MAX_TEXT_BYTES = 512 * 1024;
/** Encoded bytes of one carried message; a longer one is cut with a marker. */
export const PEER_CONVERSATION_HANDOFF_MAX_MESSAGE_BYTES = 64 * 1024;
/**
 * The whole encoded import request. Under the receiver's 1 MiB standard body
 * ceiling; the sender refuses a request one byte over rather than send it.
 */
export const PEER_CONVERSATION_HANDOFF_MAX_REQUEST_BYTES = 768 * 1024;

/** Browser to its own Station: `POST /api/environments/peers/:id/conversation-handoffs`. */
export interface PeerConversationHandoffRequestV1 {
  idempotencyKey: string;
  conversationId: string;
  /** The Agent on the paired Station; it must match this conversation's Agent. */
  targetAgent: string;
  /** A Project of the paired Station, chosen from its own list. */
  projectSlug?: string;
}

export interface ConversationImportMessageV1 {
  id: string;
  role: 'user' | 'assistant';
  /** The row's own text, unquoted. */
  text: string;
  /**
   * Set when the sender itself imported this row: the Station it came from,
   * as the sender records it. The receiver keeps it, naming the sender too.
   */
  importedFrom?: string;
}

/** Source Station to receiver: the bounded text history it carries. */
export interface ConversationImportRequestV1 {
  version: 1;
  idempotencyKey: string;
  /**
   * The sender's own conversation. Which Station sent it is not claimed here:
   * the receiver takes it from the authenticated paired-Station credential.
   */
  source: {
    conversationId: string;
    title: string;
    agent: string;
  };
  projectSlug?: string;
  messages: ConversationImportMessageV1[];
  /** Older text messages the source left out to stay inside the bounds. */
  omittedMessages: number;
  /** Tool, reasoning and other rows with no text to carry. */
  nonTextMessages: number;
  /** Carried messages whose middle was cut to the per-message bound. */
  shortenedMessages: number;
}

/**
 * The receiver's answer, from what it SAVED: a same-key retry reports the
 * first request's counts even when the source's history has grown since.
 */
export interface PeerConversationHandoffReceiptV1 {
  version: 1;
  environmentId: string;
  /** The receiver's new conversation. Its first turn has not been sent yet. */
  conversationId: string;
  carriedMessages: number;
  omittedMessages: number;
  nonTextMessages: number;
  /** The receiver already held this key's conversation. */
  idempotent: boolean;
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function parsePeerConversationHandoffReceipt(
  value: unknown,
  expected: { environmentId: string },
): PeerConversationHandoffReceiptV1 | null {
  const body = record(value);
  if (
    body?.version !== 1 ||
    body.environmentId !== expected.environmentId ||
    !text(body.conversationId, 256) ||
    !count(body.carriedMessages) ||
    !count(body.omittedMessages) ||
    !count(body.nonTextMessages) ||
    typeof body.idempotent !== 'boolean'
  )
    return null;
  return {
    version: 1,
    environmentId: expected.environmentId,
    conversationId: body.conversationId,
    carriedMessages: body.carriedMessages,
    omittedMessages: body.omittedMessages,
    nonTextMessages: body.nonTextMessages,
    idempotent: body.idempotent,
  };
}
