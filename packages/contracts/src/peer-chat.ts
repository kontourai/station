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
