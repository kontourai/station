import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { FileAuthorizationLedger } from '@kontourai/dispatch';
import { preparedRoundsSyncDigest } from '@kontourai/flow-agents/delegation-group-rounds';
import type {
  ReportGroupAmounts,
  ReportGroupContextSyncInput,
  ReportGroupContextSyncView,
  ReportGroupFinalizeCancelInput,
  ReportGroupFinalizeSyncInput,
  ReportGroupInputSyncInput,
  ReportGroupReportInput,
  ReportGroupView,
} from '@kontourai/station-contracts/report-group';
import {
  captureEnvironmentLocalGrantObservationOwner,
  captureEnvironmentLocalGrantReadOwner,
} from '../../runtime/conversation/local-grant-observation-owner.js';
import type { RuntimeFencedCredentialObservationOwners } from '../../runtime/conversation/runtime-fenced-credential-observation.js';
import { createSealedProviderPreparation } from '../../runtime/conversation/sealed-provider-preparation.js';
import { isOperatorInPersonNotAgent } from '../../security/coding-authority.js';
import {
  isBoundLocalGrantMintedOperator,
  isRuntimeRequestPrincipalCurrent,
} from '../../security/runtime-request-security.js';
import { StationDelegationPersistence } from './delegation-group-persistence.js';
import {
  LocalSourceAdmissionOwner,
  type RuntimeSourceRequestContext,
} from './delegation-group-source-admission.js';
import { pageByBytes } from './delegation-group-transport.js';
import { FileFinalWireIntentStore } from './delegation-group-wire-intent-store.js';
import type { OrchestrationService } from './orchestration-service.js';
import { StationReportGroupContinuation } from './station-report-group-continuation.js';
import {
  StationReportCustodyUnavailable,
  StationReportGroupCustody,
} from './station-report-group-custody.js';
import { StationReportGroupExecution } from './station-report-group-execution.js';
import { StationReportGroupPreparation } from './station-report-group-preparation.js';
import { StationReportGroupRenewal } from './station-report-group-renewal.js';
import { StationReportRetainedTurns } from './station-report-retained-turn.js';

function directory(path: string) {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realpathSync(path) !== path ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700
  )
    throw new StationReportCustodyUnavailable();
}

type Historical = NonNullable<
  Awaited<ReturnType<StationReportGroupCustody['inspect']>>
>;
function view(value: Historical): ReportGroupView {
  const { admission, group, authority } = value;
  const contextSyncs: ReportGroupContextSyncView[] = (
    group?.continuations ?? []
  ).flatMap((entry) => {
    if (entry.command.kind !== 'sync') return [];
    const prepared = entry.prepared;
    return [
      {
        operationKey: entry.command.operationKey,
        seatId: entry.command.seatId,
        flowHead: entry.command.flowHead,
        state: entry.receipt
          ? entry.receipt.acknowledged
            ? 'acknowledged'
            : 'incomplete'
          : prepared
            ? 'prepared'
            : 'pending',
        reason: prepared?.receipt.reason ?? null,
        preparedDigest: prepared ? preparedRoundsSyncDigest(prepared) : null,
        attempts: prepared
          ? prepared.invocations.map((invocation) => {
              const current =
                authority?.invocations.find(
                  (i) => i.invocationId === invocation.invocationId,
                ) ?? invocation;
              return {
                invocationId: current.invocationId,
                allocation: current.allocation,
                usage: current.usage,
                accountingTerminal: current.terminal,
                terminal:
                  prepared.terminalProofs.find(
                    (proof) => proof.invocationId === current.invocationId,
                  )?.reference ?? null,
              };
            })
          : null,
      },
    ];
  });
  const sum = (rows: ReportGroupAmounts[]): ReportGroupAmounts =>
    rows.reduce(
      (total, row) => ({
        inputTokens: total.inputTokens + row.inputTokens,
        outputTokens: total.outputTokens + row.outputTokens,
        costMicros: total.costMicros + row.costMicros,
      }),
      { inputTokens: 0, outputTokens: 0, costMicros: 0 },
    );
  const unsettled =
    authority?.invocations.filter((i) => !i.terminal || i.usage === null) ?? [];
  return {
    version: 'station.report-group/v1' as const,
    groupId: admission.spec.groupId,
    operationId: admission.root.revisions.policy.id,
    revision: group?.revision ?? 0,
    topology:
      admission.spec.topology.kind === 'flow'
        ? { kind: 'flow', runId: admission.spec.topology.runId }
        : { kind: 'independent-advisory' },
    execution: !group
      ? ('not-created' as const)
      : group.rounds.length === 0
        ? ('idle' as const)
        : group.rounds.every((round) => round.returned)
          ? ('returned' as const)
          : ('unknown' as const),
    cancellation: group?.cancellation ?? 'none',
    authorityRevoked: authority?.cancelled ?? false,
    acceptance: 'unassessed' as const,
    ...(contextSyncs.length ? { contextSyncs } : {}),
    ...(group?.spec.topology.kind === 'flow'
      ? {
          contextSyncAllowance: {
            maximumOperations: group.spec.policy.maxSyncs ?? 0,
            recordedOperations: contextSyncs.length,
          },
        }
      : {}),
    ...(authority
      ? {
          accounting: {
            invocationCount: authority.invocations.length,
            unsettledInvocations: unsettled.length,
            knownTerminalUsage: sum(
              authority.invocations.flatMap((i) =>
                i.terminal && i.usage !== null ? [i.usage] : [],
              ),
            ),
            unsettledAllocation: sum(unsettled.map((i) => i.allocation)),
          },
        }
      : {}),
    members: admission.members.map((member) => ({
      seatId: member.seatId,
      agentId: member.agentId,
      taskId: member.reservedTaskId,
      clientTurnId: member.reservedClientTurnId,
      requestedModelId: member.requestedModelId,
      attempts: (group?.attempts ?? [])
        .filter((a) => a.seatId === member.seatId)
        .map((attempt) => {
          const invocation = authority?.invocations.find(
            (i) => i.invocationId === attempt.invocationId,
          );
          return {
            invocationId: attempt.invocationId,
            observation: attempt.observation,
            terminal: attempt.terminal,
            allocation: invocation?.allocation ?? null,
            usage: invocation?.usage ?? null,
            accountingTerminal: invocation?.terminal ?? false,
          };
        }),
    })),
  };
}

