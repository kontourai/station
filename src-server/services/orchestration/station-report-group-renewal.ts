import { timingSafeEqual } from 'node:crypto';
import type { AuthorizationLedger } from '@kontourai/dispatch';
import { validateRootAuthorityV2 } from '@kontourai/flow-agents/delegation-authority-contract';
import { createDelegationAuthorityServiceV3 } from '@kontourai/flow-agents/delegation-authority-service-v3';
import {
  delegationEnvelopeDigestV2,
  delegationParentReferenceV2,
  rootAuthorityReferenceV2,
  validateDelegationEnvelopeV2,
} from '@kontourai/flow-agents/delegation-envelope-v2';
import { createDelegationRoundsController } from '@kontourai/flow-agents/delegation-group-rounds';
import { canonicalJson } from '@kontourai/relay';
import { REPORT_GROUP_RENEWAL_LIMITS } from '@kontourai/station-contracts/report-group';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { inputRequestFromRequestEvent } from '@kontourai/station-shared/input-request';
import { z } from 'zod/v3';
import { REPORT_INPUT_TOOL_NAME } from '../../runtime/conversation/report-input-profile.js';
import type { EnvironmentSecurityService } from '../ssh/environment-security-service.js';
import type { StationDelegationPersistence } from './delegation-group-persistence.js';
import type { RuntimeSourceRequestContext } from './delegation-group-source-admission.js';
import type { OrchestrationService } from './orchestration-service.js';
import { reportAdmissionSignature } from './station-report-group-admission.js';
import type { StationReportGroupCustody } from './station-report-group-custody.js';
import { StationReportPreparationUnavailable } from './station-report-group-input.js';
import type { StationReportRetainedTurns } from './station-report-retained-turn.js';

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const inputSchema = z
  .object({
    operationKey: id.max(REPORT_GROUP_RENEWAL_LIMITS.operationKeyCodeUnits),
    seatId: id,
    expectedRevision: z.number().int().nonnegative().safe(),
  })
  .strict();
