import type {
  VoiceRealtimeConnection,
  VoiceRealtimeEvent,
  VoiceRealtimeLease,
  VoiceRealtimeProvider,
} from './realtime-types.js';
import type {
  VoiceSessionContextUpdate,
  VoiceSessionTextTurn,
} from './session-types.js';

export interface FakeVoiceRealtimeProviderOptions {
  readonly descriptor?: { readonly id: string; readonly name: string };
  readonly deferredOpen?: boolean;
}

export interface FakeVoiceRealtimeConnection extends VoiceRealtimeConnection {
  readonly operations: readonly string[];
  sendText: NonNullable<VoiceRealtimeConnection['sendText']>;
  sendAudio: NonNullable<VoiceRealtimeConnection['sendAudio']>;
  updateContext: NonNullable<VoiceRealtimeConnection['updateContext']>;
  interrupt: NonNullable<VoiceRealtimeConnection['interrupt']>;
  emit(event: VoiceRealtimeEvent): void;
}

export interface FakeVoiceRealtimeProvider extends VoiceRealtimeProvider {
  readonly openCount: number;
  readonly closeCount: number;
  readonly currentConnection: FakeVoiceRealtimeConnection;
  resolveOpen(): void;
}

class FakeConnection implements FakeVoiceRealtimeConnection {
  private readonly listeners = new Set<(event: VoiceRealtimeEvent) => void>();
  private readonly operationLog: string[] = [];

  constructor(private readonly closed: () => void) {}

  get operations(): readonly string[] {
    return Object.freeze([...this.operationLog]);
  }

