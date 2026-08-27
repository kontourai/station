import { ListenerManager } from '../core/ListenerManager.js';
import {
  VOICE_SESSION_LIFECYCLE_STATES,
  type VoiceSessionAdapter,
  type VoiceSessionAdapterCapabilities,
  type VoiceSessionAdapterDescriptor,
  type VoiceSessionAudioInput,
  type VoiceSessionContextUpdate,
  type VoiceSessionLifecycleState,
  type VoiceSessionOperation,
  type VoiceSessionOperationResult,
  type VoiceSessionSnapshot,
  type VoiceSessionStartInput,
  type VoiceSessionTextTurn,
} from './session-types.js';

export type {
  FakeVoiceRealtimeConnection,
  FakeVoiceRealtimeProvider,
  FakeVoiceRealtimeProviderOptions,
  VoiceRealtimeConformanceFixture,
  VoiceRealtimeConformanceReport,
} from './realtime-testing.js';
export {
  createFakeVoiceRealtimeProvider,
  runVoiceRealtimeConformance,
} from './realtime-testing.js';

export interface SyntheticVoiceSessionAdapterOptions {
  readonly descriptor?: VoiceSessionAdapterDescriptor;
  readonly capabilities?: VoiceSessionAdapterCapabilities;
  readonly controlSessionId?: string;
  readonly conversationSessionId?: string;
  readonly deferredOperations?: readonly VoiceSessionOperation[];
}

export interface SyntheticVoiceSessionCall {
  readonly operation: VoiceSessionOperation;
  readonly input?:
    | VoiceSessionStartInput
    | VoiceSessionContextUpdate
    | VoiceSessionTextTurn
    | VoiceSessionAudioInput;
}

export interface SyntheticVoiceSessionAdapter extends VoiceSessionAdapter {
  readonly calls: readonly SyntheticVoiceSessionCall[];
  emit(input: SyntheticVoiceSessionSnapshotInput): VoiceSessionSnapshot;
  resolveDeferred(operation: VoiceSessionOperation): boolean;
}

export type SyntheticVoiceSessionSnapshotInput = Omit<
  VoiceSessionSnapshot,
  'revision'
>;

type DeferredOperation = {
  readonly operation: VoiceSessionOperation;
  readonly resolve: () => void;
};

class SyntheticVoiceSessionAdapterImpl
  extends ListenerManager
  implements SyntheticVoiceSessionAdapter
{
  readonly descriptor: VoiceSessionAdapterDescriptor;
  readonly capabilities: VoiceSessionAdapterCapabilities;
  private readonly deferredOperations: ReadonlySet<VoiceSessionOperation>;
  private readonly deferred: DeferredOperation[] = [];
  private readonly callLog: SyntheticVoiceSessionCall[] = [];
  private snapshot: VoiceSessionSnapshot;

  constructor(options: SyntheticVoiceSessionAdapterOptions) {
    super();
    this.descriptor = Object.freeze({
      id: options.descriptor?.id ?? 'synthetic-voice-session',
      name: options.descriptor?.name ?? 'Synthetic voice session',
      ...(options.descriptor?.description
        ? { description: options.descriptor.description }
        : {}),
    });
    this.capabilities = Object.freeze({ ...options.capabilities });
    this.deferredOperations = new Set(options.deferredOperations);
    this.snapshot = Object.freeze({
      state: 'disconnected',
      revision: 0,
      ...(options.controlSessionId
        ? { controlSessionId: options.controlSessionId }
        : {}),
      ...(options.conversationSessionId
        ? { conversationSessionId: options.conversationSessionId }
        : {}),
    });

    if (this.capabilities.interrupt) {
      this.interrupt = async () => this.runOptional('interrupt');
    }
    if (this.capabilities.reconnect) {
      this.reconnect = async () => this.runOptional('reconnect');
    }
    if (this.capabilities.updateContext) {
      this.updateContext = async (input) =>
        this.runOptional('update-context', input);
    }
    if (this.capabilities.textTurn) {
      this.sendText = async (input) => this.runOptional('send-text', input);
    }
    if (this.capabilities.audioInput) {
      this.sendAudio = async (input) => this.runOptional('send-audio', input);
    }
  }

  get calls(): readonly SyntheticVoiceSessionCall[] {
    return Object.freeze([...this.callLog]);
  }

  getSnapshot(): VoiceSessionSnapshot {
    return this.snapshot;
  }

  async start(
    input?: VoiceSessionStartInput,
  ): Promise<VoiceSessionOperationResult> {
    this.record('start', input);
    this.emit({
      state: 'connecting',
      ...(input?.controlSessionId
        ? { controlSessionId: input.controlSessionId }
        : {}),
      ...(input?.conversationSessionId
        ? { conversationSessionId: input.conversationSessionId }
        : {}),
    });
    await this.waitForDeferred('start');
    return this.success(this.emit({ state: 'connected-idle' }));
  }

  async stop(): Promise<VoiceSessionOperationResult> {
    this.record('stop');
    this.emit({ state: 'stopping' });
    await this.waitForDeferred('stop');
    return this.success(this.emit({ state: 'disconnected' }));
  }

  interrupt?: () => Promise<VoiceSessionOperationResult>;
  reconnect?: () => Promise<VoiceSessionOperationResult>;
  updateContext?: (
    input: VoiceSessionContextUpdate,
  ) => Promise<VoiceSessionOperationResult>;
  sendText?: (
    input: VoiceSessionTextTurn,
  ) => Promise<VoiceSessionOperationResult>;
  sendAudio?: (
    input: VoiceSessionAudioInput,
  ) => Promise<VoiceSessionOperationResult>;

  emit(input: SyntheticVoiceSessionSnapshotInput): VoiceSessionSnapshot {
    this.snapshot = Object.freeze({
      ...this.snapshot,
      ...input,
      revision: this.snapshot.revision + 1,
    });
    this._notify();
    return this.snapshot;
  }

  resolveDeferred(operation: VoiceSessionOperation): boolean {
    const index = this.deferred.findIndex(
      (candidate) => candidate.operation === operation,
    );
    if (index < 0) return false;
    const [deferred] = this.deferred.splice(index, 1);
    deferred.resolve();
    return true;
  }

  private async runOptional(
    operation: Extract<
      VoiceSessionOperation,
      'interrupt' | 'reconnect' | 'update-context' | 'send-text' | 'send-audio'
    >,
    input?:
      | VoiceSessionContextUpdate
      | VoiceSessionTextTurn
      | VoiceSessionAudioInput,
  ): Promise<VoiceSessionOperationResult> {
    this.record(operation, input);
    await this.waitForDeferred(operation);
    return this.success(this.snapshot);
  }

  private record(
    operation: VoiceSessionOperation,
    input?:
      | VoiceSessionStartInput
      | VoiceSessionContextUpdate
      | VoiceSessionTextTurn
      | VoiceSessionAudioInput,
  ): void {
    this.callLog.push(
      Object.freeze({
        operation,
        ...(input ? { input: Object.freeze({ ...input }) } : {}),
      }),
    );
  }

  private waitForDeferred(operation: VoiceSessionOperation): Promise<void> {
    if (!this.deferredOperations.has(operation)) return Promise.resolve();
    return new Promise((resolve) => {
      this.deferred.push({ operation, resolve });
    });
  }

  private success(snapshot: VoiceSessionSnapshot): VoiceSessionOperationResult {
    return { ok: true, snapshot };
  }
}

