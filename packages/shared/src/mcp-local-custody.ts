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
export interface MCPDefinitionAdmission {
  isCurrent(): boolean;
  enter(): void;
  settle(started: boolean): void;
}
const definitionAdmission = Symbol('Station captured package admission');
type AdmittedDefinition = ToolDef & {
  [definitionAdmission]?: (purpose: MCPLocalPurpose) => MCPDefinitionAdmission;
};
/** First-party loader capability; a JSON ToolDef cannot forge this symbol.
 * Enumerable symbol ownership survives the ordinary secret-env object spread. */
export function bindMCPDefinitionAdmission(
  def: ToolDef,
  admit: (purpose: MCPLocalPurpose) => MCPDefinitionAdmission,
): ToolDef {
  return Object.assign(def, { [definitionAdmission]: admit });
}
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
  /** Own first-party continuation effects; release the claim outside this scope. */
  run<T>(operation: () => Promise<T>): Promise<T>;
  connect(def: ToolDef, options?: MCPManagerOptions): Promise<MCPConnection>;
  retainForOAuth(): void;
  finishAuth(params: URLSearchParams): Promise<void>;
  close(): Promise<void>;
  /** First-party alternate harness owns its SDK-specific fields behind this capability. */
  attach(
    resource: Pick<MCPPreparedConnection, 'close' | 'inspect'>,
    definition?: ToolDef,
  ): void;
}
type RecordEntry = {
  id: string;
  purpose: MCPLocalPurpose;
  current: boolean;
  pending: Set<Promise<unknown>>;
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
      if (
        record.resource?.inspect().phase === 'closed' &&
        record.pending.size === 0
      )
        this.records.delete(record);
    }
  }
  acquire(
    id: string,
    purpose: MCPLocalPurpose,
    definition?: ToolDef,
  ): MCPLocalClaim {
    this.prune();
    if (!this.accepting || this.mutations.has(id))
      throw new MCPLocalCustodyError('pending');
    if ([...this.records].some((record) => record.id === id && !record.current))
      throw new MCPLocalCustodyError('pending');
    if (this.records.size >= (this.options.capacity ?? 256))
      throw new MCPLocalCustodyError('capacity');
    let connection: Promise<MCPConnection> | undefined;
    let prepared: MCPPreparedConnection | undefined;
    let admission: MCPDefinitionAdmission | undefined;
    let effectStarted = false;
    const bind = (def: ToolDef) => {
      if (!admission)
        admission = (def as AdmittedDefinition)[definitionAdmission]?.(purpose);
    };
    if (definition) bind(definition);
    const enter = () => {
      if (effectStarted) return;
      admission?.enter();
      effectStarted = true;
    };
    const record = {
      id,
      purpose,
      current: true,
      pending: new Set<Promise<unknown>>(),
    } as RecordEntry;
    const isCurrent = () =>
      record.current &&
      this.accepting &&
      !this.mutations.has(id) &&
      (admission?.isCurrent() ?? true) &&
      this.records.has(record);
    const assertCurrent = () => {
      if (!isCurrent()) throw new MCPLocalCustodyError('stale');
    };
    const claim: MCPLocalClaim = {
      isCurrent,
      run: <T>(operation: () => Promise<T>): Promise<T> => {
        assertCurrent();
        // Reserve and retain the actual promise before invoking any caller
        // effect. SDK closure alone cannot settle a credential continuation.
        const running = Promise.resolve()
          .then(() => {
            assertCurrent();
            return operation();
          })
          .then((value) => {
            assertCurrent();
            return value;
          })
          .finally(() => {
            record.pending.delete(running);
          });
        record.pending.add(running);
        void running.catch(() => undefined); // Original rejection still reaches the caller.
        return running;
      },
      connect: (def, options) => {
        assertCurrent();
        if (connection) return connection;
        if (record.resource) throw new MCPLocalCustodyError('stale');
        if (def.id !== id) throw new MCPLocalCustodyError('stale');
        bind(def);
        assertCurrent();
        enter();
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
        while (record.pending.size)
          await Promise.allSettled([...record.pending]);
        admission?.settle(effectStarted);
        this.records.delete(record);
      },
      attach: (resource, definition) => {
        if (definition) bind(definition);
        assertCurrent();
        if (record.resource) throw new MCPLocalCustodyError('stale');
        enter();
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
    let pendingOperations = 0;
    for (const record of this.records) {
      const resource = record.resource?.inspect();
      const phase =
        record.pending.size > 0 &&
        (!resource || resource.phase === 'closed') &&
        !record.current
          ? 'closing'
          : (resource?.phase ?? 'reserved');
      phases[phase] = (phases[phase] ?? 0) + 1;
      pendingOperations +=
        record.pending.size + (resource?.pendingOperations ?? 0);
    }
    return {
      scope: 'local-sdk-handles' as const,
      accepting: this.accepting,
      retained: this.records.size,
      pendingOperations,
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