  subscribe(listener: (event: VoiceRealtimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async sendText(_input: VoiceSessionTextTurn): Promise<void> {
    this.operationLog.push('send-text');
  }

  async sendAudio(_audio: Uint8Array): Promise<void> {
    this.operationLog.push('send-audio');
  }

  async updateContext(_input: VoiceSessionContextUpdate): Promise<void> {
    this.operationLog.push('update-context');
  }

  async interrupt(): Promise<void> {
    this.operationLog.push('interrupt');
  }

  async close(): Promise<void> {
    this.operationLog.push('close');
    this.closed();
  }

  emit(event: VoiceRealtimeEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

class FakeProvider implements FakeVoiceRealtimeProvider {
  readonly descriptor;
  readonly capabilities = Object.freeze({
    audioInput: true,
    audioOutput: true,
    textTurn: true,
    updateContext: true,
    interrupt: true,
  });
  private readonly connections: FakeConnection[] = [];
  private resolveDeferredOpen: (() => void) | undefined;
  private deferredOpen: Promise<void> | undefined;
  private opens = 0;
  private closes = 0;

  constructor(options: FakeVoiceRealtimeProviderOptions) {
    this.descriptor = Object.freeze({
      id: options.descriptor?.id ?? 'fake-realtime',
      name: options.descriptor?.name ?? 'Fake realtime',
    });
    if (options.deferredOpen) {
      this.deferredOpen = new Promise((resolve) => {
        this.resolveDeferredOpen = resolve;
      });
    }
  }

  get openCount(): number {
    return this.opens;
  }

  get closeCount(): number {
    return this.closes;
  }

  get currentConnection(): FakeVoiceRealtimeConnection {
    const connection = this.connections[this.connections.length - 1];
    if (!connection) throw new Error('No fake realtime connection is open.');
    return connection;
  }

  resolveOpen(): void {
    this.resolveDeferredOpen?.();
    this.resolveDeferredOpen = undefined;
    this.deferredOpen = undefined;
  }

  async readiness() {
    return { status: 'ready' } as const;
  }

  async mint(): Promise<VoiceRealtimeLease> {
    return Object.freeze({
      providerId: this.descriptor.id,
      open: async () => {
        await this.deferredOpen;
        this.opens += 1;
        const connection = new FakeConnection(() => {
          this.closes += 1;
        });
        this.connections.push(connection);
        return connection;
      },
    });
  }
}

export function createFakeVoiceRealtimeProvider(
  options: FakeVoiceRealtimeProviderOptions = {},
): FakeVoiceRealtimeProvider {
  return new FakeProvider(options);
}

export interface VoiceRealtimeConformanceReport {
  readonly ok: boolean;
  readonly operations: readonly string[];
  readonly events: readonly VoiceRealtimeEvent['type'][];
  readonly violations: readonly string[];
}

export interface VoiceRealtimeConformanceFixture {
  readonly provider: VoiceRealtimeProvider;
  /** Events this provider promises its injected/real transport exercises. */
  readonly requiredEvents: readonly VoiceRealtimeEvent['type'][];
  /**
   * Drives provider events through its real/injected transport. The runner
   * deliberately has no fake-only event backdoor.
   */
  exercise(connection: VoiceRealtimeConnection): Promise<void> | void;
}

/** A runner-free probe usable by provider examples as well as SDK tests. */
export async function runVoiceRealtimeConformance(
  fixture: VoiceRealtimeConformanceFixture,
): Promise<VoiceRealtimeConformanceReport> {
  const { provider } = fixture;
  const violations: string[] = [];
  const events: VoiceRealtimeEvent['type'][] = [];
  const operations: string[] = [];
  const connection = await acquireConformanceConnection(
    provider,
    operations,
    violations,
  );
  if (!connection)
    return conformanceReport(operations, events, violations, fixture);
  let unsubscribe: (() => void) | undefined;
  try {
    try {
      unsubscribe = connection.subscribe((event) => events.push(event.type));
    } catch {
      violations.push('connection subscription failed');
    }
    if (unsubscribe) {
      await exerciseConformanceOperations(
        provider,
        connection,
        operations,
        violations,
      );
      try {
        await fixture.exercise(connection);
      } catch {
        violations.push('provider event exercise failed');
      }
    }
  } finally {
    try {
      unsubscribe?.();
    } catch {
      violations.push('connection unsubscribe failed');
    }
    try {
      await connection.close();
      operations.push('close');
    } catch {
      violations.push('connection close failed');
    }
  }
  return conformanceReport(operations, events, violations, fixture);
}

async function acquireConformanceConnection(
  provider: VoiceRealtimeProvider,
  operations: string[],
  violations: string[],
): Promise<VoiceRealtimeConnection | undefined> {
  try {
    const readiness = await provider.readiness();
    if (readiness.status !== 'ready') {
      violations.push('provider readiness was not ready');
      return undefined;
    }
    const connection = await (await provider.mint()).open();
    operations.push('open');
    return connection;
  } catch {
    violations.push('provider connection acquisition failed');
    return undefined;
  }
}

async function exerciseConformanceOperations(
  provider: VoiceRealtimeProvider,
  connection: VoiceRealtimeConnection,
  operations: string[],
  violations: string[],
): Promise<void> {
  const capabilityMethods = [
    ['textTurn', 'sendText', 'send-text'],
    ['audioInput', 'sendAudio', 'send-audio'],
    ['updateContext', 'updateContext', 'update-context'],
    ['interrupt', 'interrupt', 'interrupt'],
  ] as const;
  const runOperation = async (
    operation: string,
    invoke: () => Promise<void>,
  ) => {
    try {
      await invoke();
      operations.push(operation);
    } catch {
      violations.push(`${operation} operation failed`);
    }
  };
  for (const [capability, method, operation] of capabilityMethods) {
    if (
      Boolean(provider.capabilities[capability]) !== Boolean(connection[method])
    ) {
      violations.push(
        `${operation} capability and connection method must be declared together`,
      );
    }
  }
  if (provider.capabilities.textTurn && connection.sendText)
    await runOperation('send-text', () =>
      connection.sendText!({ text: 'conformance' }),
    );
  if (provider.capabilities.audioInput && connection.sendAudio)
    await runOperation('send-audio', () =>
      connection.sendAudio!(new Uint8Array([0])),
    );
  if (provider.capabilities.updateContext && connection.updateContext)
    await runOperation('update-context', () =>
      connection.updateContext!({ source: 'conformance' }),
    );
  if (provider.capabilities.interrupt && connection.interrupt)
    await runOperation('interrupt', () => connection.interrupt!());
}

function conformanceReport(
  operations: string[],
  events: VoiceRealtimeEvent['type'][],
  violations: string[],
  fixture: VoiceRealtimeConformanceFixture,
): VoiceRealtimeConformanceReport {
  for (const event of fixture.requiredEvents) {
    if (!events.includes(event))
      violations.push(`required ${event} event was not observed`);
  }
  return Object.freeze({
    ok: violations.length === 0,
    operations: Object.freeze(operations),
    events: Object.freeze(events),
    violations: Object.freeze(violations),
  });
}