export function createSyntheticVoiceSessionAdapter(
  options: SyntheticVoiceSessionAdapterOptions = {},
): SyntheticVoiceSessionAdapter {
  return new SyntheticVoiceSessionAdapterImpl(options);
}

export interface VoiceSessionConformanceFixture {
  readonly adapter: VoiceSessionAdapter;
  /** Emits provider-specific intermediate lifecycle states after start. */
  exercise(): Promise<void> | void;
}

export type VoiceSessionConformanceViolationCode =
  | 'capability-method-mismatch'
  | 'identity-not-distinct'
  | 'identity-not-preserved'
  | 'missing-lifecycle-state'
  | 'operation-failed'
  | 'snapshot-not-frozen'
  | 'snapshot-revision-not-monotonic';

export interface VoiceSessionConformanceViolation {
  readonly code: VoiceSessionConformanceViolationCode;
  readonly message: string;
}

export interface VoiceSessionConformanceReport {
  readonly ok: boolean;
  readonly snapshots: readonly VoiceSessionSnapshot[];
  readonly violations: readonly VoiceSessionConformanceViolation[];
}

const CONFORMANCE_CONTROL_SESSION_ID = 'conformance-control-session';
const CONFORMANCE_CONVERSATION_SESSION_ID = 'conformance-conversation-session';

/**
 * Runs adapter-contract checks without importing a test runner. A fixture
 * supplies provider-specific intermediate lifecycle emissions through exercise.
 */
export async function runVoiceSessionAdapterConformance(
  fixture: VoiceSessionConformanceFixture,
): Promise<VoiceSessionConformanceReport> {
  const snapshots: VoiceSessionSnapshot[] = [fixture.adapter.getSnapshot()];
  const unsubscribe = fixture.adapter.subscribe(() => {
    snapshots.push(fixture.adapter.getSnapshot());
  });
  const violations: VoiceSessionConformanceViolation[] = [];

  try {
    checkCapabilityMethods(fixture.adapter, violations);
    const start = await fixture.adapter.start({
      controlSessionId: CONFORMANCE_CONTROL_SESSION_ID,
      conversationSessionId: CONFORMANCE_CONVERSATION_SESSION_ID,
    });
    checkOperationResult('start', start, violations);
    await runEnabledOptionalOperations(fixture.adapter, violations);
    await fixture.exercise();
    const stop = await fixture.adapter.stop();
    checkOperationResult('stop', stop, violations);
  } catch (error) {
    violations.push({
      code: 'operation-failed',
      message:
        error instanceof Error ? error.message : 'Adapter operation failed.',
    });
  } finally {
    unsubscribe();
  }

  checkSnapshots(snapshots, violations);
  return Object.freeze({
    ok: violations.length === 0,
    snapshots: Object.freeze([...snapshots]),
    violations: Object.freeze([...violations]),
  });
}

