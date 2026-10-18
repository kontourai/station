import type { OwnerIdentity, OwnerLiveness } from '@kontourai/monument';
import type { AtomicPort } from '@kontourai/monument/testing';
export type Digest = `sha256:${string}`;
export type Revision = string;
export interface BodyRef {
  readonly codec: CodecId;
  readonly digest: Digest;
  readonly byteLength: number;
}
export type CodecId =
  | 'runtime-volt-entry/1'
  | 'runtime-strands-entry/1'
  | 'runtime-ai-sdk-v3-request/1'
  | 'runtime-ai-sdk-v3-tape/1'
  | 'runtime-ai-sdk-v3-part/1';
export interface RunKey {
  readonly scopeId: string;
  readonly conversationId: string;
  readonly invocationId: string;
}
export interface Fence {
  readonly owner: OwnerIdentity;
  readonly revision: Revision;
}
export interface ImplementationBinding {
  readonly framework: 'voltagent' | 'strands-vercel';
  readonly frameworkVersion: '2.10.0' | '1.19.0';
  readonly adapterDigest: Digest;
  readonly modelImplementationDigest: Digest;
  readonly connectionId: string;
  readonly connectionRevision: string;
  readonly provider: string;
  readonly modelId: string;
  readonly transport: 'ai-sdk-v3-stateless/1';
}
export interface EntryPin {
  readonly body: BodyRef; // one exact framework entry codec above
  readonly sourceCutoff: string; // opaque authorized immutable host cursor
  readonly originalAuthoredDigest: Digest;
  readonly effectivePrefixDigest: Digest;
}
export interface RunSpec {
  readonly key: RunKey;
  readonly binding: ImplementationBinding;
  readonly entry: EntryPin;
}
export interface ModelPin {
  readonly requestId: string;
  readonly ordinal: number;
  readonly entryDigest: Digest;
  readonly previousResponseDigest: Digest | null;
  readonly request: BodyRef;
}
export type RunState =
  | 'open'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'blocked';
export interface Snapshot {
  readonly spec: RunSpec;
  readonly fence: Fence;
  readonly state: RunState;
  readonly nextOrdinal: number;
}
export interface Operation {
  readonly operationId: string;
  readonly digest: Digest;
}
export interface Owned extends Operation {
  readonly key: RunKey;
  readonly expected: Fence;
}
export type Refused = {
  readonly kind: 'refused';
  readonly reason:
    | 'stale'
    | 'busy'
    | 'unknown-owner'
    | 'conflict'
    | 'unavailable'
    | 'unsupported'
    | 'capacity'
    | 'expired'
    | 'cancelled';
};
export type WriteAck =
  | { readonly kind: 'applied' | 'already-applied'; readonly fence: Fence }
  | Refused;
