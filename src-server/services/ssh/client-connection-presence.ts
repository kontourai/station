/** Process-local, non-durable paired-device SSE liveness. */
export const CLIENT_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const CLIENT_CONNECTION_LEASE_MS = 90_000;
export const CLIENT_CONNECTION_CAPACITY = 256;
export const CLIENT_CONNECTIONS_PER_DEVICE_CAPACITY = 32;

export interface ConnectedClientSnapshot {
  readonly deviceId: string;
  readonly sessionCount: number;
  readonly connectedAt: number;
  readonly lastSeenAt: number;
  readonly transports: readonly ['events-sse'];
}
interface PresenceRecord {
  refs: number;
  connectedAt: number;
  lastSeenAt: number;
  invalidated: boolean;
}
export interface ClientConnectionPresenceOptions {
  readonly now?: () => number;
  readonly leaseMs?: number;
  readonly capacity?: number;
  readonly perDeviceCapacity?: number;
  readonly record?: (
    op: 'connect' | 'disconnect' | 'expire' | 'capacity',
  ) => void;
}
export interface ClientConnectionLease {
  touch(): void;
  release(): void;
}

/** Bounded, reference-counted presence keyed by device and document UUID. */
export class ClientConnectionPresence {
  readonly #sessions = new Map<string, Map<string, PresenceRecord>>();
  readonly #now: () => number;
  readonly #leaseMs: number;
  readonly #capacity: number;
  readonly #perDeviceCapacity: number;
  readonly #record: NonNullable<ClientConnectionPresenceOptions['record']>;

  constructor(options: ClientConnectionPresenceOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#leaseMs = options.leaseMs ?? CLIENT_CONNECTION_LEASE_MS;
    this.#capacity = options.capacity ?? CLIENT_CONNECTION_CAPACITY;
    this.#perDeviceCapacity =
      options.perDeviceCapacity ?? CLIENT_CONNECTIONS_PER_DEVICE_CAPACITY;
    this.#record = options.record ?? (() => {});
  }

  connect(
    deviceId: string,
    clientSessionId: string,
  ): ClientConnectionLease | undefined {
    if (!CLIENT_SESSION_ID_PATTERN.test(clientSessionId)) return undefined;
    this.#expire();
    let sessions = this.#sessions.get(deviceId);
    const existing = sessions?.get(clientSessionId);
    if (existing) {
      existing.refs += 1;
      return this.#lease(deviceId, clientSessionId, existing);
    }
    if (sessions && sessions.size >= this.#perDeviceCapacity) {
      this.#record('capacity');
      return undefined;
    }
    if (this.#size() >= this.#capacity) {
      this.#record('capacity');
      return undefined;
    }
    if (!sessions) {
      sessions = new Map();
      this.#sessions.set(deviceId, sessions);
    }
    const now = this.#now();
    const entry = {
      refs: 1,
      connectedAt: now,
      lastSeenAt: now,
      invalidated: false,
    };
    sessions.set(clientSessionId, entry);
    this.#record('connect');
    return this.#lease(deviceId, clientSessionId, entry);
  }

  /** Revocation invalidates every outstanding lease for the exact device. */
  disconnectDevice(deviceId: string): void {
    const sessions = this.#sessions.get(deviceId);
    if (!sessions) return;
    for (const entry of sessions.values()) entry.invalidated = true;
    this.#sessions.delete(deviceId);
    this.#record('disconnect');
  }

  snapshot(
    deviceIds: readonly string[],
  ): ReadonlyMap<string, ConnectedClientSnapshot> {
    this.#expire();
    const result = new Map<string, ConnectedClientSnapshot>();
    for (const deviceId of deviceIds) {
      const entries = [...(this.#sessions.get(deviceId)?.values() ?? [])];
      if (!entries.length) continue;
      result.set(deviceId, {
        deviceId,
        sessionCount: entries.length,
        connectedAt: Math.min(...entries.map((entry) => entry.connectedAt)),
        lastSeenAt: Math.max(...entries.map((entry) => entry.lastSeenAt)),
        transports: ['events-sse'],
      });
    }
    return result;
  }

  #lease(
    deviceId: string,
    clientSessionId: string,
    entry: PresenceRecord,
  ): ClientConnectionLease {
    let released = false;
    return {
      touch: () => {
        if (released || entry.invalidated) return;
        const current = this.#sessions.get(deviceId)?.get(clientSessionId);
        if (current === entry) {
          current.lastSeenAt = this.#now();
          return;
        }
        // A later connection already replaced this expired record. An old
        // stream cannot refresh or delete the newer session's truth.
        if (current || entry.refs <= 0) return;
        if (this.#size() >= this.#capacity) {
          this.#record('capacity');
          return;
        }
        const sessions = this.#sessions.get(deviceId) ?? new Map();
        if (sessions.size >= this.#perDeviceCapacity) {
          this.#record('capacity');
          return;
        }
        this.#sessions.set(deviceId, sessions);
        const now = this.#now();
        entry.connectedAt = now;
        entry.lastSeenAt = now;
        sessions.set(clientSessionId, entry);
        this.#record('connect');
      },
      release: () => {
        if (released) return;
        released = true;
        if (entry.refs > 0) entry.refs -= 1;
        const sessions = this.#sessions.get(deviceId);
        const current = sessions?.get(clientSessionId);
        if (current !== entry || entry.refs > 0) return;
        sessions?.delete(clientSessionId);
        if (!sessions?.size) this.#sessions.delete(deviceId);
        this.#record('disconnect');
      },
    };
  }

  #size(): number {
    let total = 0;
    for (const sessions of this.#sessions.values()) total += sessions.size;
    return total;
  }

  #expire(): void {
    const cutoff = this.#now() - this.#leaseMs;
    for (const [deviceId, sessions] of this.#sessions) {
      for (const [sessionId, entry] of sessions) {
        if (entry.lastSeenAt < cutoff) {
          entry.invalidated = true;
          sessions.delete(sessionId);
          this.#record('expire');
        }
      }
      if (!sessions.size) this.#sessions.delete(deviceId);
    }
  }
}
