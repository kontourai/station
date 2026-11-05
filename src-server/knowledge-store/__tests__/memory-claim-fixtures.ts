import { createHash } from 'node:crypto';
import {
  type MemoryClaim,
  memoryClaim,
} from '@kontourai/flow-agents/memory-claims';
import { routeMemoryChange } from '@kontourai/flow-agents/memory-routing';
import { canonicalJson } from '@kontourai/relay';

/**
 * The body the Knowledge Kit's dream run writes into a create proposal
 * (`kits/knowledge/dream/envelope.js`, version 1.2), built the same way
 * `encodeEnvelope` builds it: one canonical JSON object holding the claim, its
 * agreement, the routing decision made at proposal time, and the sitting's
 * whole plan bound by a digest. A test that seeds a store with anything else
 * would pass against a shape the real writer never produces.
 */
export const OWNER = 'human:owner';

export function claim(fields: {
  subject: string;
  property: string;
  value: unknown;
  excerpt: string;
  observedAt?: string;
  posture?: MemoryClaim['posture'];
  speaker?: string;
  visibility?: MemoryClaim['visibility'] | null;
  supersedes?: MemoryClaim['supersedes'];
}): MemoryClaim {
  const { visibility, ...rest } = fields;
  return memoryClaim({
    subject: {
      type: 'service',
      id: fields.subject.toLowerCase(),
      label: fields.subject,
    },
    claimType: 'fact',
    property: fields.property,
    value: fields.value,
    speaker: fields.speaker ?? 'user',
    source: {
      ref: `sitting:${fields.subject}:${fields.property}`,
      locator: 'chars:0-40',
      excerpt: fields.excerpt,
      observedAt: fields.observedAt ?? '2026-11-01T10:00:00.000Z',
      role: 'user',
    },
    posture: fields.posture ?? 'stated',
    ...(rest.supersedes ? { supersedes: rest.supersedes } : {}),
    ...(visibility === null
      ? {}
      : {
          visibility: visibility ?? { kind: 'restricted', audiences: [OWNER] },
        }),
  });
}

const digest = (value: unknown) =>
  `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;

export function envelope(
  memory: MemoryClaim,
  agreement: { passes: number; agreeing: number } | null = {
    passes: 2,
    agreeing: 2,
  },
): string {
  const plan = [{ claim: memory, agreement, project: null }];
  return canonicalJson({
    dream: '1.2',
    claim: memory,
    agreement,
    decision: routeMemoryChange({
      type: 'claim',
      claim: memory,
      current: [],
      agreement,
      sourceVisibility: memory.visibility ?? null,
    }),
    project: null,
    sitting: {
      id: memory.source.ref,
      contentHash: digest(memory.source.excerpt),
      visibilityKey: digest(memory.visibility ?? null),
      index: 0,
      planDigest: digest(plan),
    },
    plan,
  });
}

/** The candidate a person-owned store receives for a claim. */
export function candidate(
  memory: MemoryClaim,
  agreement?: { passes: number; agreeing: number } | null,
) {
  return {
    type: 'raw' as const,
    title: `${memory.subject.label}: ${memory.property}`,
    body: envelope(memory, agreement),
    category: 'memory.claim',
    provenance: { agent: 'dream' },
  };
}