const DOMAIN = 'station.report-renewal.v1';
const recordSchema = z
  .object({
    data: z
      .object({
        groupId: z.string(),
        operation: inputSchema,
        admissionSignature: z.string(),
        predecessor: z.unknown(),
        inputReceipt: z.unknown(),
        inputInvocationId: z.string(),
        root: z.unknown(),
        envelopes: z.array(z.unknown()),
        authorityRevision: z.number().int().nonnegative().safe(),
      })
      .strict(),
    signature: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();
function refuse(): never {
  throw new StationReportPreparationUnavailable();
}
type Candidate = Awaited<
  ReturnType<StationReportRetainedTurns['prepareRenewalCandidate']>
>;

/** Server-issued no-tools successor; a stored receipt can replay adoption, never recreate a wire. */
export class StationReportGroupRenewal {
  constructor(
    private readonly owners: {
      custody: StationReportGroupCustody;
      turns: StationReportRetainedTurns;
      persistence: StationDelegationPersistence;
      orchestration: OrchestrationService;
      environment: EnvironmentSecurityService;
      dispatchLedger: AuthorizationLedger;
      authorize(context: RuntimeSourceRequestContext): Promise<() => void>;
    },
  ) {
    this.owners = Object.freeze({ ...owners });
  }

  async narrowAfterInput(
    context: RuntimeSourceRequestContext,
    groupId: string,
    sent: unknown,
  ) {
    const operation = inputSchema.parse(structuredClone(sent));
    const authorize = await this.owners.authorize(context);
    const current = (): undefined => {
      authorize();
      context.req.raw.signal.throwIfAborted();
      return undefined;
    };
    const { custody, persistence, turns, orchestration, environment } =
      this.owners;
    const loaded = await custody.loadIntentForMutation(context, groupId);
    const { group, authority, intent, admission } = loaded;
    const epoch = authority?.epochs.at(-1);
    const member = admission.members.find(
      (entry) => entry.seatId === operation.seatId,
    );
    const original = intent.members.find(
      (entry) => entry.seatId === operation.seatId,
    );
    if (
      !group ||
      !authority ||
      !epoch ||
      !member ||
      original?.input !== 'operator-clarification-v1' ||
      !intent.continuation?.maxRenewals ||
      group.spec.topology.kind !== 'flow' ||
      group.cancellation !== 'none' ||
      authority.cancelled
    )
      refuse();
    const renewalKey = `renew:${operation.operationKey}`;
    const prior = authority.epochs.find(
      (entry) => entry.renewal?.command.operationKey === renewalKey,
    );
    const signatureFor = (data: z.infer<typeof recordSchema>['data']) =>
      environment.signRevisionEvidenceAuthorityBinding(
        canonicalJson([DOMAIN, data]),
      );
    const readReceipt = async (
      reference: Parameters<typeof persistence.readReportFlowObservation>[1],
    ) => {
      const observed = await persistence.readReportFlowObservation(
        groupId,
        reference,
        current,
      );
      if (observed.kind !== 'continuation') refuse();
      const record = recordSchema.parse(observed.value);
      const expected = Buffer.from(signatureFor(record.data), 'base64url');
      const actual = Buffer.from(record.signature, 'base64url');
      if (
        expected.length !== actual.length ||
        !timingSafeEqual(expected, actual) ||
        record.data.groupId !== groupId ||
        !same(record.data.operation, operation) ||
        record.data.admissionSignature !==
          reportAdmissionSignature(admission, environment)
      )
        refuse();
      return record;
    };
    let root = epoch.root;
    let envelopes = epoch.envelopes;
    let receipt: Parameters<typeof persistence.readReportFlowObservation>[1];
    let record: z.infer<typeof recordSchema>;
    const candidates = new Map<string, Candidate>();
    try {
      if (prior?.renewal) {
        receipt = prior.renewal.command.hostReceipt;
        record = await readReceipt(receipt);
        root = validateRootAuthorityV2(record.data.root);
        envelopes = record.data.envelopes.map(validateDelegationEnvelopeV2);
        if (!same(root, prior.root) || !same(envelopes, prior.envelopes))
          refuse();
      } else {
        if (
          group.revision !== operation.expectedRevision ||
          Date.now() >= intent.deadlineAt ||
          group.grants.authority.authority_epoch !==
            epoch.root.authority_epoch ||
          !group.rounds.every((entry) => entry.returned) ||
          !group.continuations.every((entry) => entry.receipt)
        )
          refuse();
        const attempt = group.attempts
          .filter((entry) => entry.seatId === operation.seatId)
          .at(-1);
        if (!attempt?.terminal || !attempt.observation) refuse();
        const result = await persistence.readReportObservation(
          groupId,
          attempt.invocationId,
          attempt.observation,
          current,
        );
        if (
          result.observation.kind !== 'result' ||
          !result.observation.inputReceipt
        )
          refuse();
        const inputReceipt = result.observation.inputReceipt;
        const answer = await persistence.readReportInputReceipt(
          inputReceipt,
          {
            groupId,
            seatId: operation.seatId,
            invocationId: attempt.invocationId,
            threadId: member.reservedTaskId,
          },
          current,
        );
        const origin = authority.origins.find(
          (entry) => entry.invocationId === attempt.invocationId,
        );
        const inputEpoch = origin && authority.epochs[origin.epoch];
        const inputEnvelope = inputEpoch?.envelopes.find(
          (entry) => entry.envelope_id === answer.binding.envelope.id,
        );
        const invocation = authority.invocations.find(
          (entry) => entry.invocationId === attempt.invocationId,
        );
        if (
          !inputEpoch ||
          !inputEnvelope ||
          !invocation?.terminal ||
          !same(invocation.usage, answer.binding.usage) ||
          !same(
            rootAuthorityReferenceV2(inputEpoch.root),
            answer.binding.authority,
          ) ||
          inputEnvelope.execution_id !== member.reservedTaskId ||
          answer.response.action !== 'accept' ||
          !answer.question ||
          !same(inputEnvelope.execution_authority.allowed_tools, [
            REPORT_INPUT_TOOL_NAME,
          ])
        )
          refuse();
        if (
          inputEnvelope.generation !== answer.binding.envelope.generation ||
          delegationEnvelopeDigestV2(inputEnvelope) !==
            answer.binding.envelope.digest
        )
          refuse();
        const terminal = await persistence.readReportObservation(
          groupId,
          attempt.invocationId,
          attempt.terminal,
          current,
        );
        if (
          terminal.observation.kind !== 'terminal' ||
          terminal.observation.sessionId !== answer.binding.threadId ||
          terminal.observation.turnId !== answer.binding.turnId ||
          !same(terminal.observation.evidence, answer.binding.providerEvidence)
        )
          refuse();
        await persistence.assertProviderEvidenceReference(
          answer.binding.providerEvidence,
          {
            groupId,
            rootId: answer.binding.rootId,
            invocationId: attempt.invocationId,
            executionId: member.reservedTaskId,
            usage: answer.binding.usage,
            inputIntent: {
              seatId: operation.seatId,
              root: answer.binding.authority,
              envelope: answer.binding.envelope,
            },
          },
          current,
        );
        const event = orchestration.readSessionEventById(
          member.reservedTaskId,
          answer.question.eventId,
          sessionReadAuthorityFromRequest(
            root.authenticated_principal_ref.id,
            undefined,
            undefined,
          ),
        );
        if (
          event?.method !== 'request.opened' ||
          event.eventId !== answer.question.eventId ||
          event.provider !== 'station-agent' ||
          event.threadId !== answer.binding.threadId ||
          event.turnId !== answer.binding.turnId ||
          event.requestId !== answer.question.requestId ||
          !same(inputRequestFromRequestEvent(event), answer.question.form)
        )
          refuse();
        const outcome = orchestration.readRequestOutcome(
          answer.binding.threadId,
          answer.question.requestId,
        );
        if (outcome.state !== 'resolved' || outcome.status !== 'approved')
          refuse();
        for (const entry of admission.members) {
          current();
          const candidate = await turns.prepareRenewalCandidate(
            context,
            groupId,
            entry.seatId,
            entry.seatId === operation.seatId,
          );
          candidates.set(entry.seatId, candidate);
          candidate.assertCurrent();
        }
        const selected = candidates.get(operation.seatId) ?? refuse();
        if (!same(selected.recipient(), answer.binding.recipient)) refuse();
        root = validateRootAuthorityV2({
          ...epoch.root,
          authority_epoch: epoch.root.authority_epoch + 1,
          execution_grants: epoch.root.execution_grants.map((grant) => ({
            ...grant,
            ...(candidates.get(grant.grant_id) ?? refuse()).binding,
          })),
        });
        const first = root.execution_grants[0] ?? refuse();
        root = validateRootAuthorityV2({
          ...root,
          source_origin: {
            repository_id: first.source.repository_id,
            worktree_id: first.source.execution_worktree_id,
            source_state_id: first.source.source_state_id,
            dirty_state_fingerprint: first.source.dirty_state_fingerprint,
          },
        });
        envelopes = [];
        for (const old of epoch.envelopes) {
          const grant =
            root.execution_grants.find(
              (entry) => entry.grant_id === old.selected_grant_id,
            ) ?? refuse();
          const parent =
            old.parent &&
            envelopes.find((entry) => entry.envelope_id === old.parent!.id);
          if (old.parent && !parent) refuse();
          const target = old.execution_id === member.reservedTaskId;
          if (
            target &&
            !same(old.execution_authority.allowed_tools, [
              REPORT_INPUT_TOOL_NAME,
            ])
          )
            refuse();
          envelopes.push(
            validateDelegationEnvelopeV2({
              ...old,
              root_authority_ref: rootAuthorityReferenceV2(root),
              execution_binding: {
                runtime: grant.runtime,
                source: grant.source,
                flow_binding: grant.flow_binding,
              },
              parent: parent ? delegationParentReferenceV2(parent) : null,
              execution_authority: target
                ? { ...old.execution_authority, allowed_tools: [] }
                : old.execution_authority,
            }),
          );
        }
        const data = {
          groupId,
          operation,
          admissionSignature: reportAdmissionSignature(admission, environment),
          predecessor: rootAuthorityReferenceV2(epoch.root),
          inputReceipt,
          inputInvocationId: attempt.invocationId,
          root,
          envelopes,
          authorityRevision: authority.revision,
        };
        for (const candidate of candidates.values()) candidate.assertCurrent();
        record = recordSchema.parse({ data, signature: signatureFor(data) });
        receipt = await persistence.retainReportFlowObservation(
          groupId,
          'continuation',
          record,
          current,
        );
      }
      const publicationCurrent = (): undefined => {
        current();
        for (const witness of candidates.values()) witness.assertCurrent();
        return undefined;
      };
      const service = createDelegationAuthorityServiceV3(
        persistence.roundsAuthorityStore(publicationCurrent),
        {
          now: () => new Date(Date.now()).toISOString(),
          authorize: async (action, candidate) => {
            current();
            return action === 'inspect' && same(candidate, root);
          },
          confirmExecution: async (candidate, candidateRoot) => {
            current();
            if (
              prior ||
              !same(candidateRoot, root) ||
              !envelopes.some((entry) => same(entry, candidate))
            )
              return false;
            for (const witness of candidates.values()) witness.assertCurrent();
            return true;
          },
          authenticateRenewal: async ({
            action,
            current: observed,
            command,
          }) => {
            current();
            const retained = await readReceipt(receipt);
            if (
              !same(retained, record) ||
              !same(command.root, root) ||
              !same(command.envelopes, envelopes) ||
              command.operationKey !== renewalKey ||
              !same(command.hostReceipt, receipt) ||
              !same(command.previousAuthority, record.data.predecessor) ||
              command.expectedRevision !== record.data.authorityRevision
            )
              return null;
            if (action === 'renew') {
              if (prior || !same(observed, authority)) return null;
              for (const witness of candidates.values())
                witness.assertCurrent();
            }
            return receipt;
          },
        },
        { maxRenewals: intent.continuation.maxRenewals },
      );
      await service.renew({
        schemaVersion: '3.1',
        authorityId: root.authority_id,
        operationKey: renewalKey,
        expectedRevision: record.data.authorityRevision,
        previousAuthority: record.data.predecessor,
        root,
        envelopes,
        hostReceipt: receipt,
      });
      const adoption = {
        kind: 'adoptRenewal' as const,
        groupId,
        operationKey: `adopt:${operation.operationKey}`,
        expectedRevision: group.revision,
        controller: group.spec.controller,
        renewalOperationKey: renewalKey,
        authority: rootAuthorityReferenceV2(root),
      };
      const controller = createDelegationRoundsController({
        store: persistence.roundsStore(publicationCurrent),
        authorityService: service,
        dispatchLedger: this.owners.dispatchLedger,
        host: {
          authorize: async ({
            action,
            groupId: candidate,
            current: projection,
            command,
          }) => {
            current();
            return (action === 'adoptRenewal' || action === 'replay') &&
              same(command, adoption) &&
              candidate === groupId &&
              (!projection || same(projection.spec, admission.spec))
              ? root.authenticated_principal_ref
              : null;
          },
          executionHost: () => refuse(),
          prepareRequest: async () => refuse(),
          retainObservation: async () => refuse(),
          confirmTerminal: async () => refuse(),
          requestDescendantCancellation: async () => refuse(),
        },
      });
      if (group.grants.authority.authority_epoch < root.authority_epoch) {
        await controller.adoptRenewal(adoption);
      }
      current();
      return { replayed: !!prior };
    } finally {
      const closed = await Promise.allSettled(
        [...candidates.values()].map((candidate) => candidate.close()),
      );
      if (closed.some((entry) => entry.status === 'rejected')) refuse();
    }
  }
}
