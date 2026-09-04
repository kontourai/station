/** Process-local custody of actual SDK handles, not an integration or permission registry. */
import {
  type MCPConnection,
  type MCPManagerOptions,
  type MCPPreparedConnection,
  prepareMCPConnection,
} from './mcp.js';
import type { ToolDef } from './types.js';

export type MCPLocalPurpose =
  | 'managed'
  | 'probe'
  | 'app'
  | 'oauth'
  | 'native-control';
export interface MCPLocalCleanup {
  scope: 'local-sdk-handles';
  state: 'settled' | 'pending' | 'failed';
  retained: number;
}
export class MCPLocalCustodyError extends Error {
  constructor(readonly state: 'pending' | 'failed' | 'stale' | 'capacity') {
    super(
      `MCP local connection custody is ${state}; retry after local cleanup.`,
    );
    this.name = 'MCPLocalCustodyError';
  }
}
export interface MCPLocalClaim {
  isCurrent(): boolean;
  connect(def: ToolDef, options?: MCPManagerOptions): Promise<MCPConnection>;
  retainForOAuth(): void;
  finishAuth(params: URLSearchParams): Promise<void>;
  close(): Promise<void>;
  /** First-party alternate harness owns its SDK-specific fields behind this capability. */
  attach(resource: Pick<MCPPreparedConnection, 'close' | 'inspect'>): void;
}
type RecordEntry = {
  id: string;
  purpose: MCPLocalPurpose;
  current: boolean;
  resource?: Pick<MCPPreparedConnection, 'close' | 'inspect'>;
  claim: MCPLocalClaim;
};

