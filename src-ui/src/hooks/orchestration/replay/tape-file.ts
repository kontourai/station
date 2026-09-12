import { MAX_TAPE_BYTES as MAX_TAPE_FILE_BYTES } from './limits';
import { isSessionTape, SESSION_TAPE_KIND, type SessionTape } from './tape';
import { tapeValidationError } from './tape-validation';

const protocolKeys = new Set([
  'kind',
  'method',
  'provider',
  'role',
  'type',
  'state',
  'status',
  'orchestrationStatus',
  'finishReason',
  'inputKind',
  'coverage',
  'elided',
  'createdAt',
  'recordedAt',
  'mediaType',
]);
const identityKeys = new Set([
  'id',
  'eventId',
  'threadId',
  'turnId',
  'sessionId',
  'toolCallId',
  'itemId',
  'requestId',
  'approvalId',
  'conversationId',
  'sourceThreadId',
  'sourceEventId',
  'clientId',
  'deviceId',
  'pendingClientTurnId',
  'openTurnId',
  'currentSessionId',
  'predecessorSessionId',
  'successorSessionId',
]);

const payloadKeys = new Set([
  'arguments',
  'args',
  'output',
  'result',
  'details',
  'provenance',
  'metadata',
  'error',
]);
const structuralPayloadKeys = new Set([
  'command',
  'cmd',
  'file_path',
  'path',
  'query',
  'url',
  'pattern',
  'text',
  'content',
  'message',
  'error',
  'output',
  'result',
  'type',
  'status',
  'kind',
  'id',
  'title',
  'uiBlock',
  'uiBlocks',
]);
function boundedStringify(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (new TextEncoder().encode(encoded).length > MAX_TAPE_FILE_BYTES)
    throw new Error(
      'This export exceeds the 16 MiB replay limit. Capture a shorter segment.',
    );
  return encoded;
}

/** Redacted exports preserve event shape and whitespace, not text fidelity. */
export function serializeSessionTape(
  tape: SessionTape,
  includeContent = false,
): string {
  if (includeContent) return boundedStringify(tape);
  const identities = new Map<string, string>();
  const scrub = (value: unknown, key = '', untrusted = false): unknown => {
    if (typeof value === 'string') {
      if (!untrusted && protocolKeys.has(key)) return value;
      if (!untrusted && identityKeys.has(key)) {
        if (!identities.has(value))
          identities.set(value, `r${(identities.size + 1).toString(36)}`);
        return identities.get(value);
      }
      return value.replace(/[^\s]/gu, 'x');
    }
    if (untrusted && typeof value === 'number') return 0;
    if (untrusted && typeof value === 'boolean') return false;
    if (Array.isArray(value))
      return value.map((item) => scrub(item, key, untrusted));
    if (value && typeof value === 'object') {
      const snapshot = (value as { kind?: unknown }).kind === 'snapshot';
      return Object.fromEntries(
        Object.entries(value).map(([name, item], index) => [
          untrusted && !structuralPayloadKeys.has(name)
            ? `k${index.toString(36)}`
            : name,
          scrub(
            item,
            name,
            untrusted ||
              payloadKeys.has(name) ||
              (name === 'payload' && !snapshot),
          ),
        ]),
      );
    }
    return value;
  };
  return boundedStringify({
    ...(scrub(tape) as SessionTape),
    redacted: true,
    ...(tape.stoppedReason
      ? {
          stoppedReason:
            'Recording is incomplete; the source explanation was redacted.',
        }
      : {}),
  });
}

export async function readSessionTapeFile(
  file: Pick<File, 'size' | 'text'>,
): Promise<SessionTape> {
  if (
    !Number.isSafeInteger(file.size) ||
    file.size < 0 ||
    file.size > MAX_TAPE_FILE_BYTES
  )
    throw new Error('Replay files must be at most 16 MiB.');
  const encoded = await file.text();
  if (new TextEncoder().encode(encoded).length > MAX_TAPE_FILE_BYTES)
    throw new Error('Replay files must be at most 16 MiB.');
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    throw new Error('The recording is not valid JSON.');
  }
  if (!isSessionTape(value))
    throw new Error(
      tapeValidationError(value, SESSION_TAPE_KIND) ??
        'This file is not a supported Station recording.',
    );
  const { extractUIBlocks } = await import('@kontourai/station-sdk');
  const parts = [
    value.initialChat?.streamingMessage?.contentParts,
    ...(value.initialChat?.messages ?? []).map(
      (message) => message.contentParts,
    ),
  ];
  for (const group of parts)
    for (const part of group ?? []) {
      if (part.uiBlock === undefined) continue;
      const normalized = extractUIBlocks({ uiBlock: part.uiBlock });
      if (normalized.length !== 1)
        throw new Error('The replay contains an unsupported UI block.');
      part.uiBlock = normalized[0];
    }
  return value;
}

export function downloadSessionTape(
  tape: SessionTape,
  includeContent = false,
): void {
  const url = URL.createObjectURL(
    new Blob([serializeSessionTape(tape, includeContent)], {
      type: 'application/json',
    }),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `station-replay${includeContent ? '-with-content' : '-redacted'}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
