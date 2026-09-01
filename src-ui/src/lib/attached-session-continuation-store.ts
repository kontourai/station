/**
 * Durable, browser-local possible-effect evidence for Attached Session
 * continuations. A reservation remains until the same completed continuation
 * clears it. Corrupt or unavailable storage and missing cross-document
 * exclusion fail closed: this adapter neither repairs nor evicts evidence.
 */

import { randomCorrelationId } from '@kontourai/station-shared/random-id';

export const ATTACHED_SESSION_CONTINUATION_STORAGE_KEY =
  'station-attached-session-continuations-v1';

const ATTACHED_SESSION_CONTINUATION_LOCK_NAME =
  'station-attached-session-continuations-v1';
const SCHEMA_VERSION = 1;
const MAX_SESSIONS = 128;
const MAX_DOCUMENT_BYTES = 64 * 1024;
const MAX_SESSION_ID_LENGTH = 4096;
const DEFAULT_LOCK_WAIT_TIMEOUT_MS = 5_000;
const utf8 = new TextEncoder();

const OPERATION_ID_PATTERN =
  /^starter-session:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface AttachedSessionContinuationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The narrow Web Locks seam is injectable without exposing storage callers. */
export interface AttachedSessionContinuationExclusiveLock {
  request<T>(
    name: string,
    options: { mode: 'exclusive'; signal: AbortSignal },
    callback: () => Promise<T>,
  ): Promise<T>;
}

export type AttachedSessionContinuationRead =
  | { state: 'absent' }
  | { state: 'pending'; operationId: string }
  | { state: 'corrupt' }
  | { state: 'unavailable' };

export type AttachedSessionContinuationReservation =
  | { state: 'reserved'; operationId: string; reused: boolean }
  | { state: 'corrupt' }
  | { state: 'unavailable' };

export type AttachedSessionContinuationClearance =
  | { state: 'cleared' }
  | { state: 'stale' }
  | { state: 'corrupt' }
  | { state: 'unavailable' };

export interface AttachedSessionContinuationStore {
  read(sessionId: string): AttachedSessionContinuationRead;
  reserve(sessionId: string): Promise<AttachedSessionContinuationReservation>;
  clear(
    sessionId: string,
    expectedOperationId: string,
  ): Promise<AttachedSessionContinuationClearance>;
}

export interface AttachedSessionContinuationStoreOptions {
  storage: AttachedSessionContinuationStorage;
  lock: AttachedSessionContinuationExclusiveLock | null;
  createUuid?: () => string;
  lockWaitTimeoutMs?: number;
}

interface AttachedSessionContinuationDocument {
  schemaVersion: 1;
  sessions: AttachedSessionContinuations;
}

type AttachedSessionContinuations = Record<string, { operationId: string }>;

function emptySessions(): AttachedSessionContinuations {
  return Object.create(null) as AttachedSessionContinuations;
}

function operationFor(
  sessions: AttachedSessionContinuations,
  sessionId: string,
): { operationId: string } | undefined {
  return Object.hasOwn(sessions, sessionId) ? sessions[sessionId] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && actual.every((key) => keys.includes(key))
  );
}

function validSessionId(sessionId: string): boolean {
  return (
    sessionId.length > 0 &&
    sessionId.length <= MAX_SESSION_ID_LENGTH &&
    ![...sessionId].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    }) &&
    sessionId !== '__proto__' &&
    sessionId !== 'prototype' &&
    sessionId !== 'constructor'
  );
}

function validOperationId(operationId: unknown): operationId is string {
  return (
    typeof operationId === 'string' && OPERATION_ID_PATTERN.test(operationId)
  );
}

function parseDocument(
  raw: string | null,
): AttachedSessionContinuationDocument | null {
  if (raw === null) {
    return { schemaVersion: SCHEMA_VERSION, sessions: emptySessions() };
  }
  if (utf8.encode(raw).byteLength > MAX_DOCUMENT_BYTES) return null;

  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !isRecord(candidate) ||
    !exactKeys(candidate, ['schemaVersion', 'sessions']) ||
    candidate.schemaVersion !== SCHEMA_VERSION ||
    !isRecord(candidate.sessions)
  ) {
    return null;
  }
  const sessionEntries = Object.entries(candidate.sessions);
  if (sessionEntries.length > MAX_SESSIONS) return null;

  const sessions = emptySessions();
  for (const [sessionId, session] of sessionEntries) {
    if (
      !validSessionId(sessionId) ||
      !isRecord(session) ||
      !exactKeys(session, ['operationId']) ||
      !validOperationId(session.operationId)
    ) {
      return null;
    }
    sessions[sessionId] = { operationId: session.operationId };
  }
  return { schemaVersion: SCHEMA_VERSION, sessions };
}

