/**
 * station#1484 slice 1 — one test per ratified decision, written so that it
 * **fails if a later slice implements the opposite reading**.
 *
 * A contracts slice compiles no matter what it decided. These are the
 * assertions that make the decisions real: each one names the OQ it defends
 * and the specific wrong implementation it would catch.
 */

import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import type {
  ChannelAgentAuthorizationGrant,
  ChannelAgentAuthorizationRevocation,
  ChannelDeviceKeyCertificate,
  ChannelKeyRevocation,
  ChannelMemberIdentityKey,
  CommittedChannelRecord,
} from '../channel-identity.js';
import {
  compareChannelCommitCoordinates,
  KEY_RECOVERY_FIELDS_NOT_IN_V1,
  resolveAgentAuthorizationAtCommit,
  resolveChannelCertification,
  validateChannelAgentAuthorizationGrant,
  validateChannelMemberIdentityKey,
} from '../channel-identity.js';
import type {
  ChannelAuthorRef,
  ChannelCheckpoint,
  ChannelProposal,
  ChannelSequencingEnvelope,
} from '../channel-log.js';
import {
  CHANNEL_AUTHORITY_ONLY_FIELDS,
  CHANNEL_DURABILITY_LEVELS,
  CHANNEL_PROPOSAL_KINDS,
  CHANNEL_REFUSAL_RECEIPT_SCHEMA_VERSION,
  CHANNEL_SEQUENCEABLE_SCHEMA_VERSIONS,
  CHANNEL_SUPERSESSION_REQUIREMENT,
  channelProposalDigestInput,
  compareChannelCheckpoints,
  durabilitySatisfies,
  foldChannelSupersessions,
  validateChannelLocatorHint,
  validateChannelProposal,
  validateChannelSequencingEnvelope,
  verifyEmbeddedProposalDigest,
} from '../channel-log.js';
import { readChannelFixture } from './helpers/channel-fixtures.js';

const sha256Hex = (input: string): string =>
  createHash('sha256').update(input).digest('hex');

const AUTHOR: ChannelAuthorRef = {
  memberId: 'member-alex',
  deviceId: 'device-laptop',
  keyId: 'key-laptop-1',
};

const MEMBER_KEY = readChannelFixture(
  'member-key.valid.json',
) as ChannelMemberIdentityKey;
const CERTIFICATE = readChannelFixture(
  'device-certificate.valid.json',
) as ChannelDeviceKeyCertificate;
const GRANT = readChannelFixture(
  'agent-grant.valid.json',
) as ChannelAgentAuthorizationGrant;

/** The agent's own key and the owner its proposal attributes the action to. */
const AGENT_AUTHOR = {
  keyId: 'key-triage-bot',
  claimedOwnerMemberId: 'member-alex',
};

const AT_SEQ_41 = {
  coordinate: { channelId: 'chan-design', epoch: 3, seq: 41 },
  committedAt: '2026-08-02T09:00:01.000Z',
};

// ---------------------------------------------------------------------------
// OQ-6 — a refusal never enters the log.
// ---------------------------------------------------------------------------