export interface Attempt {
  readonly requestId: string;
  readonly number: number;
  readonly owner: OwnerIdentity;
  readonly grantId: string;
}
export interface Projection {
  readonly id: string;
  readonly key: RunKey;
  readonly requestId: string;
  readonly attempt: number;
  readonly sequence: number;
  readonly kind: 'partial' | 'aborted' | 'completed';
  readonly body: BodyRef | null; // null only for aborted marker
}
export type ModelProtocol = {
  open: {
    command: Operation & { type: 'open'; spec: RunSpec; owner: OwnerIdentity };
    result: { kind: 'opened' | 'existing'; snapshot: Snapshot } | Refused;
  };
  pin: { command: Owned & { type: 'pin'; pin: ModelPin }; result: WriteAck };
  begin: {
    command: Owned & { type: 'begin'; requestId: string };
    result:
      | { kind: 'execute'; fence: Fence; attempt: Attempt }
      | { kind: 'acknowledged'; fence: Fence; originalGrantId: string }
      | { kind: 'already-begun'; fence: Fence }
      | { kind: 'replay'; fence: Fence; tape: BodyRef; attempt: Attempt }
      | Refused;
  };
  partial: {
    command: Owned & {
      type: 'partial';
      attempt: Attempt;
      sequence: number;
      body: BodyRef;
    };
    result: WriteAck;
  };
  complete: {
    command: Owned & {
      type: 'complete';
      attempt: Attempt;
      tape: BodyRef;
      lastPartialSequence: number;
    };
    result: WriteAck;
  };
  abandon: {
    command: Owned & {
      type: 'abandon';
      attempt: Attempt;
      reason: 'consumer-cancel' | 'provider-error' | 'durability-error';
    };
    result: WriteAck;
  };
  takeOver: {
    command: Owned & { type: 'takeOver'; owner: OwnerIdentity };
    result:
      | {
          kind: 'restored';
          snapshot: Snapshot;
          entry: EntryPin;
          pendingRequest: ModelPin | null;
        }
      | Refused;
  };
  finish: {
    command: Owned & { type: 'finish'; status: 'completed' | 'blocked' };
    result: WriteAck;
  };
  cancel: { command: Owned & { type: 'cancel' }; result: WriteAck };
  read: {
    command: { type: 'read'; key: RunKey };
    result:
      | { kind: 'found'; snapshot: Snapshot; pins: readonly ModelPin[] }
      | { kind: 'absent' }
      | Refused;
  };
  listOutbox: {
    command: {
      type: 'listOutbox';
      key: RunKey;
      limit: number;
      throughPosition?: number;
    };
    result:
      | {
          kind: 'listed';
          entries: readonly Projection[];
          throughPosition: number;
        }
      | Refused;
  };
  acknowledge: {
    command: Operation & {
      type: 'acknowledge';
      key: RunKey;
      projectionId: string;
      projectionDigest: Digest;
    };
    result: { kind: 'applied' | 'already-applied' } | Refused;
  };
};
export interface ModelContext {
  readonly liveness: OwnerLiveness;
}
export type ModelStorage = AtomicPort<ModelProtocol, ModelContext>;
export interface Bodies {
  put(codec: CodecId, bytes: Uint8Array): Promise<BodyRef>;
  read(ref: BodyRef): Promise<Uint8Array>;
}
export interface CurrentAdmission {
  // Fixed host closure reauthorizes; these are current implementation facts.
  readonly binding: ImplementationBinding;
  readonly writerGeneration: string;
}
export interface RestoredEntry {
  readonly key: RunKey;
  readonly fence: Fence;
  readonly entry: EntryPin;
  readonly entryBytes: Uint8Array;
  readonly pins: readonly ModelPin[];
  readonly mode: 'capture' | 'restore';
}
export interface StreamControl {
  readonly key: RunKey;
  run<T>(operation: () => Promise<T>): Promise<T>;
  finish(status: 'completed' | 'blocked'): Promise<void>;
  cancel(): Promise<void>; // explicit caller cancel, not disconnect inference
}
export interface ModelRuntime {
  start(input: {
    readonly key: RunKey;
    readonly owner: OwnerIdentity;
    readonly admission: CurrentAdmission;
    readonly capture: () => Promise<{
      readonly entry: EntryPin;
      readonly entryBytes: Uint8Array;
    }>;
  }): Promise<RestoredEntry>;
  restore(input: {
    readonly key: RunKey;
    readonly observed: Fence;
    readonly owner: OwnerIdentity;
    readonly admission: CurrentAdmission;
  }): Promise<RestoredEntry>;
  bind(entry: RestoredEntry): StreamControl;
}
export interface ModelRuntimeOptions {
  readonly storage: ModelStorage;
  readonly bodies: Bodies;
  readonly liveness: OwnerLiveness;
  readonly admission: (
    key: RunKey,
    operation: 'execute' | 'recover' | 'read' | 'cancel' | 'project',
  ) => CurrentAdmission;
}

export interface RuntimeProjectionSink {
  apply(entry: Projection): Promise<void>;
  readAudit(key: RunKey): Promise<readonly Projection[]>;
  readModelContext(
    key: RunKey,
  ): Promise<
    { kind: 'ready'; tapes: readonly BodyRef[] } | { kind: 'unavailable' }
  >;
  close(): Promise<void>;
}
