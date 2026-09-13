import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';
import type { AgentSpec } from '@kontourai/station-contracts/agent';
import type { ProjectConfig } from '@kontourai/station-contracts/project';
import {
  type ForegroundInvocationAdmission,
  ForegroundInvocationUnavailableError,
} from '../../services/orchestration/foreground-invocation-admission.js';
import { createNativeExecutionWorkspace } from './native-execution-workspace.js';

export const INTERNAL_NATIVE_FOREGROUND_HEADER =
  'x-station-native-foreground-admission';
const INVOCATION_DEADLINE_MS = 60_000;

interface NativeForegroundRequest {
  agentId: string;
  projectSlug: unknown;
  input: unknown;
  options: Record<string, unknown>;
  ambientContext: unknown;
}

/** Private companion to the existing authorized-turn relay; never JSON. */
export interface NativeForegroundRelayCompanion {
  readonly workspaceRoot: string | undefined;
  onClose(cleanup: () => void): void;
  close(): void;
  readonly agentSpec: AgentSpec;
  readonly project: ProjectConfig;
  assertRequest(request: NativeForegroundRequest): void;
  invoke<T>(
    runtime: {
      spec: AgentSpec | undefined;
      isCurrent(): boolean;
    },
    effect: () => Promise<T>,
  ): Promise<T>;
  waitForInvocation(signal: AbortSignal): Promise<void>;
  refuse(): void;
}

const nativeForeground =
  new AsyncLocalStorage<NativeForegroundRelayCompanion>();
export function runWithNativeForegroundRelay<T>(
  companion: NativeForegroundRelayCompanion,
  work: () => T,
): T {
  return nativeForeground.run(companion, work);
}
export function currentNativeForegroundRelay():
  | NativeForegroundRelayCompanion
  | undefined {
  return nativeForeground.getStore();
}

export function nativeRuntimeSpecMatches(
  expected: AgentSpec,
  actual: AgentSpec | undefined,
): boolean {
  return actual !== undefined && isDeepStrictEqual(expected, actual);
}

export function createNativeForegroundRelay(
  admission: ForegroundInvocationAdmission,
  binding: {
    threadId: string;
    workspaceRoot?: string;
    userId: string;
    modelId?: string;
    clientTurnId?: string;
    ambientContext?: string;
  },
): NativeForegroundRelayCompanion {
  if (!binding.threadId || !binding.userId)
    throw new ForegroundInvocationUnavailableError();
  const capturedSpec = admission.agentSpec;
  const capturedProject = admission.project;
  const workspaceRoot = binding.workspaceRoot;
  if (
    capturedProject.defaultWorkspaceIsolation === 'worktree' &&
    !workspaceRoot
  )
    throw new ForegroundInvocationUnavailableError();
  // The private relay supplies the server-resolved Session cwd.
  // resolveStartSessionCwd expands stored Project paths before this binding;
  // keep its exact owned-worktree directory instead of the original Project root.
  if (workspaceRoot) capturedProject.workingDirectory = workspaceRoot;
  const workspace = createNativeExecutionWorkspace(workspaceRoot);
  let closed = false;
  const expectedOptions = {
    conversationId: binding.threadId,
    userId: binding.userId,
    ...(binding.modelId
      ? {
          model: binding.modelId,
          providerModel: binding.modelId,
          providerManagedFallback: true,
        }
      : {}),
    ...(binding.clientTurnId ? { clientTurnId: binding.clientTurnId } : {}),
  };
  let used = false;
  let settled = false;
  let refused = false;
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const invoked = new Promise<void>((accept, deny) => {
    resolve = accept;
    reject = deny;
  });
  // A synchronous in-process HTTP fixture can refuse before the adapter has
  // received its Response and installed the waiter. Keep that rejection owned.
  void invoked.catch(() => {});
  const refuse = () => {
    if (settled) return;
    settled = true;
    refused = true;
    reject(new ForegroundInvocationUnavailableError());
  };
  return Object.freeze({
    get workspaceRoot() {
      return workspace.workspaceRoot;
    },
    onClose: workspace.onClose,
    close() {
      closed = true;
      workspace.close();
    },
    get agentSpec() {
      return structuredClone(capturedSpec);
    },
    get project() {
      return structuredClone(capturedProject);
    },
    assertRequest(request: NativeForegroundRequest) {
      if (
        request.agentId !== admission.agentId ||
        request.projectSlug !== capturedProject.slug ||
        request.input !== admission.message ||
        request.ambientContext !== binding.ambientContext ||
        !isDeepStrictEqual(request.options, expectedOptions)
      )
        throw new ForegroundInvocationUnavailableError();
    },
    async invoke<T>(
      runtime: { spec: AgentSpec | undefined; isCurrent(): boolean },
      effect: () => Promise<T>,
    ): Promise<T> {
      try {
        return await admission.invoke(
          'turn',
          {
            threadId: binding.threadId,
            agentId: admission.agentId,
            projectSlug: capturedProject.slug,
            message: admission.message,
          },
          () => {
            if (
              used ||
              refused ||
              closed ||
              !runtime.isCurrent() ||
              !nativeRuntimeSpecMatches(capturedSpec, runtime.spec)
            ) {
              refuse();
              throw new ForegroundInvocationUnavailableError();
            }
            used = true;
            try {
              // The existing native Agent is invoked once with its pinned runtime
              // generation. Acknowledge CALL, never await provider settlement here.
              const pending = effect();
              settled = true;
              resolve();
              return pending;
            } catch (error) {
              refuse();
              throw error;
            }
          },
        );
      } catch (error) {
        refuse();
        throw error;
      }
    },
    async waitForInvocation(signal: AbortSignal) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const abort = () => refuse();
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) refuse();
      timeout = setTimeout(refuse, INVOCATION_DEADLINE_MS);
      try {
        await invoked;
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
      }
    },
    refuse,
  });
}
