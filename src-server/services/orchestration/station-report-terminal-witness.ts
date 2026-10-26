import { timingSafeEqual } from 'node:crypto';
import { canonicalJson } from '@kontourai/relay';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { z } from 'zod/v3';
import type { EnvironmentSecurityService } from '../ssh/environment-security-service.js';
import type { OrchestrationService } from './orchestration-service.js';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const binding = z
  .object({
    groupId: id,
    seatId: id,
    invocationId: id,
    root: z
      .object({
        id,
        authority_epoch: z.number().int().nonnegative().safe(),
        digest,
      })
      .strict(),
    envelope: z
      .object({ id, generation: z.number().int().nonnegative().safe(), digest })
      .strict(),
    evidence: z
      .object({ id, domain: z.literal('station.provider-evidence'), digest })
      .strict(),
  })
  .strict();
const terminal = z
  .object({
    conversationId: id,
    sessionId: id,
    clientTurnId: id,
    turnId: id,
    ownerId: id,
    provider: z.string().min(1).max(64),
    terminalEventId: id,
    terminalCreatedAt: z.string().datetime(),
  })
  .strict();
export const reportTerminalWitnessSchema = z
  .object({
    data: binding.extend({ version: z.literal(1), terminal }).strict(),
    signature: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();
export type ReportTerminalWitness = z.infer<typeof reportTerminalWitnessSchema>;
const DOMAIN = 'station.report-terminal-witness.v1';

export function captureReportTerminalWitness(
  owners: {
    environment: EnvironmentSecurityService;
    orchestration: OrchestrationService;
    current(): undefined;
  },
  input: z.infer<typeof binding> & {
    turn: {
      conversationId: string;
      sessionId: string;
      clientTurnId: string;
      turnId: string;
    };
    ownerId: string;
  },
): ReportTerminalWitness | null {
  return owners.environment.withCurrentAuthority(() => {
    owners.current();
    const { turn, ownerId, ...identity } = input;
    const observed = owners.orchestration.readHistoricalReportTurn(
      turn,
      sessionReadAuthorityFromRequest(ownerId, undefined, undefined),
    );
    if (!observed) return null;
    const data = reportTerminalWitnessSchema.shape.data.parse({
      ...identity,
      version: 1,
      terminal: observed,
    });
    const signature = owners.environment.signRevisionEvidenceAuthorityBinding(
      canonicalJson([DOMAIN, data]),
    );
    owners.current();
    return reportTerminalWitnessSchema.parse({ data, signature });
  });
}

export function verifyReportTerminalWitness(
  value: ReportTerminalWitness,
  environment: EnvironmentSecurityService,
): boolean {
  const record = reportTerminalWitnessSchema.parse(value);
  const expected = Buffer.from(
    environment.signRevisionEvidenceAuthorityBinding(
      canonicalJson([DOMAIN, record.data]),
    ),
    'base64url',
  );
  const actual = Buffer.from(record.signature, 'base64url');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
