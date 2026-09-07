/**
 * Durable, browser-local correlation for Starter Work task creation.
 *
 * An operation id is possible-effect evidence, not a cache: it is retained
 * until the same completed launch clears it. Consequently malformed data,
 * unavailable storage, capacity pressure, and a missing cross-document lock
 * all fail closed. This module never repairs, expires, or evicts a record.
 */

import { randomCorrelationId } from '@kontourai/station-shared/random-id';

export const STARTER_WORK_OPERATION_STORAGE_KEY =
  'station-starter-work-operations-v1';

const STARTER_WORK_OPERATION_LOCK_NAME = 'station-starter-work-operations-v1';
const SCHEMA_VERSION = 1;
const MAX_PROJECTS = 128;
const MAX_DOCUMENT_BYTES = 64 * 1024;
const MAX_PROJECT_ID_LENGTH = 4096;
const DEFAULT_LOCK_WAIT_TIMEOUT_MS = 5_000;
const utf8 = new TextEncoder();

const OPERATION_ID_PATTERN =
  /^task-create:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface StarterWorkOperationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The narrow Web Locks seam is injectable without exposing storage callers. */
export interface StarterWorkOperationExclusiveLock {
  request<T>(
    name: string,
    options: { mode: 'exclusive'; signal: AbortSignal },
    callback: () => Promise<T>,
  ): Promise<T>;
}

export type StarterWorkOperationRead =
  | { state: 'absent' }
  | { state: 'pending'; operationId: string }
  | { state: 'corrupt' }
  | { state: 'unavailable' };

export type StarterWorkOperationReservation =
  | { state: 'reserved'; operationId: string; reused: boolean }
  | { state: 'corrupt' }
  | { state: 'unavailable' };

export type StarterWorkOperationClearance =
  | { state: 'cleared' }
  | { state: 'stale' }
  | { state: 'corrupt' }
  | { state: 'unavailable' };

export interface StarterWorkOperationStore {
  read(projectId: string): StarterWorkOperationRead;
  reserve(projectId: string): Promise<StarterWorkOperationReservation>;
  clear(
    projectId: string,
    expectedOperationId: string,
  ): Promise<StarterWorkOperationClearance>;
}

export interface StarterWorkOperationStoreOptions {
  storage: StarterWorkOperationStorage;
  lock: StarterWorkOperationExclusiveLock | null;
  createUuid?: () => string;
  lockWaitTimeoutMs?: number;
}

interface StarterWorkOperationDocument {
  schemaVersion: 1;
  projects: StarterWorkOperationProjects;
}

type StarterWorkOperationProjects = Record<string, { operationId: string }>;

function emptyProjects(): StarterWorkOperationProjects {
  return Object.create(null) as StarterWorkOperationProjects;
}

function operationFor(
  projects: StarterWorkOperationProjects,
  projectId: string,
): { operationId: string } | undefined {
  return Object.hasOwn(projects, projectId) ? projects[projectId] : undefined;
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

function validProjectId(projectId: string): boolean {
  return (
    projectId.length > 0 &&
    projectId.length <= MAX_PROJECT_ID_LENGTH &&
    ![...projectId].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    }) &&
    projectId !== '__proto__' &&
    projectId !== 'prototype' &&
    projectId !== 'constructor'
  );
}

function validOperationId(operationId: unknown): operationId is string {
  return (
    typeof operationId === 'string' && OPERATION_ID_PATTERN.test(operationId)
  );
}

function parseDocument(
  raw: string | null,
): StarterWorkOperationDocument | null {
  if (raw === null) {
    return { schemaVersion: SCHEMA_VERSION, projects: emptyProjects() };
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
    !exactKeys(candidate, ['schemaVersion', 'projects']) ||
    candidate.schemaVersion !== SCHEMA_VERSION ||
    !isRecord(candidate.projects)
  ) {
    return null;
  }
  const projectEntries = Object.entries(candidate.projects);
  if (projectEntries.length > MAX_PROJECTS) return null;

  const projects = emptyProjects();
  for (const [projectId, project] of projectEntries) {
    if (
      !validProjectId(projectId) ||
      !isRecord(project) ||
      !exactKeys(project, ['operationId']) ||
      !validOperationId(project.operationId)
    ) {
      return null;
    }
    projects[projectId] = { operationId: project.operationId };
  }
  return { schemaVersion: SCHEMA_VERSION, projects };
}

function encodeDocument(document: StarterWorkOperationDocument): string | null {
  const encoded = JSON.stringify(document);
  return utf8.encode(encoded).byteLength <= MAX_DOCUMENT_BYTES ? encoded : null;
}

function browserLock(): StarterWorkOperationExclusiveLock {
  return {
    async request<T>(
      name: string,
      options: { mode: 'exclusive'; signal: AbortSignal },
      callback: () => Promise<T>,
    ): Promise<T> {
      const locks = (
        globalThis.navigator as
          | { locks?: StarterWorkOperationExclusiveLock }
          | undefined
      )?.locks;
      if (!locks || typeof locks.request !== 'function') {
        throw new Error('Web Locks is unavailable');
      }
      return locks.request(name, options, callback);
    },
  };
}