export class MCPLocalConnectionCustody {
  private readonly records = new Set<RecordEntry>();
  private accepting = true;
  private stopped = false;
  private resetVersion = {};
  private readonly mutations = new Map<string, object>();
  constructor(
    private readonly options: { capacity?: number; waitMs?: number } = {},
  ) {
    if (
      !Number.isSafeInteger(options.capacity ?? 256) ||
      (options.capacity ?? 256) < 1 ||
      !Number.isSafeInteger(options.waitMs ?? 1000) ||
      (options.waitMs ?? 1000) < 1
    )
      throw new TypeError('Invalid local MCP custody bounds');
  }
  private prune() {
    for (const record of this.records) {
      if (record.resource?.inspect().phase === 'closed')
        this.records.delete(record);
    }
  }
  acquire(id: string, purpose: MCPLocalPurpose): MCPLocalClaim {
    this.prune();
    if (!this.accepting || this.mutations.has(id))
      throw new MCPLocalCustodyError('pending');
    if ([...this.records].some((record) => record.id === id && !record.current))
      throw new MCPLocalCustodyError('pending');
    if (this.records.size >= (this.options.capacity ?? 256))
      throw new MCPLocalCustodyError('capacity');
    let connection: Promise<MCPConnection> | undefined;
    let prepared: MCPPreparedConnection | undefined;
    const record = { id, purpose, current: true } as RecordEntry;
    const isCurrent = () =>
      record.current &&
      this.accepting &&
      !this.mutations.has(id) &&
      this.records.has(record);
    const assertCurrent = () => {
      if (!isCurrent()) throw new MCPLocalCustodyError('stale');
    };
    const claim: MCPLocalClaim = {
      isCurrent,
      connect: (def, options) => {
        assertCurrent();
        if (connection) return connection;
        if (record.resource) throw new MCPLocalCustodyError('stale');
        if (def.id !== id) throw new MCPLocalCustodyError('stale');
        // The record is already retained before constructing the resource
        // handle or invoking its constructor/connect/discovery effects.
        prepared = prepareMCPConnection(def, options, isCurrent);
        record.resource = prepared;
        connection = Promise.resolve()
          .then(() => prepared!.connect())
          .then((value) => {
            assertCurrent();
            return { ...value, close: claim.close, disconnect: claim.close };
          });
        return connection;
      },
      retainForOAuth: () => {
        assertCurrent();
        if (!prepared) throw new MCPLocalCustodyError('stale');
        prepared.retainForOAuth();
        record.purpose = 'oauth';
      },
      finishAuth: async (params) => {
        assertCurrent();
        if (!prepared) throw new MCPLocalCustodyError('stale');
        await prepared.finishAuth(params);
        assertCurrent();
      },
      close: async () => {
        record.current = false; // Fence before waiting, even without a client yet.
        if (record.resource) await record.resource.close();
        this.records.delete(record);
      },
      attach: (resource) => {
        assertCurrent();
        if (record.resource) throw new MCPLocalCustodyError('stale');
        record.resource = resource;
      },
    };
    record.claim = claim;
    this.records.add(record);
    return claim;
  }
  /** Redacted local observation. No argv, endpoint, identifiers or credentials. */
  inspect() {
    this.prune();
    const phases: Record<string, number> = {};
    for (const record of this.records) {
      const phase = record.resource?.inspect().phase ?? 'reserved';
      phases[phase] = (phases[phase] ?? 0) + 1;
    }
    return {
      scope: 'local-sdk-handles' as const,
      accepting: this.accepting,
      retained: this.records.size,
      phases,
    };
  }
  private async settle(records: RecordEntry[]): Promise<MCPLocalCleanup> {
    const closes = records.map((record) => record.claim.close());
    // Keep each original close under the retained record. A bounded caller
    // return never converts a pending SDK operation into a settled resource.
    const settlement = Promise.allSettled(closes);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      settlement,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.options.waitMs ?? 1000);
      }),
    ]);
    clearTimeout(timer);
    this.prune();
    const retained = records.filter((record) => this.records.has(record));
    return {
      scope: 'local-sdk-handles',
      state: retained.some(
        (record) => record.resource?.inspect().phase === 'close-failed',
      )
        ? 'failed'
        : retained.length
          ? 'pending'
          : 'settled',
      retained: retained.length,
    };
  }
  /** Bounded caller return; the owner retains an unresolved original close. */
  async release(claim: MCPLocalClaim): Promise<MCPLocalCleanup> {
    return this.settle(
      [...this.records].filter((record) => record.claim === claim),
    );
  }
  async releaseClaims(
    claims: readonly MCPLocalClaim[],
  ): Promise<MCPLocalCleanup> {
    const selected = new Set(claims);
    return this.settle(
      [...this.records].filter((record) => selected.has(record.claim)),
    );
  }
  /** Stays admission-closed while any old local handle remains outstanding. */
  async reset(afterSettled?: () => void): Promise<MCPLocalCleanup> {
    const version = {};
    this.resetVersion = version;
    this.accepting = false;
    const records = [...this.records];
    for (const record of records) record.current = false;
    const outcome = await this.settle(records);
    if (
      outcome.state === 'settled' &&
      this.resetVersion === version &&
      !this.stopped
    ) {
      afterSettled?.();
      this.accepting = true;
    }
    return outcome;
  }
  async shutdown(): Promise<MCPLocalCleanup> {
    this.stopped = true;
    return this.reset();
  }
  /** Identity-changing local config writes cannot race old OAuth/token work. */
  async mutate<T>(id: string, operation: () => Promise<T>): Promise<T> {
    if (!this.accepting || this.stopped || this.mutations.has(id))
      throw new MCPLocalCustodyError('pending');
    const token = {};
    this.mutations.set(id, token);
    const records = [...this.records].filter((record) => record.id === id);
    for (const record of records) record.current = false;
    try {
      const cleanup = await this.settle(records);
      if (cleanup.state !== 'settled')
        throw new MCPLocalCustodyError(cleanup.state);
      return await operation();
    } finally {
      if (this.mutations.get(id) === token) this.mutations.delete(id);
    }
  }
}
