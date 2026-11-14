/**
 * What Station keeps about remote task engines, none of it secret:
 *
 * - `<home>/remote-task-engines/connections.json`: each connection's vendor,
 *   label, non-secret settings, polling and acknowledgement.
 * - `<home>/remote-task-engines/tasks/<connectionId>/<digest>.json`: one file
 *   per task Station created or synced: the last snapshot, the vendor cursor,
 *   the vendor event ids already stored, and the stored messages with
 *   Station's own sequence. One file, written whole, so a cursor is never
 *   saved without the messages it covers: after a crash the same page is
 *   read again, and the stored ids drop what was already kept.
 *
 * Credentials are in the engine vault (`credentials.ts`), never here.
 */
import { createHash } from 'node:crypto';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  isRemoteTaskVendorId,
  type RemoteTask,
  type RemoteTaskAcknowledgement,
  type RemoteTaskEvent,
  type RemoteTaskPolling,
  type RemoteTaskStoredEvent,
  type RemoteTaskVendorId,
  remoteTaskPollingProblems,
} from '@kontourai/station-contracts/remote-task-engine';
import {
  mutateJsonFile,
  readJsonFile,
} from '@kontourai/station-shared/json-file-storage';

export interface RemoteTaskConnectionRecord {
  readonly id: string;
  readonly vendor: RemoteTaskVendorId;
  readonly label: string;
  readonly settings: Readonly<Record<string, string>>;
  readonly polling: RemoteTaskPolling;
  readonly acknowledgement: RemoteTaskAcknowledgement | null;
  readonly createdAt: string;
}

interface ConnectionsDocument {
  version: 1;
  connections: RemoteTaskConnectionRecord[];
}

const CONNECTIONS_MAX_BYTES = 1024 * 1024;
const TASK_MAX_BYTES = 8 * 1024 * 1024;
/** Stored messages per task; the oldest are dropped past it. */
const REMOTE_TASK_STORED_EVENTS_MAX = 2000;
/** Vendor ids remembered for de-duplication, newest kept. */
const SEEN_IDS_MAX = 4000;

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readConnection(value: unknown): RemoteTaskConnectionRecord | null {
  if (!isRecordValue(value)) return null;
  const { id, vendor, label, settings, polling, acknowledgement, createdAt } =
    value;
  if (
    typeof id !== 'string' ||
    !isRemoteTaskVendorId(vendor) ||
    typeof label !== 'string' ||
    !isRecordValue(settings) ||
    !Object.values(settings).every((entry) => typeof entry === 'string') ||
    remoteTaskPollingProblems(polling).length > 0 ||
    typeof createdAt !== 'string'
  )
    return null;
  const ack =
    isRecordValue(acknowledgement) &&
    acknowledgement.vendor === vendor &&
    typeof acknowledgement.version === 'number' &&
    typeof acknowledgement.statement === 'string' &&
    typeof acknowledgement.acknowledgedAt === 'string'
      ? (acknowledgement as unknown as RemoteTaskAcknowledgement)
      : null;
  return {
    id,
    vendor,
    label,
    settings: settings as Record<string, string>,
    polling: polling as RemoteTaskPolling,
    acknowledgement: ack,
    createdAt,
  };
}

export class RemoteTaskConnectionStore {
  readonly #path: string;

  constructor(homeDir: string) {
    this.#path = join(homeDir, 'remote-task-engines', 'connections.json');
  }

  #read(document: unknown): RemoteTaskConnectionRecord[] {
    if (!isRecordValue(document) || !Array.isArray(document.connections))
      return [];
    return document.connections.flatMap((entry) => {
      const record = readConnection(entry);
      return record ? [record] : [];
    });
  }

  list(): RemoteTaskConnectionRecord[] {
    return this.#read(
      readJsonFile<unknown>(this.#path, null, {
        maxBytes: CONNECTIONS_MAX_BYTES,
        label: 'remote task connections',
      }),
    );
  }

  get(id: string): RemoteTaskConnectionRecord | undefined {
    return this.list().find((entry) => entry.id === id);
  }

  /**
   * Replace the connection `id` with what `update` returns (undefined:
   * remove it). `update` sees undefined for a new id.
   */
  async mutate(
    id: string,
    update: (
      current: RemoteTaskConnectionRecord | undefined,
    ) => RemoteTaskConnectionRecord | undefined,
  ): Promise<RemoteTaskConnectionRecord | undefined> {
    let result: RemoteTaskConnectionRecord | undefined;
    await mutateJsonFile<unknown>(
      this.#path,
      null,
      (document) => {
        const connections = this.#read(document);
        const index = connections.findIndex((entry) => entry.id === id);
        result = update(index === -1 ? undefined : connections[index]);
        const next = connections.filter((entry) => entry.id !== id);
        if (result) next.splice(index === -1 ? next.length : index, 0, result);
        return { version: 1, connections: next } satisfies ConnectionsDocument;
      },
      { maxBytes: CONNECTIONS_MAX_BYTES, label: 'remote task connections' },
    );
    return result;
  }
}

