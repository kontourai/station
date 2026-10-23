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
import { z } from 'zod/v3';
import type { EnvironmentSecurityService } from '../ssh/environment-security-service.js';

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
  })
  .strict();
const schema = z
  .object({
    data: z
      .object({
        version: z.literal(1),
        credentialDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
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
    root: RootAuthorityV2;
    envelopes: DelegationEnvelopeV2[];
    spec: DelegationRoundsSpec;
    members: z.infer<typeof member>[];
  };
  signature: string;
};
export const REPORT_ADMISSION_DOMAIN = 'station.report-group.admission.v1';

export function reportCredentialDigest(credential: string): string {
  return `sha256:${createHash('sha256').update(credential).digest('hex')}`;
}
export function reportAdmissionData(
  prepared: {
    root: RootAuthorityV2;
    envelopes: DelegationEnvelopeV2[];
    spec: DelegationRoundsSpec;
    members: Array<{
      seatId: string;
      agentId: string;
      taskId: string;
      clientTurnId: string;
      modelId: string;
    }>;
  },
  credentialDigest: string,
): StationReportAdmission['data'] {
  return structuredClone({
    version: 1,
    credentialDigest,
    root: prepared.root,
    envelopes: prepared.envelopes,
    spec: prepared.spec,
    members: prepared.members.map((member) => ({
      seatId: member.seatId,
      agentId: member.agentId,
      reservedTaskId: member.taskId,
      reservedClientTurnId: member.clientTurnId,
      requestedModelId: member.modelId,
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
  return {
    data: { ...parsed.data, root, envelopes, spec },
    signature: parsed.signature,
  };
}
