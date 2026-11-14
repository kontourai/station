import { isDeepStrictEqual } from 'node:util';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';

type RequestOpened = Extract<
  CanonicalRuntimeEvent,
  { method: 'request.opened' }
>;
type Waiting = {
  expected: RequestOpened;
  resolve(committed: boolean): void;
};
const waiting = new WeakMap<CanonicalRuntimeEvent, Waiting>();

/** Private in-process acknowledgement; no event field or client id grants it. */
export function awaitCanonicalRequestCommit(event: RequestOpened): Readonly<{
  committed: Promise<boolean>;
  cancel(): void;
}> {
  if (waiting.has(event)) throw new Error('Request commit is already observed');
  const expected = structuredClone(event);
  let resolve!: (committed: boolean) => void;
  const committed = new Promise<boolean>((done) => {
    resolve = done;
  });
  const entry = { expected, resolve };
  waiting.set(event, entry);
  return Object.freeze({
    committed,
    cancel: () => {
      if (waiting.get(event) !== entry) return;
      waiting.delete(event);
      resolve(false);
    },
  });
}

/** Called by the existing canonical consumer only after its publication attempt. */
export function acknowledgeCanonicalRequestCommit(
  event: CanonicalRuntimeEvent,
  readCommitted?: () => CanonicalRuntimeEvent | undefined,
): void {
  const entry = waiting.get(event);
  if (!entry) return;
  waiting.delete(event);
  let committed = false;
  try {
    const stored = readCommitted?.();
    const expected = entry.expected;
    committed =
      stored?.method === 'request.opened' &&
      stored.eventId === expected.eventId &&
      stored.provider === expected.provider &&
      stored.threadId === expected.threadId &&
      stored.turnId === expected.turnId &&
      stored.requestId === expected.requestId &&
      stored.requestType === expected.requestType &&
      stored.title === expected.title &&
      stored.description === expected.description &&
      isDeepStrictEqual(stored.payload, expected.payload);
  } finally {
    entry.resolve(committed);
  }
}
