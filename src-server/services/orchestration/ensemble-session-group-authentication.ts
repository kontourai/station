import { createHash } from 'node:crypto';
import { realpathSync, type Stats, statSync } from 'node:fs';
import { canonicalJson } from '@kontourai/relay';
import type { ExecutionTarget } from '@kontourai/station-contracts/execution-target';
import type { ProviderAdapterShape } from '../../providers/adapter-shape.js';
import {
  type NativeAuthenticationContinuation,
  nativeAuthenticationContinuation,
} from '../../providers/auth/native-authentication-context.js';
import {
  type ExecutionTargetResolverDependencies,
  resolveExecutionTarget,
} from '../execution-target/execution-target-resolver.js';
import {
  type CliSessionGroupRunAdmission,
  CliSessionGroupUnavailable,
} from './cli-session-group.js';

export type EnsembleSessionGroupAuthenticationInput = {
  groupId: string;
  intentDigest: string;
  members: Array<{ seatId: string; target: ExecutionTarget }>;
  signal: AbortSignal;
};

/** Login observations are private run prerequisites, never execution grants. */
export async function authenticateEnsembleSessionGroup(
  input: EnsembleSessionGroupAuthenticationInput,
  inventory: ExecutionTargetResolverDependencies,
  principalId: string,
  assertAuthority: () => void,
): Promise<CliSessionGroupRunAdmission> {
  const members = structuredClone(input.members);
  const fence = inventory.capturePreparationFence?.(
    members.map((m) => m.target),
  );
  if (!fence) throw new CliSessionGroupUnavailable('ensemble_auth_unsupported');
  const current = () => {
    input.signal.throwIfAborted();
    fence();
    assertAuthority();
  };
  const identity = (
    value: Awaited<ReturnType<typeof resolveExecutionTarget>>,
  ) => {
    const { resolvedAt: _at, ...receipt } = value.receipt;
    return canonicalJson({
      receipt,
      definitions: value.preparationDefinitions,
    });
  };
  current();
  const selections: Array<{
    seatId: string;
    target: ExecutionTarget;
    resolved: Awaited<ReturnType<typeof resolveExecutionTarget>>;
    adapter: ProviderAdapterShape;
    observe: NonNullable<
      ProviderAdapterShape['observeExecutionAuthentication']
    >;
    connectionId: string;
    model: string;
    cwd: string;
    directory: Stats;
    identity: string;
    checkedAt: number;
    nativeContinuation?: NativeAuthenticationContinuation;
  }> = [];
  // Establish support for the whole roster before any authentication command.
  for (const member of members) {
    const resolved = await resolveExecutionTarget(member.target, inventory, {
      purpose: 'preparation',
    });
    current();
    const adapter = inventory.getProviderAdapter(resolved.provider);
    const workspace = resolved.workspace;
    if (
      resolved.access.kind !== 'current' ||
      resolved.engine.kind !== 'connection' ||
      !adapter?.observeExecutionAuthentication ||
      adapter.metadata.connectionId !== resolved.engine.connectionId ||
      !resolved.preparationDefinitions ||
      !resolved.modelId ||
      !workspace ||
      !('cwd' in workspace) ||
      !workspace.cwd ||
      (workspace.kind === 'project' &&
        workspace.workspaceIsolation?.mode !== 'shared') ||
      realpathSync(workspace.cwd) !== workspace.cwd
    )
      throw new CliSessionGroupUnavailable('ensemble_auth_unsupported');
    const cwd = workspace.cwd;
    const directory = statSync(cwd);
    if (!directory.isDirectory())
      throw new CliSessionGroupUnavailable('ensemble_auth_unsupported');
    selections.push({
      ...member,
      resolved,
      adapter,
      observe: adapter.observeExecutionAuthentication.bind(adapter),
      connectionId: resolved.engine.connectionId,
      model: resolved.modelId,
      cwd,
      directory,
      identity: identity(resolved),
      checkedAt: 0,
    });
  }
  const assertSelection = (selection: (typeof selections)[number]) => {
    current();
    const directory = statSync(selection.cwd);
    if (
      realpathSync(selection.cwd) !== selection.cwd ||
      directory.dev !== selection.directory.dev ||
      directory.ino !== selection.directory.ino ||
      !directory.isDirectory() ||
      inventory.getProviderAdapter(selection.resolved.provider) !==
        selection.adapter
    )
      throw new CliSessionGroupUnavailable('ensemble_binding_changed');
    current();
  };
  const observe = async (selection: (typeof selections)[number]) => {
    const assertCurrent = async () => {
      assertSelection(selection);
      const resolved = await resolveExecutionTarget(
        selection.target,
        inventory,
        {
          purpose: 'preparation',
        },
      );
      assertSelection(selection);
      if (identity(resolved) !== selection.identity)
        throw new CliSessionGroupUnavailable('ensemble_binding_changed');
      return () => assertSelection(selection);
    };
    (await assertCurrent())();
    const started = Date.now();
    const observation = await selection.observe({
      principalId,
      bindingHash: createHash('sha256')
        .update(
          canonicalJson([
            input.groupId,
            input.intentDigest,
            selection.seatId,
            selection.identity,
          ]),
        )
        .digest('hex'),
      connectionId: selection.connectionId,
      cwd: selection.cwd,
      model: selection.model,
      modelOptions: selection.target.model?.options ?? {},
      credentialProfileRef:
        selection.resolved.preparationDefinitions?.executionAgent.execution
          ?.credentialProfileRef,
      signal: input.signal,
      assertCurrent,
    });
    (await assertCurrent())();
    if (
      observation.state !== 'authenticated' ||
      !Number.isFinite(observation.checkedAt) ||
      observation.checkedAt < started ||
      observation.checkedAt > Date.now() ||
      Date.now() - observation.checkedAt > 30_000
    )
      throw new CliSessionGroupUnavailable('ensemble_auth_unverified');
    const continuation = nativeAuthenticationContinuation(observation);
    if (!continuation)
      throw new CliSessionGroupUnavailable('ensemble_auth_unsupported');
    continuation.assertCurrent();
    selection.checkedAt = observation.checkedAt;
    selection.nativeContinuation = continuation;
  };
  for (const selection of selections) await observe(selection);
  for (const selection of selections) {
    assertSelection(selection);
    selection.nativeContinuation?.assertCurrent();
    if (Date.now() - selection.checkedAt >= 30_000)
      throw new CliSessionGroupUnavailable('ensemble_auth_stale');
  }
  const refreshing = new Map<string, Promise<void>>();
  return {
    invokeDispatch(seatId, sessionId, work) {
      const selection = selections.find((s) => s.seatId === seatId);
      if (!selection)
        throw new CliSessionGroupUnavailable('ensemble_binding_changed');
      const checkedAt = selection.checkedAt;
      if (!selection.nativeContinuation)
        throw new CliSessionGroupUnavailable('ensemble_auth_unsupported');
      return selection.nativeContinuation.invoke(
        selection.adapter,
        sessionId,
        () => {
          if (
            checkedAt !== selection.checkedAt ||
            Date.now() < checkedAt ||
            Date.now() - checkedAt >= 30_000
          )
            throw new CliSessionGroupUnavailable('ensemble_auth_stale');
          assertSelection(selection);
        },
        work,
      );
    },
    async prepareDispatch(seatId) {
      const selection = selections.find((s) => s.seatId === seatId);
      if (!selection)
        throw new CliSessionGroupUnavailable('ensemble_binding_changed');
      assertSelection(selection);
      if (Date.now() - selection.checkedAt >= 30_000) {
        let observation = refreshing.get(seatId);
        if (!observation) {
          observation = observe(selection).finally(() =>
            refreshing.delete(seatId),
          );
          refreshing.set(seatId, observation);
        }
        await observation;
      }
      const checkedAt = selection.checkedAt;
      const assertCurrent = () => {
        if (
          checkedAt !== selection.checkedAt ||
          Date.now() < checkedAt ||
          Date.now() - checkedAt >= 30_000
        )
          throw new CliSessionGroupUnavailable('ensemble_auth_stale');
        assertSelection(selection);
        selection.nativeContinuation?.assertCurrent();
      };
      assertCurrent();
      return assertCurrent;
    },
  };
}