function checkCapabilityMethods(
  adapter: VoiceSessionAdapter,
  violations: VoiceSessionConformanceViolation[],
): void {
  const operations = [
    ['interrupt', 'interrupt', 'interrupt'],
    ['reconnect', 'reconnect', 'reconnect'],
    ['updateContext', 'updateContext', 'update-context'],
    ['textTurn', 'sendText', 'send-text'],
    ['audioInput', 'sendAudio', 'send-audio'],
  ] as const;
  for (const [capability, method, operation] of operations) {
    if (
      Boolean(adapter.capabilities[capability]) !== Boolean(adapter[method])
    ) {
      violations.push({
        code: 'capability-method-mismatch',
        message: `${operation} capability and method must be declared together.`,
      });
    }
  }
}

async function runEnabledOptionalOperations(
  adapter: VoiceSessionAdapter,
  violations: VoiceSessionConformanceViolation[],
): Promise<void> {
  if (adapter.capabilities.interrupt && adapter.interrupt) {
    checkOperationResult('interrupt', await adapter.interrupt(), violations);
  }
  if (adapter.capabilities.reconnect && adapter.reconnect) {
    checkOperationResult('reconnect', await adapter.reconnect(), violations);
  }
  if (adapter.capabilities.updateContext && adapter.updateContext) {
    checkOperationResult(
      'update-context',
      await adapter.updateContext({ source: 'conformance' }),
      violations,
    );
  }
  if (adapter.capabilities.textTurn && adapter.sendText) {
    checkOperationResult(
      'send-text',
      await adapter.sendText({ text: 'Conformance text turn.' }),
      violations,
    );
  }
  if (adapter.capabilities.audioInput && adapter.sendAudio) {
    checkOperationResult(
      'send-audio',
      await adapter.sendAudio({ audio: new Uint8Array([0]) }),
      violations,
    );
  }
}

function checkOperationResult(
  operation: VoiceSessionOperation,
  result: VoiceSessionOperationResult,
  violations: VoiceSessionConformanceViolation[],
): void {
  if (!result.ok) {
    violations.push({
      code: 'operation-failed',
      message: `${operation} returned ${result.error.code}.`,
    });
    return;
  }
  if (!Object.isFrozen(result.snapshot)) {
    violations.push({
      code: 'snapshot-not-frozen',
      message: `${operation} returned a mutable snapshot.`,
    });
  }
}

function checkSnapshots(
  snapshots: readonly VoiceSessionSnapshot[],
  violations: VoiceSessionConformanceViolation[],
): void {
  checkSnapshotIntegrity(snapshots, violations);
  checkIdentityPreservation(snapshots, violations);
  checkLifecycleCoverage(snapshots, violations);
}

function checkSnapshotIntegrity(
  snapshots: readonly VoiceSessionSnapshot[],
  violations: VoiceSessionConformanceViolation[],
): void {
  let previousRevision: number | undefined;
  for (const snapshot of snapshots) {
    if (!Object.isFrozen(snapshot)) {
      violations.push({
        code: 'snapshot-not-frozen',
        message: `Snapshot at revision ${snapshot.revision} is mutable.`,
      });
    }
    if (
      previousRevision !== undefined &&
      snapshot.revision <= previousRevision
    ) {
      violations.push({
        code: 'snapshot-revision-not-monotonic',
        message: `Snapshot revision ${snapshot.revision} did not advance after ${previousRevision}.`,
      });
    }
    previousRevision = snapshot.revision;
  }
}

function checkIdentityPreservation(
  snapshots: readonly VoiceSessionSnapshot[],
  violations: VoiceSessionConformanceViolation[],
): void {
  let observedControlIdentity = false;
  let observedConversationIdentity = false;
  for (const snapshot of snapshots) {
    if (
      snapshot.controlSessionId !== undefined &&
      snapshot.conversationSessionId !== undefined &&
      snapshot.controlSessionId === snapshot.conversationSessionId
    ) {
      violations.push({
        code: 'identity-not-distinct',
        message: 'Control and conversation identities must remain distinct.',
      });
    }
    observedControlIdentity ||=
      snapshot.controlSessionId === CONFORMANCE_CONTROL_SESSION_ID;
    observedConversationIdentity ||=
      snapshot.conversationSessionId === CONFORMANCE_CONVERSATION_SESSION_ID;
  }

  if (!observedControlIdentity || !observedConversationIdentity) {
    violations.push({
      code: 'identity-not-preserved',
      message:
        'Each requested start identity must be preserved in an emitted snapshot.',
    });
  }
}

function checkLifecycleCoverage(
  snapshots: readonly VoiceSessionSnapshot[],
  violations: VoiceSessionConformanceViolation[],
): void {
  const seenStates = new Set<VoiceSessionLifecycleState>(
    snapshots.map((snapshot) => snapshot.state),
  );
  for (const state of VOICE_SESSION_LIFECYCLE_STATES) {
    if (!seenStates.has(state)) {
      violations.push({
        code: 'missing-lifecycle-state',
        message: `Lifecycle state ${state} was not observed.`,
      });
    }
  }
}