/** One personal-host custody root. Qualification is lazy so historical reads and
 * exact replay remain available when a provider profile expires. */
export class StationReportGroupRuntime {
  readonly #custody: StationReportGroupCustody;
  readonly #execution: StationReportGroupExecution;
  readonly #continuation: StationReportGroupContinuation;
  readonly #retainedTurns: StationReportRetainedTurns;
  readonly #renewal: StationReportGroupRenewal;
  readonly #dispatch: FileAuthorizationLedger;
  readonly #wireIntents: FileFinalWireIntentStore;
  constructor(
    private readonly owners: {
      runtime: RuntimeFencedCredentialObservationOwners;
      orchestration: OrchestrationService;
      rawFetch: typeof fetch;
    },
  ) {
    this.owners = Object.freeze({
      ...owners,
      runtime: Object.freeze({ ...owners.runtime }),
    });
    owners = this.owners;
    const home = realpathSync(owners.runtime.configLoader.getProjectHomeDir());
    const root = join(home, 'report-groups');
    directory(root);
    const sourcesRoot = join(root, 'sources');
    directory(sourcesRoot);
    const dispatchRoot = join(root, 'dispatch');
    directory(dispatchRoot);
    const persistence = new StationDelegationPersistence(root);
    this.#dispatch = new FileAuthorizationLedger({ root: dispatchRoot });
    this.#custody = new StationReportGroupCustody({
      persistence,
      environment: owners.runtime.environmentSecurityService,
      security: owners.runtime.requestSecurity,
    });
    const sources = new LocalSourceAdmissionOwner(
      home,
      owners.runtime.environmentSecurityService,
      sourcesRoot,
    );
    const wireIntents = new FileFinalWireIntentStore(root);
    this.#wireIntents = wireIntents;
    this.#retainedTurns = new StationReportRetainedTurns({
      runtime: owners.runtime,
      sources,
      custody: this.#custody,
      persistence,
      orchestration: owners.orchestration,
      rawFetch: owners.rawFetch,
    });
    this.#renewal = new StationReportGroupRenewal({
      custody: this.#custody,
      turns: this.#retainedTurns,
      persistence,
      orchestration: owners.orchestration,
      environment: owners.runtime.environmentSecurityService,
      dispatchLedger: this.#dispatch,
      authorize: (context) => this.authorizeResponse(context),
    });
    this.#continuation = new StationReportGroupContinuation({
      environment: owners.runtime.environmentSecurityService,
      custody: this.#custody,
      persistence,
      orchestration: owners.orchestration,
      dispatchLedger: this.#dispatch,
      wireIntents,
      authorize: (context) => this.authorizeResponse(context),
      turns: this.#retainedTurns,
    });
    let prepared: Promise<StationReportGroupPreparation> | undefined;
    this.#execution = new StationReportGroupExecution({
      environment: owners.runtime.environmentSecurityService,
      authorize: (context) => this.authorizeResponse(context),
      preparation: () =>
        (prepared ??= Promise.resolve(
          new StationReportGroupPreparation({
            runtime: owners.runtime,
            sources,
            qualification: createSealedProviderPreparation,
            rawFetch: owners.rawFetch,
          }),
        )),
      custody: this.#custody,
      persistence,
      orchestration: owners.orchestration,
      dispatchLedger: this.#dispatch,
      wireIntents,
    });
  }

  async authorizeResponse(context: RuntimeSourceRequestContext) {
    this.#assertCurrent(context);
    const lease =
      context.req.raw.method === 'GET'
        ? await captureEnvironmentLocalGrantReadOwner(
            context.req.raw,
            this.owners.runtime.environmentSecurityService,
            this.owners.runtime.requestSecurity,
          )
        : (
            await captureEnvironmentLocalGrantObservationOwner(
              context.req.raw,
              this.owners.runtime.environmentSecurityService,
              this.owners.runtime.requestSecurity,
            )
          ).requireCurrentLocalGrant(context.req.raw);
    const current = () => {
      return this.owners.runtime.environmentSecurityService.withCurrentAuthority(
        () => {
          lease.assertCurrent();
          this.#assertCurrent(context);
        },
      );
    };
    current();
    return current;
  }
  #assertCurrent(context: RuntimeSourceRequestContext) {
    return this.owners.runtime.environmentSecurityService.withCurrentAuthority(
      () => {
        context.req.raw.signal.throwIfAborted();
        if (
          !isOperatorInPersonNotAgent(context.req.raw) ||
          !isBoundLocalGrantMintedOperator(context.req.raw) ||
          !isRuntimeRequestPrincipalCurrent(
            context.req.raw,
            this.owners.runtime.requestSecurity,
          )
        )
          throw new StationReportCustodyUnavailable();
      },
    );
  }
  async create(context: RuntimeSourceRequestContext, input: unknown) {
    const result = await this.#execution.execute(context, input);
    if (!result.group) throw new StationReportCustodyUnavailable();
    return { replayed: result.replayed, group: view(result.group) };
  }
  async checkpoint(
    context: RuntimeSourceRequestContext,
    groupId: string,
    seatId: string,
    expectedRevision: number,
  ) {
    const current = await this.authorizeResponse(context);
    const result = await this.#retainedTurns.checkpoint(
      context,
      groupId,
      seatId,
      expectedRevision,
    );
    current();
    return result;
  }
  async narrowAfterInput(
    context: RuntimeSourceRequestContext,
    groupId: string,
    command: unknown,
  ) {
    const result = await this.#renewal.narrowAfterInput(
      context,
      groupId,
      command,
    );
    const historical = await this.#custody.inspectForMutation(context, groupId);
    if (!historical) throw new StationReportCustodyUnavailable();
    return { replayed: result.replayed, group: view(historical) };
  }

  // UNWIRED(#91): the public accounting-recovery transport is not mounted yet.
  async recoverAccounting(
    context: RuntimeSourceRequestContext,
    groupId: string,
    input: { seatId: string; invocationId: string; operationKey: string },
  ) {
    const recovered = await this.#custody.recoverAccounting(
      context,
      groupId,
      input,
      this.owners.orchestration,
      this.#wireIntents,
      this.#dispatch,
    );
    const historical = await this.#custody.inspectForMutation(context, groupId);
    if (!historical) throw new StationReportCustodyUnavailable();
    return { ...input, recovered, group: view(historical) };
  }

  async report(
    context: RuntimeSourceRequestContext,
    groupId: string,
    command: ReportGroupReportInput,
  ) {
    const result = await this.#continuation.report(context, groupId, command);
    const historical = await this.#custody.inspectForMutation(context, groupId);
    if (!historical) throw new StationReportCustodyUnavailable();
    const round =
      result.projection.rounds.findIndex(
        (entry) => entry.operationKey === command.operationKey,
      ) + 1;
    const attempt = result.projection.attempts.find(
      (entry) => entry.round === round && entry.seatId === command.seatId,
    );
    if (!attempt) throw new StationReportCustodyUnavailable();
    return {
      replayed: result.replayed,
      group: view(historical),
      operationKey: command.operationKey,
      seatId: command.seatId,
      invocationId: attempt.invocationId,
    };
  }

  async syncAfterInput(
    context: RuntimeSourceRequestContext,
    groupId: string,
    command: ReportGroupInputSyncInput,
  ) {
    const text = await this.#renewal.recoverAnswerContext(
      context,
      groupId,
      command.seatId,
      command.renewalOperationKey,
    );
    const { renewalOperationKey: _renewalOperationKey, ...sync } = command;
    return this.sync(context, groupId, { ...sync, text });
  }

  async sync(
    context: RuntimeSourceRequestContext,
    groupId: string,
    command: ReportGroupContextSyncInput,
  ) {
    const result = await this.#continuation.sync(context, groupId, command);
    const historical = await this.#custody.inspectForMutation(context, groupId);
    if (!historical) throw new StationReportCustodyUnavailable();
    return { replayed: result.replayed, group: view(historical) };
  }
  async finalizeSync(
    context: RuntimeSourceRequestContext,
    groupId: string,
    command: ReportGroupFinalizeSyncInput,
  ) {
    const result = await this.#custody.finalizeSync(
      context,
      groupId,
      command,
      this.#dispatch,
    );
    const historical = await this.#custody.inspectForMutation(context, groupId);
    if (!historical) throw new StationReportCustodyUnavailable();
    return { replayed: result.replayed, group: view(historical) };
  }
  async get(context: RuntimeSourceRequestContext, groupId: string) {
    const result = await this.#custody.inspect(context, groupId);
    return result ? view(result) : null;
  }
  async list(context: RuntimeSourceRequestContext, afterGroupId?: string) {
    const records = (await this.#custody.list(context)).filter(
      (record) => !afterGroupId || record.admission.spec.groupId > afterGroupId,
    );
    const selected = records.slice(0, 8);
    return {
      groups: selected.map(view),
      hasMore: records.length > selected.length,
      nextGroupId:
        records.length > selected.length
          ? selected.at(-1)!.admission.spec.groupId
          : null,
    };
  }
  async events(
    context: RuntimeSourceRequestContext,
    groupId: string,
    afterRevision: number,
  ) {
    const historical = await this.#custody.inspect(context, groupId);
    if (!historical || afterRevision > (historical.group?.revision ?? 0))
      throw new StationReportCustodyUnavailable();
    const rows = historical.events
      .filter((event) => event.revision > afterRevision)
      .map((event) => ({
        cursor: event.revision,
        value: {
          revision: event.revision,
          kind: event.kind,
          ...(event.kind === 'command'
            ? { commandKind: event.command.kind }
            : {}),
          ...('seatId' in event ? { seatId: event.seatId } : {}),
          ...('invocationId' in event
            ? { invocationId: event.invocationId }
            : {}),
        },
      }));
    return pageByBytes({
      rows,
      after: afterRevision,
      hasMore: false,
      maxItems: 64,
      maxBytes: 262_000,
      format: (events, unavailable, nextRevision, hasMore) => ({
        groupId,
        afterRevision,
        nextRevision,
        revision: historical.group?.revision ?? 0,
        events,
        unavailable,
        hasMore,
      }),
    });
  }
  async result(
    context: RuntimeSourceRequestContext,
    groupId: string,
    seatId: string,
    invocationId: string,
    afterOffset: number,
  ) {
    const result = await this.#custody.readResult(
      context,
      groupId,
      seatId,
      invocationId,
      this.owners.orchestration,
    );
    if (result.kind === 'failure')
      return { kind: result.kind, code: result.code };
    if (afterOffset > result.text.length)
      throw new StationReportCustodyUnavailable();
    const text = result.text.slice(afterOffset, afterOffset + 16_384);
    const nextOffset = afterOffset + text.length;
    return {
      kind: result.kind,
      groupId,
      seatId,
      invocationId,
      modelId: result.modelId,
      text,
      afterOffset,
      nextOffset,
      hasMore: nextOffset < result.text.length,
      usage: {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costMicros: result.costMicros,
      },
    };
  }

  async finalizeCancel(
    context: RuntimeSourceRequestContext,
    groupId: string,
    command: ReportGroupFinalizeCancelInput,
  ) {
    const result = await this.#custody.finalizeCancel(
      context,
      groupId,
      command,
      this.owners.orchestration,
      this.#dispatch,
    );
    return {
      replayed: result.replayed,
      revision: result.projection.revision,
      cancellation: result.projection.cancellation,
    };
  }
  async cancel(
    context: RuntimeSourceRequestContext,
    groupId: string,
    command: { operationKey: string; expectedRevision: number },
  ) {
    const result = await this.#custody.cancel(
      context,
      groupId,
      command,
      this.owners.orchestration,
      this.#dispatch,
    );
    return {
      replayed: result.replayed,
      revision: result.projection.revision,
      cancellation: result.projection.cancellation,
    };
  }
}