// --- tasks ---------------------------------------------------------------------

export interface RemoteTaskRecord {
  readonly connectionId: string;
  readonly taskId: string;
  readonly snapshot: RemoteTask | null;
  /** The vendor cursor the next page reads from. */
  readonly vendorCursor: string | null;
  readonly seenIds: readonly string[];
  readonly nextSequence: number;
  readonly events: readonly RemoteTaskStoredEvent[];
  /** `active`: the tracker polls it. `quiescent`: it waits for a sync. */
  readonly tracking: 'active' | 'quiescent';
  /** Usage was read after the task stopped working (vendors that report it apart). */
  readonly usageSettled: boolean;
}

function emptyTask(connectionId: string, taskId: string): RemoteTaskRecord {
  return {
    connectionId,
    taskId,
    snapshot: null,
    vendorCursor: null,
    seenIds: [],
    nextSequence: 1,
    events: [],
    tracking: 'active',
    usageSettled: false,
  };
}

/**
 * `record` with `events` appended: ids already seen are dropped (a replayed
 * page, or a vendor that resends an event after reconnect), the rest get the
 * next sequence numbers in order.
 */
export function appendRemoteTaskEvents(
  record: RemoteTaskRecord,
  events: readonly RemoteTaskEvent[],
): { record: RemoteTaskRecord; appended: RemoteTaskStoredEvent[] } {
  const seen = new Set(record.seenIds);
  const appended: RemoteTaskStoredEvent[] = [];
  let sequence = record.nextSequence;
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    appended.push({ ...event, sequence });
    sequence += 1;
  }
  if (appended.length === 0) return { record, appended };
  const ids = [...record.seenIds, ...appended.map((event) => event.id)];
  const stored = [...record.events, ...appended];
  return {
    record: {
      ...record,
      seenIds: ids.slice(Math.max(0, ids.length - SEEN_IDS_MAX)),
      nextSequence: sequence,
      events: stored.slice(
        Math.max(0, stored.length - REMOTE_TASK_STORED_EVENTS_MAX),
      ),
    },
    appended,
  };
}

export class RemoteTaskStore {
  readonly #root: string;

  constructor(homeDir: string) {
    this.#root = join(homeDir, 'remote-task-engines', 'tasks');
  }

  #path(connectionId: string, taskId: string): string {
    const digest = createHash('sha256').update(taskId).digest('hex');
    return join(this.#root, connectionId, `${digest.slice(0, 40)}.json`);
  }

  get(connectionId: string, taskId: string): RemoteTaskRecord | undefined {
    const value = readJsonFile<RemoteTaskRecord | null>(
      this.#path(connectionId, taskId),
      null,
      { maxBytes: TASK_MAX_BYTES, label: 'remote task' },
    );
    return value && value.taskId === taskId ? value : undefined;
  }

  async mutate(
    connectionId: string,
    taskId: string,
    update: (current: RemoteTaskRecord) => RemoteTaskRecord,
  ): Promise<RemoteTaskRecord> {
    return mutateJsonFile<RemoteTaskRecord>(
      this.#path(connectionId, taskId),
      emptyTask(connectionId, taskId),
      (current) =>
        update(
          current && current.taskId === taskId
            ? current
            : emptyTask(connectionId, taskId),
        ),
      { maxBytes: TASK_MAX_BYTES, label: 'remote task' },
    );
  }

  /** Every stored task of every connection, for resuming after a restart. */
  listAll(): RemoteTaskRecord[] {
    let connections: string[];
    try {
      connections = readdirSync(this.#root);
    } catch {
      return [];
    }
    const records: RemoteTaskRecord[] = [];
    for (const connectionId of connections) {
      let files: string[];
      try {
        files = readdirSync(join(this.#root, connectionId));
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const value = readJsonFile<RemoteTaskRecord | null>(
          join(this.#root, connectionId, file),
          null,
          { maxBytes: TASK_MAX_BYTES, label: 'remote task' },
        );
        if (value && typeof value.taskId === 'string') records.push(value);
      }
    }
    return records;
  }

  removeConnection(connectionId: string): void {
    rmSync(join(this.#root, connectionId), { recursive: true, force: true });
  }
}
