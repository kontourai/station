import type {
  VoiceAgentTurnAdapter,
  VoiceAgentTurnInput,
  VoiceAudioChunk,
  VoiceEndpointDetector,
  VoiceInputAdapter,
  VoicePlaybackAdapter,
  VoiceRoleComponents,
  VoiceSynthesisAdapter,
  VoiceTurnTelemetryEvent,
  VoiceTurnTelemetrySink,
} from './component-types.js';
import {
  type VoiceSessionAdapterDescriptor,
  VoiceSessionError,
  type VoiceSessionLifecycleState,
  type VoiceSessionOperation,
  type VoiceSessionOperationResult,
  type VoiceSessionSnapshot,
} from './session-types.js';

export type ComponentChoice<T> = T | VoiceRoleComponents<T>;

export interface ComposedVoiceSessionAdapterOptions {
  readonly descriptor?: VoiceSessionAdapterDescriptor;
  readonly input: ComponentChoice<VoiceInputAdapter>;
  readonly endpoint: VoiceEndpointDetector;
  readonly agent: ComponentChoice<VoiceAgentTurnAdapter>;
  readonly synthesis: ComponentChoice<VoiceSynthesisAdapter>;
  readonly playback: ComponentChoice<VoicePlaybackAdapter>;
  readonly telemetry?: VoiceTurnTelemetrySink;
  readonly now?: () => number;
  readonly synthesisChunkLength?: number;
}

export function composedVoiceDescriptor(
  descriptor: VoiceSessionAdapterDescriptor | undefined,
): VoiceSessionAdapterDescriptor {
  return Object.freeze(
    descriptor ?? {
      id: 'composed-voice',
      name: 'Composed voice session',
      description: 'Provider-neutral composed voice session.',
    },
  );
}

export interface InputStartAttempt {
  lifecycle: number;
  readonly controller: AbortController;
  promise: Promise<VoiceSessionOperationResult>;
}