describe('OQ-6: a refusal is the absence of an authored event, not an event', () => {
  test('the kind vocabulary has no refusal member', () => {
    expect(CHANNEL_PROPOSAL_KINDS).not.toContain('refusal');
    expect(CHANNEL_PROPOSAL_KINDS).not.toContain('refused');
    expect(CHANNEL_PROPOSAL_KINDS).not.toContain('rejection');
  });

  test('the refusal receipt is not in the sequenceable set', () => {
    expect(CHANNEL_SEQUENCEABLE_SCHEMA_VERSIONS).not.toContain(
      CHANNEL_REFUSAL_RECEIPT_SCHEMA_VERSION,
    );
  });

  test('an envelope embedding a refusal receipt is refused by name', () => {
    // The opposite reading — "committing refusals gives moderation a full
    // audit trail" — would let any member write into everyone else's history
    // by proposing garbage.
    const result = validateChannelSequencingEnvelope(
      readChannelFixture('envelope-embeds-refusal-receipt.refused.json'),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((d) => d.code)).toContain(
      'refusal-not-sequenceable',
    );
  });

  test('no record type outside the sequenceable set may be sequenced, refusal or not', () => {
    const envelope = readChannelFixture(
      'envelope-mid-chain.valid.json',
    ) as Record<string, unknown>;
    const result = validateChannelSequencingEnvelope({
      ...envelope,
      proposal: { schemaVersion: 'station.channel-membership/v1' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((d) => d.code)).toContain(
      'record-not-sequenceable',
    );
    // ...and NOT the refusal-specific code: the two guards must stay
    // distinguishable, or disabling either one is invisible to this suite.
    expect(result.diagnostics.map((d) => d.code)).not.toContain(
      'refusal-not-sequenceable',
    );
  });
});

// ---------------------------------------------------------------------------
// OQ-8 — an edit is a supersession record, not a mutation.
// ---------------------------------------------------------------------------

describe('OQ-8: supersession records, not mutation', () => {
  test('every kind has a stated supersession requirement', () => {
    for (const kind of CHANNEL_PROPOSAL_KINDS) {
      expect(CHANNEL_SUPERSESSION_REQUIREMENT[kind]).toBeDefined();
    }
    expect(CHANNEL_SUPERSESSION_REQUIREMENT.edit).toBe('required');
    expect(CHANNEL_SUPERSESSION_REQUIREMENT.message).toBe('forbidden');
  });

  test('a fold over a linear chain names the effective record AND keeps the history', () => {
    const fold = foldChannelSupersessions('prop-1', [
      { proposalId: 'prop-2', supersedesId: 'prop-1' },
      { proposalId: 'prop-3', supersedesId: 'prop-2' },
    ]);
    expect(fold).toEqual({
      kind: 'resolved',
      effectiveId: 'prop-3',
      supersededIds: ['prop-1', 'prop-2'],
    });
  });

  test('a forked chain is ambiguous naming every candidate — never "pick the newest"', () => {
    // The opposite reading is a coin flip presented as fact
    // (`multi-agent-delivery-protocol.md` §6, "exact match or unavailable").
    const fold = foldChannelSupersessions('prop-1', [
      { proposalId: 'prop-2b', supersedesId: 'prop-1' },
      { proposalId: 'prop-2a', supersedesId: 'prop-1' },
    ]);
    expect(fold).toEqual({
      kind: 'ambiguous',
      atId: 'prop-1',
      candidates: ['prop-2a', 'prop-2b'],
    });
    expect(fold).not.toHaveProperty('effectiveId');
  });

  test('a cycle terminates and is named, never walked forever or silently truncated', () => {
    expect(
      foldChannelSupersessions('prop-1', [
        { proposalId: 'prop-2', supersedesId: 'prop-1' },
        { proposalId: 'prop-1', supersedesId: 'prop-2' },
      ]),
    ).toEqual({ kind: 'cycle', atId: 'prop-1' });
  });

  test('an unsuperseded record folds to itself', () => {
    expect(foldChannelSupersessions('prop-1', [])).toEqual({
      kind: 'resolved',
      effectiveId: 'prop-1',
      supersededIds: [],
    });
  });
});

// ---------------------------------------------------------------------------
// OQ-7 — a committed grant, referenced by id, evaluated at commit time.
// ---------------------------------------------------------------------------

function committedGrant(
  seq: number,
  over: Partial<ChannelAgentAuthorizationGrant> = {},
): CommittedChannelRecord<ChannelAgentAuthorizationGrant> {
  return {
    record: { ...GRANT, ...over },
    coordinate: { channelId: 'chan-design', epoch: 3, seq },
    committedAt: '2026-08-01T00:00:00.000Z',
  };
}

function committedRevocation(
  seq: number,
): CommittedChannelRecord<ChannelAgentAuthorizationRevocation> {
  return {
    record: {
      schemaVersion: 'station.channel-agent-authorization-revocation/v1',
      authorizationId: 'auth-triage-bot-1',
      channelId: 'chan-design',
      ownerMemberId: 'member-alex',
      reasonCode: 'owner-revoked',
    },
    coordinate: { channelId: 'chan-design', epoch: 3, seq },
    committedAt: '2026-08-02T00:00:00.000Z',
  };
}

describe('OQ-7: agent authorization is a committed grant, referenced by id', () => {
  test('an authorization inlined in the proposal is refused', () => {
    const result = validateChannelProposal(
      readChannelFixture('proposal-inlined-authorization.refused.json'),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((d) => d.code)).toContain(
      'authorization-not-referenced',
    );
  });

  test('a grant already committed authorizes a later action', () => {
    expect(
      resolveAgentAuthorizationAtCommit({
        channelId: 'chan-design',
        authorizationId: 'auth-triage-bot-1',
        author: AGENT_AUTHOR,
        kind: 'agent-action',
        at: AT_SEQ_41,
        grants: [committedGrant(10)],
        logCoverage: 'complete-from-genesis',
      }),
    ).toEqual({
      status: 'authorized',
      grantCoordinate: { channelId: 'chan-design', epoch: 3, seq: 10 },
    });
  });

  test('a grant committed AFTER the action does not reach back for it', () => {
    const result = resolveAgentAuthorizationAtCommit({
      channelId: 'chan-design',
      authorizationId: 'auth-triage-bot-1',
      author: AGENT_AUTHOR,
      kind: 'agent-action',
      at: AT_SEQ_41,
      grants: [committedGrant(99)],
      logCoverage: 'complete-from-genesis',
    });
    expect(result.status).toBe('unauthorized');
    if (result.status !== 'unauthorized') return;
    expect(result.reason).toBe('grant-not-yet-committed');
  });

  test('a revocation committed AFTER the action leaves the action authorized', () => {
    // The opposite reading — evaluate against current state — would rewrite
    // history every time a grant was revoked, retroactively unauthorizing
    // messages that were authorized when they were committed (§3.7).
    expect(
      resolveAgentAuthorizationAtCommit({
        channelId: 'chan-design',
        authorizationId: 'auth-triage-bot-1',
        author: AGENT_AUTHOR,
        kind: 'agent-action',
        at: AT_SEQ_41,
        grants: [committedGrant(10)],
        revocations: [committedRevocation(90)],
        logCoverage: 'complete-from-genesis',
      }).status,
    ).toBe('authorized');
  });

  test('a revocation committed at or before the action unauthorizes it', () => {
    for (const seq of [40, 41]) {
      const result = resolveAgentAuthorizationAtCommit({
        channelId: 'chan-design',
        authorizationId: 'auth-triage-bot-1',
        author: AGENT_AUTHOR,
        kind: 'agent-action',
        at: AT_SEQ_41,
        grants: [committedGrant(10)],
        revocations: [committedRevocation(seq)],
        logCoverage: 'complete-from-genesis',
      });
      expect(result.status, `seq ${seq}`).toBe('unauthorized');
      if (result.status !== 'unauthorized') continue;
      expect(result.reason).toBe('revoked');
    }
  });

  test('a capability the grant does not carry is unauthorized', () => {
    const result = resolveAgentAuthorizationAtCommit({
      channelId: 'chan-design',
      authorizationId: 'auth-triage-bot-1',
      author: AGENT_AUTHOR,
      kind: 'moderation',
      at: AT_SEQ_41,
      grants: [committedGrant(10)],
      logCoverage: 'complete-from-genesis',
    });
    expect(result.status).toBe('unauthorized');
    if (result.status !== 'unauthorized') return;
    expect(result.reason).toBe('capability-not-granted');
  });

  test('a missing grant is UNKNOWN on a partial log and UNAUTHORIZED on a complete one', () => {
    // Absence of evidence is evidence of absence only when you hold all the
    // evidence. A later slice that collapsed these two into one answer would
    // either fabricate a refusal or fabricate a permission.
    const base = {
      channelId: 'chan-design',
      authorizationId: 'auth-missing',
      author: AGENT_AUTHOR,
      kind: 'agent-action' as const,
      at: AT_SEQ_41,
      grants: [],
    };
    const partial = resolveAgentAuthorizationAtCommit({
      ...base,
      logCoverage: 'partial',
    });
    expect(partial.status).toBe('unknown');
    if (partial.status === 'unknown') {
      expect(partial.reason).toBe('log-coverage-partial');
    }

    const complete = resolveAgentAuthorizationAtCommit({
      ...base,
      logCoverage: 'complete-from-genesis',
    });
    expect(complete.status).toBe('unauthorized');
    if (complete.status === 'unauthorized') {
      expect(complete.reason).toBe('grant-not-in-log');
    }
  });

  test('two grants sharing one authorizationId are ambiguous, naming both, never a pick', () => {
    const result = resolveAgentAuthorizationAtCommit({
      channelId: 'chan-design',
      authorizationId: 'auth-triage-bot-1',
      author: AGENT_AUTHOR,
      kind: 'agent-action',
      at: AT_SEQ_41,
      grants: [committedGrant(10), committedGrant(20)],
      logCoverage: 'complete-from-genesis',
    });
    expect(result.status).toBe('unknown');
    if (result.status !== 'unknown') return;
    expect(result.reason).toBe('grant-ambiguous');
    expect(result.candidates).toHaveLength(2);
  });

  test('a grant scoped to another channel does not authorize here', () => {
    const result = resolveAgentAuthorizationAtCommit({
      channelId: 'chan-design',
      authorizationId: 'auth-triage-bot-1',
      author: AGENT_AUTHOR,
      kind: 'agent-action',
      at: AT_SEQ_41,
      grants: [committedGrant(10, { channelId: 'chan-other' })],
      logCoverage: 'complete-from-genesis',
    });
    expect(result.status).toBe('unauthorized');
    if (result.status !== 'unauthorized') return;
    expect(result.reason).toBe('channel-mismatch');
  });
});

// ---------------------------------------------------------------------------
// OQ-5 — per-device keys certified by a member identity key; no recovery.
// ---------------------------------------------------------------------------

function keyRevocation(
  seq: number,
  revokedKeyId = 'key-laptop-1',
): CommittedChannelRecord<ChannelKeyRevocation> {
  return {
    record: {
      schemaVersion: 'station.channel-key-revocation/v1',
      channelId: 'chan-design',
      memberId: 'member-alex',
      revokedKeyId,
      reason: 'device-lost',
    },
    coordinate: { channelId: 'chan-design', epoch: 3, seq },
    committedAt: '2026-08-02T00:00:00.000Z',
  };
}

describe('OQ-5: the certification chain, and what it refuses to claim', () => {
  test('a structurally PERFECT chain with no verifier is unknown, never certified', () => {
    // §1.4 correction 2 in one assertion: a chain authored by the party you
    // are checking proves internal consistency and nothing else. A later
    // slice that returned `certified` from structure alone would be shipping
    // exactly the construction the adversarial review rejected.
    const result = resolveChannelCertification({
      author: AUTHOR,
      certificateCarriage: { record: CERTIFICATE },
      memberKey: MEMBER_KEY,
      at: AT_SEQ_41,
    });
    expect(result.status).toBe('unknown');
    if (result.status !== 'unknown') return;
    expect(result.reason).toBe('signature-unverified');
  });

  test('a verifier that establishes the certificate yields certified', () => {
    const result = resolveChannelCertification({
      author: AUTHOR,
      certificateCarriage: {
        record: CERTIFICATE,
        dsseEnvelope: {
          payloadType: 'application/vnd.in-toto+json',
          payload: 'eyJ9',
          signatures: [{ keyid: 'key-alex-identity', sig: 'c2ln' }],
        },
      },
      memberKey: MEMBER_KEY,
      at: AT_SEQ_41,
      verifier: {
        verify: () => ({
          verified: true,
          keyClass: 'held',
          keyId: 'key-alex-identity',
        }),
      },
    });
    expect(result).toEqual({ status: 'certified' });
  });

  test('a verifier plus an UNSIGNED certificate is still unknown', () => {
    const result = resolveChannelCertification({
      author: AUTHOR,
      certificateCarriage: { record: CERTIFICATE },
      memberKey: MEMBER_KEY,
      at: AT_SEQ_41,
      verifier: {
        verify: () => ({
          verified: true,
          keyClass: 'held',
          keyId: 'key-alex-identity',
        }),
      },
    });
    expect(result.status).toBe('unknown');
  });

  test('the chain is exactly one hop — a device key may not certify a device key', () => {
    const result = resolveChannelCertification({
      author: AUTHOR,
      certificateCarriage: {
        record: { ...CERTIFICATE, issuerKeyId: 'key-other-device' },
      },
      memberKey: MEMBER_KEY,
      at: AT_SEQ_41,
      verifier: {
        verify: () => ({
          verified: true,
          keyClass: 'held',
          keyId: 'key-alex-identity',
        }),
      },
    });
    expect(result.status).toBe('broken');
    if (result.status !== 'broken') return;
    expect(result.reason).toBe('issuer-not-member-key');
  });

  test('a key may not certify itself', () => {
    const result = resolveChannelCertification({
      author: { ...AUTHOR, keyId: 'key-alex-identity' },
      certificateCarriage: {
        record: { ...CERTIFICATE, deviceKeyId: 'key-alex-identity' },
      },
      memberKey: MEMBER_KEY,
      at: AT_SEQ_41,
    });
    expect(result.status).toBe('broken');
    if (result.status !== 'broken') return;
    expect(result.reason).toBe('self-certification');
  });

  test("the certificate must certify the author's own key and device", () => {
    for (const [author, reason] of [
      [{ ...AUTHOR, keyId: 'key-somebody-else' }, 'device-key-mismatch'],
      [{ ...AUTHOR, deviceId: 'device-phone' }, 'device-id-mismatch'],
      [{ ...AUTHOR, memberId: 'member-mallory' }, 'member-mismatch'],
    ] as const) {
      const result = resolveChannelCertification({
        author,
        certificateCarriage: { record: CERTIFICATE },
        memberKey: MEMBER_KEY,
        at: AT_SEQ_41,
      });
      expect(result.status, reason).toBe('broken');
      if (result.status !== 'broken') continue;
      expect(result.reason).toBe(reason);
    }
  });

  test('a revocation AFTER the commit does not invalidate what was already said', () => {
    const result = resolveChannelCertification({
      author: AUTHOR,
      certificateCarriage: { record: CERTIFICATE },
      memberKey: MEMBER_KEY,
      at: AT_SEQ_41,
      revocations: [keyRevocation(90)],
    });
    expect(result.status).toBe('unknown');
  });

  test('a revocation at or before the commit breaks the chain', () => {
    for (const seq of [40, 41]) {
      const result = resolveChannelCertification({
        author: AUTHOR,
        certificateCarriage: { record: CERTIFICATE },
        memberKey: MEMBER_KEY,
        at: AT_SEQ_41,
        revocations: [keyRevocation(seq)],
      });
      expect(result.status, `seq ${seq}`).toBe('broken');
      if (result.status !== 'broken') continue;
      expect(result.reason).toBe('key-revoked');
    }
  });

  test("another channel's revocation is not this channel's fact", () => {
    const revocation = keyRevocation(1);
    revocation.coordinate = { channelId: 'chan-other', epoch: 3, seq: 1 };
    const result = resolveChannelCertification({
      author: AUTHOR,
      certificateCarriage: { record: CERTIFICATE },
      memberKey: MEMBER_KEY,
      at: AT_SEQ_41,
      revocations: [revocation],
    });
    expect(result.status).toBe('unknown');
  });

  test('expiry is evaluated against the COMMIT clock, not the reader clock', () => {
    // A certificate that expired last week does not invalidate what it
    // certified last year.
    const expiring = { ...CERTIFICATE, expiresAt: '2026-08-02T09:00:00.500Z' };
    expect(
      resolveChannelCertification({
        author: AUTHOR,
        certificateCarriage: { record: expiring },
        memberKey: MEMBER_KEY,
        at: {
          coordinate: AT_SEQ_41.coordinate,
          committedAt: '2026-08-02T09:00:00.000Z',
        },
      }).status,
    ).toBe('unknown');

    const late = resolveChannelCertification({
      author: AUTHOR,
      certificateCarriage: { record: expiring },
      memberKey: MEMBER_KEY,
      at: AT_SEQ_41,
    });
    expect(late.status).toBe('broken');
    if (late.status !== 'broken') return;
    expect(late.reason).toBe('certificate-expired');
  });

  test('there is no key recovery in v1, and every continuity field is refused by name', () => {
    for (const field of KEY_RECOVERY_FIELDS_NOT_IN_V1) {
      const result = validateChannelMemberIdentityKey({
        ...MEMBER_KEY,
        [field]: 'anything',
      });
      expect(result.ok, field).toBe(false);
      if (result.ok) continue;
      expect(result.diagnostics.map((d) => d.code)).toContain(
        'key-recovery-not-in-v1',
      );
      expect(result.errors.join(' ')).toContain(field);
    }
  });
});

describe('slice-1 review fixes: the guards the first round did not have', () => {
  test("quoting somebody else's authorizationId is not authorization", () => {
    // The grant authorizes `key-triage-bot`. A different device signing an
    // agent-action and naming the same (public, in-the-log) authorizationId
    // must not resolve to authorized.
    const result = resolveAgentAuthorizationAtCommit({
      channelId: 'chan-design',
      authorizationId: 'auth-triage-bot-1',
      author: { keyId: 'key-laptop-1', claimedOwnerMemberId: 'member-alex' },
      kind: 'agent-action',
      at: AT_SEQ_41,
      grants: [committedGrant(10)],
      logCoverage: 'complete-from-genesis',
    });
    expect(result.status).toBe('unauthorized');
    if (result.status !== 'unauthorized') return;
    expect(result.reason).toBe('agent-key-mismatch');
  });

  test('attribution that disagrees with the grant is a claim, not a fact', () => {
    const result = resolveAgentAuthorizationAtCommit({
      channelId: 'chan-design',
      authorizationId: 'auth-triage-bot-1',
      author: {
        keyId: 'key-triage-bot',
        claimedOwnerMemberId: 'member-mallory',
      },
      kind: 'agent-action',
      at: AT_SEQ_41,
      grants: [committedGrant(10)],
      logCoverage: 'complete-from-genesis',
    });
    expect(result.status).toBe('unauthorized');
    if (result.status !== 'unauthorized') return;
    expect(result.reason).toBe('owner-mismatch');
  });

  test('the resolver refuses what its own validator refuses', () => {
    // Nothing forces a caller to validate before resolving, so the one
    // invariant whose violation makes revocation meaningless is re-checked
    // at the resolver rather than trusted as a precondition.
    const selfAuthorizing = committedGrant(10, {
      capabilities: ['message', 'agent-authorization'],
    });
    expect(
      validateChannelAgentAuthorizationGrant(selfAuthorizing.record).ok,
    ).toBe(false);

    const result = resolveAgentAuthorizationAtCommit({
      channelId: 'chan-design',
      authorizationId: 'auth-triage-bot-1',
      author: AGENT_AUTHOR,
      kind: 'message',
      at: AT_SEQ_41,
      grants: [selfAuthorizing],
      logCoverage: 'complete-from-genesis',
    });
    expect(result.status).toBe('unauthorized');
    if (result.status !== 'unauthorized') return;
    expect(result.reason).toBe('grant-self-authorizing');
  });

  test('an unplaceable revocation fails CLOSED rather than being skipped', () => {
    const revocation = committedRevocation(1);
    // The shape a SQLite/JSON round-trip produces when a numeric column comes
    // back as text. Under the old `number | null` comparison this answered
    // "later" and the revocation was silently ignored.
    revocation.coordinate = {
      channelId: 'chan-design',
      epoch: '3' as never,
      seq: 1,
    };
    const result = resolveAgentAuthorizationAtCommit({
      channelId: 'chan-design',
      authorizationId: 'auth-triage-bot-1',
      author: AGENT_AUTHOR,
      kind: 'agent-action',
      at: AT_SEQ_41,
      grants: [committedGrant(10)],
      revocations: [revocation],
      logCoverage: 'complete-from-genesis',
    });
    expect(result.status).toBe('unauthorized');
    if (result.status !== 'unauthorized') return;
    expect(result.reason).toBe('coordinate-malformed');
  });

  test('an unplaceable KEY revocation also fails closed', () => {
    const revocation = keyRevocation(1);
    revocation.coordinate = {
      channelId: 'chan-design',
      epoch: Number.NaN,
      seq: 1,
    };
    const result = resolveChannelCertification({
      author: AUTHOR,
      certificateCarriage: { record: CERTIFICATE },
      memberKey: MEMBER_KEY,
      at: AT_SEQ_41,
      revocations: [revocation],
    });
    expect(result.status).toBe('broken');
    if (result.status !== 'broken') return;
    expect(result.reason).toBe('coordinate-malformed');
  });

  test('`certified` requires the MEMBER key to be the key that signed', () => {
    // A self-asserted issuerKeyId plus a verifier that accepted *something*
    // used to be enough. It is trivially satisfied by an attacker's own
    // well-formed certificate.
    const result = resolveChannelCertification({
      author: AUTHOR,
      certificateCarriage: {
        record: CERTIFICATE,
        dsseEnvelope: {
          payloadType: 'application/vnd.in-toto+json',
          payload: 'eyJ9',
          signatures: [{ keyid: 'key-alex-identity', sig: 'c2ln' }],
        },
      },
      memberKey: MEMBER_KEY,
      at: AT_SEQ_41,
      verifier: {
        verify: () => ({
          verified: true,
          keyClass: 'held',
          // The signature really came from Mallory's key, whatever the
          // envelope's self-declared keyid says.
          keyId: 'key-mallory',
        }),
      },
    });
    expect(result.status).toBe('broken');
    if (result.status !== 'broken') return;
    expect(result.reason).toBe('issuer-not-member-key');
  });

  test('one superseding record delivered twice is not a fork', () => {
    expect(
      foldChannelSupersessions('prop-1', [
        { proposalId: 'prop-2', supersedesId: 'prop-1' },
        { proposalId: 'prop-2', supersedesId: 'prop-1' },
      ]),
    ).toEqual({
      kind: 'resolved',
      effectiveId: 'prop-2',
      supersededIds: ['prop-1'],
    });
  });

  test('durabilitySatisfies fails closed on an unreadable REQUIREMENT too', () => {
    // Slice 4 reads a per-channel durability policy from config. One typo and
    // the old comparison made every level satisfy it — the composer would
    // have shown "Copied to your Station" for a `pending-local` message.
    for (const required of [
      'checkpoint-witnessed ',
      undefined,
      null,
      'COMMITTED-HOME',
      '',
    ]) {
      expect(
        durabilitySatisfies('pending-local', required as never),
        JSON.stringify(required),
      ).toBe(false);
    }
  });
});

describe('commit coordinates order within a channel and refuse to order across channels', () => {
  const at = (epoch: number, seq: number) => ({
    channelId: 'chan-design',
    epoch,
    seq,
  });

  test('epoch dominates sequence', () => {
    expect(compareChannelCommitCoordinates(at(3, 999), at(4, 1))).toEqual({
      comparable: true,
      order: -1,
    });
    expect(compareChannelCommitCoordinates(at(4, 1), at(3, 999))).toEqual({
      comparable: true,
      order: 1,
    });
    expect(compareChannelCommitCoordinates(at(3, 41), at(3, 41))).toEqual({
      comparable: true,
      order: 0,
    });
  });

  test('two channels are not comparable, and that is not "equal"', () => {
    expect(
      compareChannelCommitCoordinates(at(3, 41), {
        channelId: 'chan-other',
        epoch: 3,
        seq: 41,
      }),
    ).toEqual({ comparable: false, reason: 'different-channel' });
  });

  test('an unreadable coordinate is DISTINGUISHABLE from a foreign one', () => {
    // Slice-1 review, MEDIUM. The earlier `number | null` folded the two
    // together, and the arithmetic answered "later" for a NaN or a
    // stringified number — which both revocation loops read as "does not
    // apply". A revocation whose epoch came back from a store as "3" instead
    // of 3 silently stopped breaking the chain.
    for (const bad of [
      { channelId: 'chan-design', epoch: '3', seq: 1 },
      { channelId: 'chan-design', epoch: Number.NaN, seq: 1 },
      { channelId: 'chan-design', epoch: 3, seq: 1.5 },
      { channelId: '', epoch: 3, seq: 1 },
    ]) {
      expect(
        compareChannelCommitCoordinates(bad as never, at(3, 41)),
        JSON.stringify(bad),
      ).toEqual({ comparable: false, reason: 'malformed' });
    }
  });
});

// ---------------------------------------------------------------------------
// OQ-3/OQ-4 — the durability enum (the ack policy defers to slice 4).
// ---------------------------------------------------------------------------

describe('OQ-3/OQ-4: the durability enum lands now, fail-closed', () => {
  test('the order is exactly the design doc §3.8 order', () => {
    expect(CHANNEL_DURABILITY_LEVELS).toEqual([
      'pending-local',
      'committed-home',
      'replicated-copy',
      'checkpoint-witnessed',
    ]);
  });

  test('a level satisfies itself and everything below it', () => {
    expect(durabilitySatisfies('checkpoint-witnessed', 'pending-local')).toBe(
      true,
    );
    expect(durabilitySatisfies('replicated-copy', 'committed-home')).toBe(true);
    expect(durabilitySatisfies('committed-home', 'committed-home')).toBe(true);
  });

  test('a lower level never satisfies a higher requirement', () => {
    expect(durabilitySatisfies('committed-home', 'replicated-copy')).toBe(
      false,
    );
    expect(durabilitySatisfies('pending-local', 'committed-home')).toBe(false);
  });

  test('an unreadable level satisfies NOTHING — no coercion into the floor', () => {
    for (const value of [
      undefined,
      null,
      '',
      'committed',
      'COMMITTED-HOME',
      true,
      0,
      ['committed-home'],
    ]) {
      expect(
        durabilitySatisfies(value, 'pending-local'),
        JSON.stringify(value),
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// CRITICAL correction 1 — authority state is not identity state.
// ---------------------------------------------------------------------------

describe('correction 1: the channel-home record is its own construct', () => {
  test('every authority field is refused from a portable locator hint, by name', () => {
    for (const field of CHANNEL_AUTHORITY_ONLY_FIELDS) {
      const result = validateChannelLocatorHint({
        channelId: 'chan-design',
        [field]: field === 'epoch' ? 3 : 'value',
      });
      expect(result.ok, field).toBe(false);
      if (result.ok) continue;
      expect(result.diagnostics.map((d) => d.code)).toContain(
        'authority-field-in-locator-hint',
      );
      expect(result.errors.join(' ')).toContain(field);
    }
  });

  test('a bare channel id plus a hint is accepted — that is all a manifest may carry', () => {
    expect(
      validateChannelLocatorHint({
        channelId: 'chan-design',
        locatorHint: 'alex-desktop.tail1234.ts.net',
      }).ok,
    ).toBe(true);
    expect(validateChannelLocatorHint({ channelId: 'chan-design' }).ok).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// §3.2 — the embedded proposal, verbatim, with a checkable digest.
// ---------------------------------------------------------------------------

describe('the embedded proposal digest is checkable by a third party', () => {
  const envelope = readChannelFixture(
    'envelope-mid-chain.valid.json',
  ) as ChannelSequencingEnvelope;

  test('a correctly digested envelope matches', () => {
    const sealed: ChannelSequencingEnvelope = {
      ...envelope,
      proposalDigest: sha256Hex(channelProposalDigestInput(envelope.proposal)),
    };
    expect(verifyEmbeddedProposalDigest(sealed, sha256Hex)).toEqual({
      status: 'match',
    });
  });

  test('editing one character of the embedded body breaks the digest', () => {
    const sealed: ChannelSequencingEnvelope = {
      ...envelope,
      proposalDigest: sha256Hex(channelProposalDigestInput(envelope.proposal)),
    };
    const tampered: ChannelSequencingEnvelope = {
      ...sealed,
      proposal: {
        ...sealed.proposal,
        body: { text: 'the log is the producT' },
      },
    };
    const verdict = verifyEmbeddedProposalDigest(tampered, sha256Hex);
    expect(verdict.status).toBe('mismatch');
    if (verdict.status !== 'mismatch') return;
    expect(verdict.declared).not.toBe(verdict.computed);
  });

  test('there is exactly ONE canonical byte-string for a proposal', () => {
    // The envelope is carried alongside the record (assurance.md), so the
    // bytes a digest covers and the bytes a slice-3 signer signs are the same
    // thing. An embedded envelope would have made a record contain its own
    // signature and forced a second canonicalization, with nothing saying
    // which one `proposalDigest` meant.
    const carriage = {
      record: envelope.proposal,
      dsseEnvelope: {
        payloadType: 'application/vnd.in-toto+json',
        payload: 'eyJ9',
        signatures: [{ keyid: 'key-laptop-1', sig: 'c2ln' }],
      },
    };
    expect(channelProposalDigestInput(carriage.record)).toBe(
      channelProposalDigestInput(envelope.proposal),
    );
  });

  test('a __proto__ member changes the digest instead of vanishing from it', () => {
    // Slice-1 review BLOCKER: `result[key] = ...` inside canonicalizeForDigest
    // hit Object.prototype's __proto__ ACCESSOR, so the key was dropped from
    // the canonical bytes entirely — two different records digested
    // identically and the canonical object silently acquired an
    // attacker-supplied prototype. Appending a __proto__ member to an
    // already-digested proposal would have kept `verifyEmbeddedProposalDigest`
    // reporting `match`, which is the exact opposite of "embedding verbatim
    // makes a member's words unforgeable".
    const clean = JSON.parse(
      JSON.stringify(envelope.proposal),
    ) as ChannelProposal;
    const polluted = JSON.parse(
      `${JSON.stringify(envelope.proposal).slice(0, -1)},"__proto__":{"kind":"moderation"}}`,
    ) as ChannelProposal;

    expect(Object.keys(polluted)).toContain('__proto__');
    expect(channelProposalDigestInput(polluted)).not.toBe(
      channelProposalDigestInput(clean),
    );
    // ...and the canonical form must not have been re-prototyped either.
    expect(({} as Record<string, unknown>).kind).toBeUndefined();
  });

  test('the proposal validator refuses a prototype-affecting key outright', () => {
    const polluted = JSON.parse(
      `${JSON.stringify(envelope.proposal).slice(0, -1)},"__proto__":{"kind":"moderation"}}`,
    ) as unknown;
    const result = validateChannelProposal(polluted);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((d) => d.code)).toContain('forbidden-key');
  });

  test('key order does not change the digest — canonicalization is real', () => {
    const reordered = JSON.parse(
      JSON.stringify(envelope.proposal, [
        'happenedAt',
        'body',
        'text',
        'baseEpoch',
        'kind',
        'author',
        'keyId',
        'deviceId',
        'memberId',
        'channelId',
        'proposalId',
        'schemaVersion',
      ]),
    ) as ChannelProposal;
    // Same content, different serialization order.
    expect(Object.keys(reordered)).not.toEqual(
      Object.keys(envelope.proposal as unknown as Record<string, unknown>),
    );
    expect(channelProposalDigestInput(reordered)).toBe(
      channelProposalDigestInput(envelope.proposal),
    );
  });
});

// ---------------------------------------------------------------------------
// §3.5 — a conflict is not automatically a proof.
// ---------------------------------------------------------------------------

describe('checkpoint comparison distinguishes conflict from proof', () => {
  const a = readChannelFixture('checkpoint.valid.json') as ChannelCheckpoint;
  const conflicting = readChannelFixture(
    'checkpoint-conflicting-head.valid.json',
  ) as ChannelCheckpoint;
  const otherEpoch = readChannelFixture(
    'checkpoint-other-epoch.valid.json',
  ) as ChannelCheckpoint;

  test('identical heads at one coordinate are consistent', () => {
    expect(compareChannelCheckpoints(a, { ...a, observedAt: 'later' })).toEqual(
      {
        kind: 'consistent',
      },
    );
  });

  test('different coordinates are not comparable, never a conflict', () => {
    expect(compareChannelCheckpoints(a, otherEpoch).kind).toBe(
      'not-comparable',
    );
    expect(
      compareChannelCheckpoints(a, { ...conflicting, channelId: 'chan-other' })
        .kind,
    ).toBe('not-comparable');
  });

  test('conflicting UNSIGNED checkpoints are a conflict and NOT a proof', () => {
    // The opposite reading — "two conflicting checkpoints are an equivocation
    // proof" — is true only when both are verifiably signed by the same home.
    // Unsigned, anyone can fabricate one and frame a home.
    const result = compareChannelCheckpoints(a, conflicting);
    expect(result.kind).toBe('conflict');
    if (result.kind !== 'conflict') return;
    expect(result.attribution).toBe('unattributable');
    expect(result.message).toMatch(/proves nothing about who authored it/);
  });

  test('conflicting checkpoints VERIFIED against one key are attributable', () => {
    const result = compareChannelCheckpoints(
      a,
      conflicting,
      () => 'key-home-epoch-3',
    );
    expect(result.kind).toBe('conflict');
    if (result.kind !== 'conflict') return;
    expect(result.attribution).toBe('attributable');
  });

  test('two DIFFERENT verified signers disagreeing is not an equivocation by either', () => {
    const result = compareChannelCheckpoints(a, conflicting, (checkpoint) =>
      checkpoint.headEnvelopeDigest === a.headEnvelopeDigest
        ? 'key-home-a'
        : 'key-home-b',
    );
    expect(result.kind).toBe('conflict');
    if (result.kind !== 'conflict') return;
    expect(result.attribution).toBe('unattributable');
  });

  test('attribution comes from the VERIFIED key, never the declared keyid', () => {
    // Slice-1 review, HIGH: the earlier signature was
    // `isVerifiablySigned: (cp) => boolean` plus a comparison of the
    // envelope's own `signatures[].keyid` — unverified metadata anyone can
    // write. A verifier checking key A against a record advertising key B
    // would have produced an "equivocation proof" naming the wrong home. The
    // seam now returns the key that actually signed, so a verifier that
    // cannot name one cannot make anything attributable.
    const result = compareChannelCheckpoints(a, conflicting, () => null);
    expect(result.kind).toBe('conflict');
    if (result.kind !== 'conflict') return;
    expect(result.attribution).toBe('unattributable');
  });
});

// ---------------------------------------------------------------------------
// §5.2 — the author's clock is never authoritative, in either direction.
// ---------------------------------------------------------------------------

describe('a stale baseEpoch is accepted, because epoch is not a product concept', () => {
  test('an envelope may sequence a proposal authored under an older epoch', () => {
    // §5.2: "`baseEpoch` is stale (a handover happened) -> ACCEPT if policy
    // and parent still hold. What the author sees: nothing." The opposite
    // reading — refuse a stale baseEpoch — would silently drop every write
    // queued across a handover, which is the failure slice 6's replay matrix
    // exists to prevent.
    const envelope = readChannelFixture(
      'envelope-mid-chain.valid.json',
    ) as Record<string, unknown>;
    const proposal = envelope.proposal as Record<string, unknown>;
    const result = validateChannelSequencingEnvelope({
      ...envelope,
      epoch: 7,
      proposal: { ...proposal, baseEpoch: 3 },
    });
    expect(result.ok).toBe(true);
  });

  test('a proposal authored under a FUTURE epoch is also accepted at this layer', () => {
    // Whether that proposal is admissible is a policy question the home
    // answers at commit time (§5.2), not a shape question — encoding it here
    // would put a policy decision in a validator no policy can reach.
    const envelope = readChannelFixture(
      'envelope-mid-chain.valid.json',
    ) as Record<string, unknown>;
    const proposal = envelope.proposal as Record<string, unknown>;
    expect(
      validateChannelSequencingEnvelope({
        ...envelope,
        proposal: { ...proposal, baseEpoch: 99 },
      }).ok,
    ).toBe(true);
  });
});

describe("the author's clock is untrusted, and untrusted means unrefused", () => {
  test('a happenedAt far in the future is ACCEPTED (§5.2 clamps display, not admission)', () => {
    const result = validateChannelProposal(
      readChannelFixture('proposal-future-happened-at.valid.json'),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.happenedAt.startsWith('2130')).toBe(true);
  });

  test('a hostile __proto__ key is refused, and never pollutes Object.prototype', () => {
    const parsed = readChannelFixture('proposal-prototype-keys.refused.json');
    // JSON.parse really does hand it over as DATA, which is why the record
    // could carry one at all.
    expect(Object.keys(parsed as object)).toContain('__proto__');
    expect(({} as Record<string, unknown>).kind).toBeUndefined();

    const result = validateChannelProposal(parsed);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((d) => d.code)).toContain('forbidden-key');
  });
});
