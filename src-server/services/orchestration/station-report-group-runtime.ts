import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { FileAuthorizationLedger } from '@kontourai/dispatch';
import type {
  ReportGroupFinalizeCancelInput,
  ReportGroupView,
} from '@kontourai/station-contracts/report-group';
import { AnthropicSealedPreparation } from '../../runtime/conversation/anthropic-sealed-preparation.js';
import {
  captureEnvironmentLocalGrantObservationOwner,
  captureEnvironmentLocalGrantReadOwner,
} from '../../runtime/conversation/local-grant-observation-owner.js';
import type { RuntimeFencedCredentialObservationOwners } from '../../runtime/conversation/runtime-fenced-credential-observation.js';
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
import {
  StationReportCustodyUnavailable,
  StationReportGroupCustody,
} from './station-report-group-custody.js';
import { StationReportGroupExecution } from './station-report-group-execution.js';
import { StationReportGroupPreparation } from './station-report-group-preparation.js';

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
  readonly #dispatch: FileAuthorizationLedger;
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
    let prepared: Promise<StationReportGroupPreparation> | undefined;
    this.#execution = new StationReportGroupExecution({
      preparation: () =>
        (prepared ??= AnthropicSealedPreparation.create().then(
          (qualification) =>
            new StationReportGroupPreparation({
              runtime: owners.runtime,
              sources,
              qualification,
              rawFetch: owners.rawFetch,
            }),
        )),
      custody: this.#custody,
      persistence,
      orchestration: owners.orchestration,
      dispatchLedger: this.#dispatch,
      wireIntents: new FileFinalWireIntentStore(root),
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
      lease.assertCurrent();
      this.#assertCurrent(context);
    };
    current();
    return current;
  }
  #assertCurrent(context: RuntimeSourceRequestContext) {
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
  }
  async create(context: RuntimeSourceRequestContext, input: unknown) {
    const result = await this.#execution.execute(context, input);
    if (!result.group) throw new StationReportCustodyUnavailable();
    return { replayed: result.replayed, group: view(result.group) };
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