function browserStorage(): StarterWorkOperationStorage {
  return {
    getItem(key) {
      if (key !== STARTER_WORK_OPERATION_STORAGE_KEY) {
        throw new Error('Unexpected Starter Work storage key');
      }
      return window.localStorage.getItem(STARTER_WORK_OPERATION_STORAGE_KEY);
    },
    setItem(key, value) {
      if (key !== STARTER_WORK_OPERATION_STORAGE_KEY) {
        throw new Error('Unexpected Starter Work storage key');
      }
      window.localStorage.setItem(STARTER_WORK_OPERATION_STORAGE_KEY, value);
    },
    removeItem(key) {
      if (key !== STARTER_WORK_OPERATION_STORAGE_KEY) {
        throw new Error('Unexpected Starter Work storage key');
      }
      window.localStorage.removeItem(STARTER_WORK_OPERATION_STORAGE_KEY);
    },
  };
}

/** Browser-only composition seam. The factory above is the testable module. */
export function browserStarterWorkOperationStore(): StarterWorkOperationStore {
  if (typeof window === 'undefined') {
    return createStarterWorkOperationStore({
      storage: unavailableStorage,
      lock: null,
    });
  }
  return createStarterWorkOperationStore({
    storage: browserStorage(),
    lock: browserLock(),
  });
}

const unavailableStorage: StarterWorkOperationStorage = {
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

export function createStarterWorkOperationStore({
  storage,
  lock,
  createUuid = () => randomCorrelationId(),
  lockWaitTimeoutMs = DEFAULT_LOCK_WAIT_TIMEOUT_MS,
}: StarterWorkOperationStoreOptions): StarterWorkOperationStore {
  function read(projectId: string): StarterWorkOperationRead {
    if (!validProjectId(projectId)) return { state: 'corrupt' };
    let document: StarterWorkOperationDocument | null;
    try {
      document = parseDocument(
        storage.getItem(STARTER_WORK_OPERATION_STORAGE_KEY),
      );
    } catch {
      return { state: 'unavailable' };
    }
    if (!document) return { state: 'corrupt' };
    const operation = operationFor(document.projects, projectId);
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
          STARTER_WORK_OPERATION_LOCK_NAME,
          { mode: 'exclusive', signal: controller.signal },
          async () => {
            if (controller.signal.aborted) {
              throw new Error('Starter Work lock deadline elapsed');
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

    async reserve(projectId) {
      if (!validProjectId(projectId)) return { state: 'corrupt' };
      const result = await exclusively(async () => {
        const current = read(projectId);
        if (current.state === 'pending') {
          return {
            state: 'reserved' as const,
            operationId: current.operationId,
            reused: true,
          };
        }
        if (current.state !== 'absent') return current;

        const operationId = `task-create:${createUuid()}`;
        if (!validOperationId(operationId))
          return { state: 'unavailable' as const };

        let document: StarterWorkOperationDocument | null;
        try {
          document = parseDocument(
            storage.getItem(STARTER_WORK_OPERATION_STORAGE_KEY),
          );
        } catch {
          return { state: 'unavailable' as const };
        }
        if (!document) return { state: 'corrupt' as const };
        const existing = operationFor(document.projects, projectId);
        if (existing) {
          return {
            state: 'reserved' as const,
            operationId: existing.operationId,
            reused: true,
          };
        }
        if (Object.keys(document.projects).length >= MAX_PROJECTS) {
          return { state: 'unavailable' as const };
        }
        document.projects[projectId] = { operationId };
        const encoded = encodeDocument(document);
        if (!encoded) return { state: 'unavailable' as const };
        try {
          storage.setItem(STARTER_WORK_OPERATION_STORAGE_KEY, encoded);
        } catch {
          return { state: 'unavailable' as const };
        }
        const readback = read(projectId);
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

    async clear(projectId, expectedOperationId) {
      if (
        !validProjectId(projectId) ||
        !validOperationId(expectedOperationId)
      ) {
        return { state: 'stale' };
      }
      const result = await exclusively(async () => {
        const current = read(projectId);
        if (current.state === 'absent') return { state: 'stale' as const };
        if (current.state !== 'pending') return current;
        if (current.operationId !== expectedOperationId) {
          return { state: 'stale' as const };
        }

        let document: StarterWorkOperationDocument | null;
        try {
          document = parseDocument(
            storage.getItem(STARTER_WORK_OPERATION_STORAGE_KEY),
          );
        } catch {
          return { state: 'unavailable' as const };
        }
        if (!document) return { state: 'corrupt' as const };
        const operation = operationFor(document.projects, projectId);
        if (!operation || operation.operationId !== expectedOperationId) {
          return { state: 'stale' as const };
        }
        delete document.projects[projectId];
        try {
          if (Object.keys(document.projects).length === 0) {
            storage.removeItem(STARTER_WORK_OPERATION_STORAGE_KEY);
          } else {
            const encoded = encodeDocument(document);
            if (!encoded) return { state: 'unavailable' as const };
            storage.setItem(STARTER_WORK_OPERATION_STORAGE_KEY, encoded);
          }
        } catch {
          return { state: 'unavailable' as const };
        }
        const readback = read(projectId);
        if (readback.state === 'absent') return { state: 'cleared' as const };
        return readback.state === 'corrupt'
          ? { state: 'corrupt' as const }
          : { state: 'unavailable' as const };
      });
      return result ?? { state: 'unavailable' };
    },
  };
}