function encodeDocument(
  document: AttachedSessionContinuationDocument,
): string | null {
  const encoded = JSON.stringify(document);
  return utf8.encode(encoded).byteLength <= MAX_DOCUMENT_BYTES ? encoded : null;
}

function browserLock(): AttachedSessionContinuationExclusiveLock {
  return {
    async request<T>(
      name: string,
      options: { mode: 'exclusive'; signal: AbortSignal },
      callback: () => Promise<T>,
    ): Promise<T> {
      const locks = (
        globalThis.navigator as
          | { locks?: AttachedSessionContinuationExclusiveLock }
          | undefined
      )?.locks;
      if (!locks || typeof locks.request !== 'function') {
        throw new Error('Web Locks is unavailable');
      }
      return locks.request(name, options, callback);
    },
  };
}

function browserStorage(): AttachedSessionContinuationStorage {
  return {
    getItem(key) {
      if (key !== ATTACHED_SESSION_CONTINUATION_STORAGE_KEY) {
        throw new Error('Unexpected Attached Session continuation storage key');
      }
      return window.localStorage.getItem(
        ATTACHED_SESSION_CONTINUATION_STORAGE_KEY,
      );
    },
    setItem(key, value) {
      if (key !== ATTACHED_SESSION_CONTINUATION_STORAGE_KEY) {
        throw new Error('Unexpected Attached Session continuation storage key');
      }
      window.localStorage.setItem(
        ATTACHED_SESSION_CONTINUATION_STORAGE_KEY,
        value,
      );
    },
    removeItem(key) {
      if (key !== ATTACHED_SESSION_CONTINUATION_STORAGE_KEY) {
        throw new Error('Unexpected Attached Session continuation storage key');
      }
      window.localStorage.removeItem(ATTACHED_SESSION_CONTINUATION_STORAGE_KEY);
    },
  };
}

const unavailableStorage: AttachedSessionContinuationStorage = {
  getItem() {
    throw new Error('Storage is unavailable');
  },
  setItem() {
    throw new Error('Storage is unavailable');
  },
  removeItem() {
    throw new Error('Storage is unavailable');
  },
};

/** Browser-only composition seam. The factory is the testable module. */
export function browserAttachedSessionContinuationStore(): AttachedSessionContinuationStore {
  if (typeof window === 'undefined') {
    return createAttachedSessionContinuationStore({
      storage: unavailableStorage,
      lock: null,
    });
  }
  return createAttachedSessionContinuationStore({
    storage: browserStorage(),
    lock: browserLock(),
  });
}

