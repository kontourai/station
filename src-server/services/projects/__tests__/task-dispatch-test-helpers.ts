import type {
  TaskDispatchInput,
  TaskDispatchResult,
} from '@kontourai/station-contracts';
import {
  agentId,
  engineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
import type { EngineId } from '@kontourai/station-contracts/provider';
import { agentExecutionBindingMetadata } from '../../execution-target/execution-target-resolver.js';
import { composeTaskDispatcher } from '../task-dispatch-composition.js';
import type {
  DispatchOutcome,
  TaskDispatchAgentStart,
  TaskDispatcher,
} from '../task-dispatcher.js';
import type {
  TaskDispatchAdapterDeps,
  TaskGraphService,
} from '../task-graph-service.js';

/** The Environment the fixture Agent resolver answers for. */
export const FIXTURE_ENVIRONMENT_ID = 'environment-test';
/** The directory the fixture Agent resolver runs a Project in. */
export const FIXTURE_PROJECT_CWD = '/tmp/project-alpha';

/**
 * #4005: a stand-in for `resolveTaskDispatchAgentStart` that answers every
 * Agent as running on `provider`, with the binding metadata built by the
 * real writer (`agentExecutionBindingMetadata`), so a start in these tests
 * records exactly the fields production records.
 */
export function fixtureAgentStartResolver(
  provider: EngineId,
): NonNullable<TaskDispatchAdapterDeps['resolveAgentStart']> {
  return async (input): Promise<TaskDispatchAgentStart> => ({
    agentId: input.agentId,
    provider,
    ...(input.modelId ? { modelId: input.modelId } : {}),
    ...(input.modelOptions ? { modelOptions: input.modelOptions } : {}),
    cwd: input.cwd ?? FIXTURE_PROJECT_CWD,
    environmentId: FIXTURE_ENVIRONMENT_ID,
    metadata: {
      ...agentExecutionBindingMetadata({
        access: {
          apiBase: 'http://station.test',
          environmentId: FIXTURE_ENVIRONMENT_ID,
          environmentName: 'Current environment',
          kind: 'current',
        },
        agentId: agentId(input.agentId),
        engine: {
          kind: 'connection',
          connectionId: engineConnectionId(provider),
        },
      }),
      projectSlug: input.projectSlug,
      workspaceIsolation: { mode: 'shared' },
    },
  });
}

/** Composes a Dispatcher whose engine starts resolve through the fixture. */
export function composeTestTaskDispatcher(
  service: TaskGraphService,
  provider: EngineId = 'codex',
): TaskDispatcher {
  return composeTaskDispatcher(service, {
    resolveAgentStart: fixtureAgentStartResolver(provider),
  });
}

/** Legacy assertion convenience lives in tests, never on TaskGraphService. */
function unwrapDispatch(outcome: DispatchOutcome): TaskDispatchResult {
  if (outcome.kind === 'dispatched') return outcome.result;
  throw new Error(outcome.reason);
}

export async function dispatchTaskForTest(
  service: TaskGraphService,
  taskId: string,
  input: TaskDispatchInput,
): Promise<TaskDispatchResult> {
  const provider =
    input.runtimeConfig?.provider ?? input.provider ?? 'task-dispatch';
  return unwrapDispatch(
    await composeTestTaskDispatcher(service, provider).dispatch(taskId, {
      ...input,
      ownerUserId: 'test-owner',
      fullAccessGrant: null,
    }),
  );
}
