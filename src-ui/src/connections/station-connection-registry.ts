import { StationRequestAuthorityError } from '@kontourai/station-sdk/client';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import {
  type StationConnection,
  stationConnectionRuntimeKey,
} from './station-connection';

export type PreparedStationConnection = Omit<
  StationConnection,
  'runtimeKey'
> & {
  dispose(): void;
};

export interface StationConnectionLease {
  connection: StationConnection;
  release(): void;
}

interface Entry {
  connection: StationConnection;
  readers: Set<object>;
  dispose(): void;
}

const retirementListeners = new Map<string, Set<() => void>>();

export function onStationConnectionRetired(
  connection: Pick<StationConnection, 'runtimeKey'>,
  listener: () => void,
): () => void {
  let listeners = retirementListeners.get(connection.runtimeKey);
  if (!listeners) {
    listeners = new Set();
    retirementListeners.set(connection.runtimeKey, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) retirementListeners.delete(connection.runtimeKey);
  };
}

const authorityRegistries = new WeakMap<
  object,
  Set<StationConnectionRegistry>
>();

export function registerStationConnectionRegistry(
  queryClient: object,
  registry: StationConnectionRegistry,
): () => void {
  let registries = authorityRegistries.get(queryClient);
  if (!registries) {
    registries = new Set();
    authorityRegistries.set(queryClient, registries);
  }
  registries.add(registry);
  return () => {
    registry.retire();
    registries.delete(registry);
  };
}

export function retireStationConnectionRegistries(queryClient: object): void {
  for (const registry of authorityRegistries.get(queryClient) ?? [])
    registry.retire();
  authorityRegistries.delete(queryClient);
}

/** One registry per verified source authority, including its direct profiles. */
export class StationConnectionRegistry {
  private retired = false;
  private generation = 0;
  private readonly instanceId = randomCorrelationId();
  private readonly entries = new Map<string, Entry>();
  private readonly preparing = new Map<string, Promise<Entry>>();

  constructor(private readonly sourceIsCurrent: () => boolean) {}

  isCurrent(): boolean {
    return !this.retired && this.sourceIsCurrent();
  }

  async acquire(
    environmentId: string,
    prepare: () => Promise<PreparedStationConnection>,
  ): Promise<StationConnectionLease> {
    if (!this.isCurrent()) throw new StationRequestAuthorityError();
    let entry = this.entries.get(environmentId);
    if (entry && !entry.connection.isCurrent()) {
      this.entries.delete(environmentId);
      entry.dispose();
      entry = undefined;
    }
    if (!entry) {
      let pending = this.preparing.get(environmentId);
      if (!pending) {
        pending = this.prepare(environmentId, prepare);
        this.preparing.set(environmentId, pending);
      }
      try {
        entry = await pending;
      } finally {
        if (this.preparing.get(environmentId) === pending)
          this.preparing.delete(environmentId);
      }
    }
    if (!entry.connection.isCurrent()) throw new StationRequestAuthorityError();
    const reader = {};
    entry.readers.add(reader);
    const leasedEntry = entry;
    return {
      connection: {
        ...entry.connection,
        isCurrent: () =>
          leasedEntry.readers.has(reader) && leasedEntry.connection.isCurrent(),
      },
      release: () => {
        leasedEntry.readers.delete(reader);
        if (
          !leasedEntry.readers.size &&
          this.entries.get(environmentId) === leasedEntry
        ) {
          this.entries.delete(environmentId);
          leasedEntry.dispose();
        }
      },
    };
  }

  private async prepare(
    environmentId: string,
    prepare: () => Promise<PreparedStationConnection>,
  ): Promise<Entry> {
    const prepared = await prepare();
    if (
      !this.isCurrent() ||
      !prepared.isCurrent() ||
      prepared.environmentId !== environmentId
    ) {
      prepared.dispose();
      throw new StationRequestAuthorityError();
    }
    const { dispose, ...target } = prepared;
    const entry: Entry = {
      readers: new Set(),
      dispose: () => {
        for (const listener of retirementListeners.get(
          entry.connection.runtimeKey,
        ) ?? [])
          listener();
        retirementListeners.delete(entry.connection.runtimeKey);
        dispose();
      },
      connection: {
        ...target,
        requestScope: Object.freeze({ ...target.requestScope }),
        runtimeKey: stationConnectionRuntimeKey(
          target.targetApiBase,
          target.requestScope.authorityKey,
          `${this.instanceId}:${++this.generation}`,
        ),
        isCurrent: () =>
          this.isCurrent() &&
          this.entries.get(environmentId) === entry &&
          target.isCurrent(),
      },
    };
    this.entries.set(environmentId, entry);
    return entry;
  }

  retire(): void {
    if (this.retired) return;
    this.retired = true;
    for (const entry of this.entries.values()) entry.dispose();
    this.entries.clear();
  }
}