export function createAttachedSessionContinuationStore({
  storage,
  lock,
  createUuid = () => randomCorrelationId(),
  lockWaitTimeoutMs = DEFAULT_LOCK_WAIT_TIMEOUT_MS,
}: AttachedSessionContinuationStoreOptions): AttachedSessionContinuationStore {
  function read(sessionId: string): AttachedSessionContinuationRead {
    if (!validSessionId(sessionId)) return { state: 'corrupt' };
    let document: AttachedSessionContinuationDocument | null;
    try {
      document = parseDocument(
        storage.getItem(ATTACHED_SESSION_CONTINUATION_STORAGE_KEY),
      );
    } catch {
      return { state: 'unavailable' };
    }
    if (!document) return { state: 'corrupt' };
    const operation = operationFor(document.sessions, sessionId);
    return operation
      ? { state: 'pending', operationId: operation.operationId }
      : { state: 'absent' };
  }

  async function exclusively<T>(
    operation: () => Promise<T>,
  ): Promise<T | null> {
    if (!lock) return null;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const locked = lock
        .request(
          ATTACHED_SESSION_CONTINUATION_LOCK_NAME,
          { mode: 'exclusive', signal: controller.signal },
          async () => {
            if (controller.signal.aborted) {
              throw new Error(
                'Attached Session continuation lock deadline elapsed',
              );
            }
            return operation();
          },
        )
        .then(
          (value) => ({ state: 'completed' as const, value }),
          () => ({ state: 'failed' as const }),
        );
      const deadline = new Promise<{ state: 'timed-out' }>((resolve) => {
        timeout = setTimeout(() => {
          controller.abort('deadline');
          resolve({ state: 'timed-out' });
        }, lockWaitTimeoutMs);
      });
      const result = await Promise.race([locked, deadline]);
      return result.state === 'completed' ? result.value : null;
    } catch {
      return null;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  return {
    read,

    async reserve(sessionId) {
      if (!validSessionId(sessionId)) return { state: 'corrupt' };
      const result = await exclusively(async () => {
        const current = read(sessionId);
        if (current.state === 'pending') {
          return {
            state: 'reserved' as const,
            operationId: current.operationId,
            reused: true,
          };
        }
        if (current.state !== 'absent') return current;

        const operationId = `starter-session:${createUuid()}`;
        if (!validOperationId(operationId))
          return { state: 'unavailable' as const };

        let document: AttachedSessionContinuationDocument | null;
        try {
          document = parseDocument(
            storage.getItem(ATTACHED_SESSION_CONTINUATION_STORAGE_KEY),
          );
        } catch {
          return { state: 'unavailable' as const };
        }
        if (!document) return { state: 'corrupt' as const };
        const existing = operationFor(document.sessions, sessionId);
        if (existing) {
          return {
            state: 'reserved' as const,
            operationId: existing.operationId,
            reused: true,
          };
        }
        if (Object.keys(document.sessions).length >= MAX_SESSIONS) {
          return { state: 'unavailable' as const };
        }
        document.sessions[sessionId] = { operationId };
        const encoded = encodeDocument(document);
        if (!encoded) return { state: 'unavailable' as const };
        try {
          storage.setItem(ATTACHED_SESSION_CONTINUATION_STORAGE_KEY, encoded);
        } catch {
          return { state: 'unavailable' as const };
        }
        const readback = read(sessionId);
        if (
          readback.state !== 'pending' ||
          readback.operationId !== operationId
        ) {
          return readback.state === 'corrupt'
            ? { state: 'corrupt' as const }
            : { state: 'unavailable' as const };
        }
        return { state: 'reserved' as const, operationId, reused: false };
      });
      return result ?? { state: 'unavailable' };
    },

    async clear(sessionId, expectedOperationId) {
      if (
        !validSessionId(sessionId) ||
        !validOperationId(expectedOperationId)
      ) {
        return { state: 'stale' };
      }
      const result = await exclusively(async () => {
        const current = read(sessionId);
        if (current.state === 'absent') return { state: 'stale' as const };
        if (current.state !== 'pending') return current;
        if (current.operationId !== expectedOperationId)
          return { state: 'stale' as const };

        let document: AttachedSessionContinuationDocument | null;
        try {
          document = parseDocument(
            storage.getItem(ATTACHED_SESSION_CONTINUATION_STORAGE_KEY),
          );
        } catch {
          return { state: 'unavailable' as const };
        }
        if (!document) return { state: 'corrupt' as const };
        const operation = operationFor(document.sessions, sessionId);
        if (!operation || operation.operationId !== expectedOperationId) {
          return { state: 'stale' as const };
        }
        delete document.sessions[sessionId];
        try {
          if (Object.keys(document.sessions).length === 0) {
            storage.removeItem(ATTACHED_SESSION_CONTINUATION_STORAGE_KEY);
          } else {
            const encoded = encodeDocument(document);
            if (!encoded) return { state: 'unavailable' as const };
            storage.setItem(ATTACHED_SESSION_CONTINUATION_STORAGE_KEY, encoded);
          }
        } catch {
          return { state: 'unavailable' as const };
        }
        const readback = read(sessionId);
        if (readback.state === 'absent') return { state: 'cleared' as const };
        return readback.state === 'corrupt'
          ? { state: 'corrupt' as const }
          : { state: 'unavailable' as const };
      });
      return result ?? { state: 'unavailable' };
    },
  };
}
