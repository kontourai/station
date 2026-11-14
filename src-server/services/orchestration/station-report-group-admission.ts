import { createHash, timingSafeEqual } from 'node:crypto';
import {
  type RootAuthorityV2,
  validateRootAuthorityV2,
} from '@kontourai/flow-agents/delegation-authority-contract';
import {
  type DelegationEnvelopeV2,
  delegationEnvelopeDigestV2,
  rootAuthorityReferenceV2,
  validateDelegationAncestryV2,
  validateDelegationEnvelopeV2,
} from '@kontourai/flow-agents/delegation-envelope-v2';
import {
  type DelegationRoundsSpec,
  validateDelegationRoundsSpec,
} from '@kontourai/flow-agents/delegation-group-rounds';
import { canonicalJson } from '@kontourai/relay';
import type {
  ReportGroupInput,
  ReportGroupReference,
} from '@kontourai/station-contracts/report-group';
import { z } from 'zod/v3';
import type { EnvironmentSecurityService } from '../ssh/environment-security-service.js';
import {
  encodeReportIntent,
  parseStationReportGroupInput,
  REPORT_INTENT_DOMAIN,
} from './station-report-group-input.js';

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const member = z
  .object({
    seatId: id,
    agentId: id,
    reservedTaskId: z.string().regex(/^task:[0-9a-f-]{36}$/),
    reservedClientTurnId: id,
    requestedModelId: z.string().min(1).max(512),
    runtimeIdentity: z
      .object({
        provider: z.enum(['anthropic', 'google']),
        instructionsDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
  })
  .strict();
const schema = z
  .object({
    data: z
      .object({
        version: z.literal(1),
        credentialDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
        intentRef: z
          .object({
            id: z.string().regex(/^[0-9a-f]{64}$/),
            domain: z.literal(REPORT_INTENT_DOMAIN),
            digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
          })
          .strict()
          .optional(),
        root: z.unknown(),
        envelopes: z.array(z.unknown()).min(2).max(17),
        spec: z.unknown(),
        members: z.array(member).min(1).max(16),
      })
      .strict(),
    signature: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();
export type StationReportAdmission = {
  data: {
    version: 1;
    credentialDigest: string;
    intentRef?: ReportGroupReference;
    root: RootAuthorityV2;
    envelopes: DelegationEnvelopeV2[];
    spec: DelegationRoundsSpec;
    members: z.infer<typeof member>[];
  };
  signature: string;
};
const REPORT_ADMISSION_DOMAIN = 'station.report-group.admission.v1';

export function reportCredentialDigest(credential: string): string {
  return `sha256:${createHash('sha256').update(credential).digest('hex')}`;
}
export function reportAdmissionData(
  prepared: {
    intent?: ReportGroupInput;
    root: RootAuthorityV2;
    envelopes: DelegationEnvelopeV2[];
    spec: DelegationRoundsSpec;
    members: Array<{
      seatId: string;
      agentId: string;
      taskId: string;
      clientTurnId: string;
      modelId: string;
      provider?: 'anthropic' | 'google';
      instructionsDigest?: string;
    }>;
  },
  credentialDigest: string,
): StationReportAdmission['data'] {
  return structuredClone({
    version: 1,
    credentialDigest,
    ...(prepared.intent?.continuation
      ? {
          intentRef: encodeReportIntent(prepared.spec.groupId, prepared.intent)
            .reference,
        }
      : {}),
    root: prepared.root,
    envelopes: prepared.envelopes,
    spec: prepared.spec,
    members: prepared.members.map((member) => ({
      seatId: member.seatId,
      agentId: member.agentId,
      reservedTaskId: member.taskId,
      reservedClientTurnId: member.clientTurnId,
      requestedModelId: member.modelId,
      ...(member.provider && member.instructionsDigest
        ? {
            runtimeIdentity: {
              provider: member.provider,
              instructionsDigest: member.instructionsDigest,
            },
          }
        : {}),
    })),
  });
}
export function reportAdmissionSignature(
  data: StationReportAdmission['data'],
  environment: EnvironmentSecurityService,
): string {
  return environment.signRevisionEvidenceAuthorityBinding(
    canonicalJson([REPORT_ADMISSION_DOMAIN, data]),
  );
}
export function reportAdmissionSignatureMatches(
  record: StationReportAdmission,
  environment: EnvironmentSecurityService,
): boolean {
  const expected = Buffer.from(
    reportAdmissionSignature(record.data, environment),
    'base64url',
  );
  const received = Buffer.from(record.signature, 'base64url');
  return (
    received.length === expected.length && timingSafeEqual(expected, received)
  );
}

/** Historical structural joins. No expiry extension or execution authority. */
export function validateStationReportAdmission(
  value: unknown,
): StationReportAdmission {
  const parsed = schema.parse(value);
  const root = validateRootAuthorityV2(parsed.data.root);
  const envelopes = parsed.data.envelopes.map(validateDelegationEnvelopeV2);
  const spec = validateDelegationRoundsSpec(parsed.data.spec);
  const members = parsed.data.members;
  const parent = envelopes.find((e) => e.parent === null);
  if (
    !parent ||
    spec.groupId !== root.authority_id ||
    canonicalJson(spec.rootAuthorityRef) !==
      canonicalJson(rootAuthorityReferenceV2(root)) ||
    members.length !== spec.seats.length ||
    envelopes.length !== members.length + 1 ||
    new Set(members.map((m) => m.seatId)).size !== members.length ||
    new Set(members.map((m) => m.reservedTaskId)).size !== members.length ||
    new Set(members.map((m) => m.reservedClientTurnId)).size !== members.length
  )
    throw Error('report_admission_join_invalid');
  validateDelegationAncestryV2(root, [parent], '0000-01-01T00:00:00.000Z');
  for (const entry of members) {
    const seat = spec.seats.find((s) => s.seatId === entry.seatId);
    const envelope = envelopes.find(
      (e) => e.execution_id === entry.reservedTaskId,
    );
    if (
      !seat ||
      !envelope ||
      envelope.parent?.id !== parent.envelope_id ||
      envelope.envelope_id !== seat.envelope.id ||
      envelope.generation !== seat.envelope.generation ||
      delegationEnvelopeDigestV2(envelope) !== seat.envelope.digest
    )
      throw Error('report_admission_join_invalid');
    validateDelegationAncestryV2(
      root,
      [parent, envelope],
      '0000-01-01T00:00:00.000Z',
    );
  }
  if (
    parsed.data.intentRef &&
    parsed.data.intentRef.digest !== `sha256:${parsed.data.intentRef.id}`
  )
    throw Error('report_admission_intent_invalid');
  return {
    data: {
      ...parsed.data,
      root,
      envelopes,
      spec,
    },
    signature: parsed.signature,
  };
}

/** Private operation input only; a signed reference does not itself admit execution. */
export function validateReportIntent(
  admission: StationReportAdmission['data'],
  sent: unknown,
): ReportGroupInput {
  const { root, spec, members } = admission;
  const intent = parseStationReportGroupInput(sent);
  const attempts =
    intent.members.length * (intent.continuation?.attemptsPerMember ?? 1);
  const policy: DelegationRoundsSpec['policy'] = {
    reference: root.revisions.policy,
    maxConcurrent: intent.maxConcurrent,
    maxAttempts: attempts,
    maxRounds:
      intent.continuation?.maxRounds ??
      (intent.flow ? intent.members.length : 1),
    ...(intent.flow
      ? { maxEvaluations: intent.continuation?.maxEvaluations ?? 0 }
      : {}),
    ...(intent.continuation
      ? {
          ...(intent.continuation.maxSyncs > 0 &&
          spec.policy.syncAdmission !== undefined
            ? { syncAdmission: 'initial-request' as const }
            : {}),
          maxSyncs: intent.continuation.maxSyncs,
          maxRenewals: intent.continuation.maxRenewals,
          maxRecoveries: intent.continuation.maxRecoveries,
        }
      : {}),
  };
  if (
    canonicalJson(spec.policy) !== canonicalJson(policy) ||
    root.budget.max_attempts !== attempts ||
    root.budget.max_concurrent_children !== intent.maxConcurrent ||
    root.revisions.policy.id !== intent.operationId ||
    root.revisions.policy.digest !==
      `sha256:${createHash('sha256').update(canonicalJson(intent)).digest('hex')}` ||
    intent.members.length !== members.length ||
    intent.deadlineAt !== Date.parse(root.budget.expires_at) ||
    intent.budget.inputTokens !== root.budget.max_input_tokens ||
    intent.budget.outputTokens !== root.budget.max_output_tokens ||
    intent.budget.costMicros !== root.budget.max_cost_micros ||
    intent.maxConcurrent !== spec.policy.maxConcurrent ||
    intent.members.some(
      (member) =>
        !members.some(
          (stored) =>
            stored.seatId === member.seatId &&
            stored.agentId === member.agentId,
        ),
    ) ||
    (intent.flow
      ? spec.topology.kind !== 'flow' ||
        intent.flow.runId !== spec.topology.runId ||
        spec.seats.some(
          (seat) => intent.flow?.steps[seat.seatId] !== seat.stepId,
        )
      : spec.topology.kind !== 'independent-advisory')
  )
    throw Error('report_admission_intent_invalid');
  if (
    !intent.continuation ||
    !admission.intentRef ||
    canonicalJson(encodeReportIntent(spec.groupId, intent).reference) !==
      canonicalJson(admission.intentRef)
  )
    throw Error('report_admission_intent_invalid');
  return intent;
}
