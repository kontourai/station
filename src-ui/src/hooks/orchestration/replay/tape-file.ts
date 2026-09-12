import { isSessionTape, type SessionTape } from './tape';

const MAX_TAPE_FILE_BYTES = 16 * 1024 * 1024;
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
]);

/** Redacted exports preserve event shape and whitespace, not text fidelity. */
export function serializeSessionTape(
  tape: SessionTape,
  includeContent = false,
): string {
  if (includeContent) return JSON.stringify(tape);
  const identities = new Map<string, string>();
  const scrub = (value: unknown, key = '', untrusted = false): unknown => {
    if (typeof value === 'string') {
      if (!untrusted && protocolKeys.has(key)) return value;
      if (!untrusted && identityKeys.has(key)) {
        if (!identities.has(value))
          identities.set(value, `recorded-id-${identities.size + 1}`);
        return identities.get(value);
      }
      return value.replace(/[^\s]/gu, 'x');
    }
    if (Array.isArray(value))
      return value.map((item) => scrub(item, key, untrusted));
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([name, item]) => [
          name,
          scrub(
            item,
            name,
            untrusted ||
              [
                'arguments',
                'args',
                'output',
                'result',
                'details',
                'provenance',
                'metadata',
                'error',
              ].includes(name),
          ),
        ]),
      );
    return value;
  };
  return JSON.stringify({ ...(scrub(tape) as SessionTape), redacted: true });
}

export async function readSessionTapeFile(file: File): Promise<SessionTape> {
  if (file.size > MAX_TAPE_FILE_BYTES)
    throw new Error('Replay files must be at most 16 MiB.');
  const value: unknown = JSON.parse(await file.text());
  if (!isSessionTape(value))
    throw new Error('This file is not a supported Station session tape.');
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