export interface StopAttempt {
  readonly lifecycle: number;
  readonly promise: Promise<VoiceSessionOperationResult>;
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

export function joinPendingOperations(
  ...operations: readonly (Promise<unknown> | undefined)[]
): Promise<unknown> | undefined {
  const pending = operations.filter(
    (operation): operation is Promise<unknown> => operation !== undefined,
  );
  return pending.length === 0 ? undefined : Promise.all(pending);
}

export async function startInputWithSecondary(
  primary: VoiceInputAdapter,
  secondary: VoiceInputAdapter | undefined,
  signal: AbortSignal,
  selectInput: (input: VoiceInputAdapter) => void,
  isCurrent: () => boolean,
  onSecondary: (
    primary: VoiceInputAdapter,
    secondary: VoiceInputAdapter,
  ) => void,
): Promise<void> {
  try {
    selectInput(primary);
    await primary.start(signal);
  } catch (error) {
    if (!isCurrent()) return;
    await bestEffortStop(primary);
    if (!isCurrent()) return;
    if (!secondary) throw error;
    onSecondary(primary, secondary);
    selectInput(secondary);
    try {
      await secondary.start(signal);
    } catch (secondaryError) {
      if (!isCurrent()) return;
      await bestEffortStop(secondary);
      if (!isCurrent()) return;
      throw secondaryError;
    }
  }
}

export async function stopSession(
  stopPlayback: () => Promise<void>,
  stopInput: () => Promise<void>,
): Promise<unknown> {
  let firstFailure: unknown;
  try {
    await stopPlayback();
  } catch (cause) {
    firstFailure = cause;
  }
  try {
    await stopInput();
  } catch (cause) {
    firstFailure ??= cause;
  }
  return firstFailure;
}

export async function bestEffortStop(input: VoiceInputAdapter): Promise<void> {
  try {
    await input.stop(new AbortController().signal);
  } catch {
    // Cleanup never replaces the primary operation failure.
  }
}

export interface InputRecoveryAttempt {
  readonly lifecycle: number;
  readonly failedInput: VoiceInputAdapter;
  candidate: VoiceInputAdapter | undefined;
  controller: AbortController | undefined;
}

export function normalizeComponents<T>(
  component: ComponentChoice<T>,
): VoiceRoleComponents<T> {
  return 'primary' in (component as object)
    ? (component as VoiceRoleComponents<T>)
    : { primary: component as T };
}

export function uniqueComponents<T>(
  components: VoiceRoleComponents<T>,
): readonly T[] {
  return components.secondary === undefined ||
    components.secondary === components.primary
    ? [components.primary]
    : [components.primary, components.secondary];
}

export function immutableContext(
  context: Record<string, unknown> | undefined,
): Readonly<Record<string, unknown>> {
  return cloneContextValue(context ?? {}, new WeakMap()) as Readonly<
    Record<string, unknown>
  >;
}

export async function collectAgentTokens(
  adapter: VoiceAgentTurnAdapter,
  input: VoiceAgentTurnInput,
  signal: AbortSignal,
  onFirstToken: () => void,
): Promise<string | undefined> {
  let text = '';
  let first = true;
  try {
    for await (const token of adapter.run(input)) {
      if (signal.aborted) return '';
      if (first) {
        first = false;
        onFirstToken();
      }
      text += token;
    }
    return text;
  } catch (_error) {
    return signal.aborted ? '' : undefined;
  }
}

export function projectSessionSnapshot(
  current: VoiceSessionSnapshot,
  state: VoiceSessionLifecycleState,
  controlSessionId: string | undefined,
  conversationSessionId: string | undefined,
  transcript: string | undefined,
  transcriptRole: 'user' | 'assistant' | undefined,
  error: VoiceSessionError | undefined,
): VoiceSessionSnapshot {
  return Object.freeze({
    state,
    revision: current.revision + 1,
    ...(controlSessionId ? { controlSessionId } : {}),
    ...(conversationSessionId ? { conversationSessionId } : {}),
    ...(transcript
      ? { transcript, transcriptRole: transcriptRole ?? ('user' as const) }
      : {}),
    ...(error ? { error } : {}),
  });
}

export function createOperationError(
  operation: VoiceSessionOperation,
  cause: unknown,
): VoiceSessionError {
  return new VoiceSessionError(
    'operation-failed',
    cause instanceof Error
      ? cause.message
      : 'Voice component operation failed.',
    operation,
    cause,
  );
}

export function createSecondaryTelemetry(
  role: 'input' | 'agent' | 'synthesis' | 'playback',
  failedComponentId: string,
  secondaryComponentId: string,
  startedAt: number,
  now: number,
): VoiceTurnTelemetryEvent {
  return Object.freeze({
    type: 'secondary' as const,
    durationMs: now - startedAt,
    attributes: Object.freeze({
      role,
      failedComponentId,
      secondaryComponentId,
      reasonCode: 'operation-failed',
    }),
  });
}

export type AudioCollectionResult =
  | { readonly kind: 'ok'; readonly firstAudioEmitted: boolean }
  | { readonly kind: 'synthesis-failed'; readonly audioAccepted: boolean };

export async function collectAudioChunks(
  adapter: VoiceSynthesisAdapter,
  text: string,
  signal: AbortSignal,
  isCurrent: () => boolean,
  playAudio: (chunk: VoiceAudioChunk) => Promise<VoicePlaybackAdapter>,
  onFirstAudio: (playback: VoicePlaybackAdapter) => void,
  firstAudioEmitted: boolean,
): Promise<AudioCollectionResult> {
  let audioAccepted = false;
  let iterator: AsyncIterator<VoiceAudioChunk>;
  try {
    iterator = adapter
      .synthesize(Object.freeze({ text, signal }))
      [Symbol.asyncIterator]();
  } catch (_error) {
    return { kind: 'synthesis-failed', audioAccepted };
  }
  while (true) {
    let next: IteratorResult<VoiceAudioChunk>;
    try {
      next = await iterator.next();
    } catch (_error) {
      return { kind: 'synthesis-failed', audioAccepted };
    }
    if (next.done) return { kind: 'ok', firstAudioEmitted };
    if (!isCurrent()) return { kind: 'ok', firstAudioEmitted };
    const playback = await playAudio(next.value);
    audioAccepted = true;
    if (!firstAudioEmitted) {
      firstAudioEmitted = true;
      onFirstAudio(playback);
    }
    if (!isCurrent()) return { kind: 'ok', firstAudioEmitted };
  }
}

function cloneContextValue(
  value: unknown,
  seen: WeakMap<object, unknown>,
): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const existing = seen.get(value);
  if (existing !== undefined) return existing;
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(cloneContextValue(item, seen));
    return Object.freeze(copy);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value))
    copy[key] = cloneContextValue(item, seen);
  return Object.freeze(copy);
}
