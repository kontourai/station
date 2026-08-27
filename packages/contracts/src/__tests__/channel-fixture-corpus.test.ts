/**
 * station#1484 slice 1 — the fixture corpus, and the reason it exists.
 *
 * A contracts slice's risk is that it is **unfalsifiable**: types compile and
 * prove nothing. So every record type gets a validator with a fail-closed
 * default, and every validator gets a corpus of real JSON — including
 * malformed and adversarial shapes — parsed the way untrusted input is
 * actually parsed rather than constructed as a typed literal that the
 * compiler has already vouched for.
 *
 * The manifest below is the corpus's own gate: it must match the fixture
 * directory **in both directions**, so a fixture cannot be added and left
 * unasserted, and a manifest entry cannot outlive the file it names. Every
 * refused fixture declares the diagnostic **code** it must produce, not a
 * message substring — a validator that starts refusing something for a
 * different reason is a test failure rather than a coincidence.
 */

import { readdirSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import type { ChannelIdentityDiagnosticCode } from '../channel-identity.js';
import {
  CHANNEL_AGENT_AUTHORIZATION_REVOCATION_SCHEMA_VERSION,
  CHANNEL_AGENT_AUTHORIZATION_SCHEMA_VERSION,
  CHANNEL_DEVICE_CERTIFICATE_SCHEMA_VERSION,
  CHANNEL_KEY_REVOCATION_SCHEMA_VERSION,
  CHANNEL_MEMBER_KEY_SCHEMA_VERSION,
  validateChannelAgentAuthorizationGrant,
  validateChannelAgentAuthorizationRevocation,
  validateChannelDeviceKeyCertificate,
  validateChannelKeyRevocation,
  validateChannelMemberIdentityKey,
} from '../channel-identity.js';
import type { ChannelDiagnosticCode } from '../channel-log.js';
import {
  CHANNEL_CHECKPOINT_SCHEMA_VERSION,
  CHANNEL_HOME_SCHEMA_VERSION,
  CHANNEL_PROPOSAL_SCHEMA_VERSION,
  CHANNEL_REFUSAL_RECEIPT_SCHEMA_VERSION,
  CHANNEL_SEQUENCE_SCHEMA_VERSION,
  validateChannelCheckpoint,
  validateChannelHomeRecord,
  validateChannelLocatorHint,
  validateChannelProposal,
  validateChannelRefusalReceipt,
  validateChannelSequencingEnvelope,
} from '../channel-log.js';
import {
  CHANNEL_FIXTURE_DIR,
  readChannelFixture,
} from './helpers/channel-fixtures.js';

type ValidatorId =
  | 'proposal'
  | 'envelope'
  | 'checkpoint'
  | 'channel-home'
  | 'locator-hint'
  | 'member-key'
  | 'device-certificate'
  | 'agent-grant'
  | 'refusal-receipt'
  | 'key-revocation'
  | 'authorization-revocation';

const VALIDATORS: Record<
  ValidatorId,
  (value: unknown) =>
    | { ok: true; record: unknown }
    | {
        ok: false;
        errors: string[];
        diagnostics: {
          code: ChannelDiagnosticCode | ChannelIdentityDiagnosticCode;
          message: string;
        }[];
      }
> = {
  proposal: validateChannelProposal,
  envelope: validateChannelSequencingEnvelope,
  checkpoint: validateChannelCheckpoint,
  'channel-home': validateChannelHomeRecord,
  'locator-hint': validateChannelLocatorHint,
  'member-key': validateChannelMemberIdentityKey,
  'device-certificate': validateChannelDeviceKeyCertificate,
  'agent-grant': validateChannelAgentAuthorizationGrant,
  'refusal-receipt': validateChannelRefusalReceipt,
  'key-revocation': validateChannelKeyRevocation,
  'authorization-revocation': validateChannelAgentAuthorizationRevocation,
};

interface FixtureEntry {
  validator: ValidatorId;
  /**
   * For a `.refused.json` fixture: the diagnostic code that MUST appear.
   * Omitted for `.valid.json`.
   */
  code?: ChannelDiagnosticCode | ChannelIdentityDiagnosticCode;
  /**
   * True when a fixture the validator ACCEPTS is nonetheless adversarial —
   * the interesting behavior lives in a derivation or a comparison rather
   * than in field validation. Each one has a dedicated test elsewhere in
   * this suite; the flag stops "the validator accepted it" reading as
   * "nothing here is hostile".
   */
  adversarialButAccepted?: true;
  notes?: string;
}

/**
 * The corpus. Ordered by the decision each fixture defends so the shape of
 * the coverage is readable at a glance.
 */
const CORPUS: Record<string, FixtureEntry> = {
  // --- ordinary well-formed records ------------------------------------
  'proposal-message.valid.json': { validator: 'proposal' },
  'proposal-bodyref.valid.json': { validator: 'proposal' },
  'envelope-genesis.valid.json': { validator: 'envelope' },
  'envelope-mid-chain.valid.json': { validator: 'envelope' },
  'checkpoint.valid.json': { validator: 'checkpoint' },
  'channel-home-witnessed.valid.json': { validator: 'channel-home' },
  'channel-home-peer-only.valid.json': {
    validator: 'channel-home',
    notes:
      '§3.4 peer-only: witnessRef null is a STATED regime (freeze, never auto-promote), not a missing field',
  },
  'locator-hint.valid.json': { validator: 'locator-hint' },
  'member-key.valid.json': { validator: 'member-key' },
  'device-certificate.valid.json': { validator: 'device-certificate' },
  'agent-grant.valid.json': { validator: 'agent-grant' },
  'refusal-receipt.valid.json': {
    validator: 'refusal-receipt',
    notes:
      'validating a refusal says nothing about admitting one — the envelope validator refuses it by name (OQ-6)',
  },
  'refusal-receipt-no-reason.refused.json': {
    validator: 'refusal-receipt',
    code: 'record-invalid',
    notes: 'a refusal that names no reason is the failed-send it must never be',
  },
  'key-revocation.valid.json': { validator: 'key-revocation' },
  'key-revocation-unknown-reason.refused.json': {
    validator: 'key-revocation',
    code: 'record-invalid',
  },
  'authorization-revocation.valid.json': {
    validator: 'authorization-revocation',
  },
  'authorization-revocation-no-owner.refused.json': {
    validator: 'authorization-revocation',
    code: 'record-invalid',
  },

  // --- OQ-8: supersession, not mutation --------------------------------
  'proposal-edit-supersedes.valid.json': { validator: 'proposal' },
  'proposal-edit-without-supersedes.refused.json': {
    validator: 'proposal',
    code: 'supersession-shape-invalid',
    notes: 'an edit that supersedes nothing is an in-place mutation',
  },
  'proposal-self-supersession.refused.json': {
    validator: 'proposal',
    code: 'supersession-shape-invalid',
  },
  'proposal-message-supersedes.refused.json': {
    validator: 'proposal',
    code: 'supersession-shape-invalid',
  },

  // --- OQ-7: authorization is a committed grant, referenced by id -------
  'proposal-agent-action.valid.json': { validator: 'proposal' },
  'proposal-inlined-authorization.refused.json': {
    validator: 'proposal',
    code: 'authorization-not-referenced',
    notes: 'an inlined grant is a per-proposal claim wearing a reference name',
  },
  'proposal-agent-action-unauthorized.refused.json': {
    validator: 'proposal',
    code: 'agent-attribution-missing',
    notes:
      'distinct from authorization-not-referenced: "you attributed nothing" and "you inlined a grant" are different violations, and one code for both blinds every test to which guard fired',
  },
  'agent-grant-self-authorizing.refused.json': {
    validator: 'agent-grant',
    code: 'self-authorizing-capability',
  },
  'agent-grant-empty-capabilities.refused.json': {
    validator: 'agent-grant',
    code: 'record-invalid',
  },
  'agent-grant-capabilities-absent.refused.json': {
    validator: 'agent-grant',
    code: 'record-invalid',
    notes: 'an absent allowlist must never read as "everything"',
  },

  // --- OQ-6: a refusal never enters the log ----------------------------
  'envelope-embeds-refusal-receipt.refused.json': {
    validator: 'envelope',
    code: 'refusal-not-sequenceable',
  },
  'proposal-unknown-kind.refused.json': {
    validator: 'proposal',
    code: 'record-invalid',
    notes: 'kind "refusal" is not in the vocabulary and must never be added',
  },

  // --- OQ-5: one-hop chain, no recovery in v1 --------------------------
  'member-key-with-recovery.refused.json': {
    validator: 'member-key',
    code: 'key-recovery-not-in-v1',
  },
  'member-key-claims-continuity.refused.json': {
    validator: 'member-key',
    code: 'key-recovery-not-in-v1',
    notes:
      're-enrolment is a NEW member; a previousMemberId field would fake continuity',
  },
  'device-certificate-with-backup-key.refused.json': {
    validator: 'device-certificate',
    code: 'key-recovery-not-in-v1',
  },
  'device-certificate-absent-expiry.refused.json': {
    validator: 'device-certificate',
    code: 'record-invalid',
    notes: 'null states "no expiry"; an absent key is not a statement',
  },

  // --- §3.2: identity, never position ----------------------------------
  'proposal-parent-by-position.refused.json': {
    validator: 'proposal',
    code: 'parent-position-not-identity',
  },

  // --- CRITICAL correction 1: authority is not identity ----------------
  'locator-hint-with-lease.refused.json': {
    validator: 'locator-hint',
    code: 'authority-field-in-locator-hint',
  },
  'locator-hint-with-home-ref.refused.json': {
    validator: 'locator-hint',
    code: 'authority-field-in-locator-hint',
  },
  'channel-home-absent-witness.refused.json': {
    validator: 'channel-home',
    code: 'record-invalid',
  },

  // --- chain shape ------------------------------------------------------
  'envelope-genesis-with-prev-link.refused.json': {
    validator: 'envelope',
    code: 'record-invalid',
  },
  'envelope-mid-chain-null-prev.refused.json': {
    validator: 'envelope',
    code: 'record-invalid',
    notes: 'a chain that begins in the middle is what the head anchor catches',
  },
  'envelope-seq-below-genesis.refused.json': {
    validator: 'envelope',
    code: 'record-invalid',
    notes:
      'seq 0 with a NON-null prev link, so only the genesis-floor guard fires — the earlier fixture tripped two guards and neither was provable',
  },
  'envelope-channel-mismatch.refused.json': {
    validator: 'envelope',
    code: 'record-invalid',
  },
  'envelope-embedded-proposal-invalid.refused.json': {
    validator: 'envelope',
    code: 'supersession-shape-invalid',
    notes:
      "the embedded proposal's diagnostics surface, prefixed, not swallowed",
  },

  // --- ordinary malformedness -------------------------------------------
  'proposal-both-body-and-ref.refused.json': {
    validator: 'proposal',
    code: 'record-invalid',
  },
  'proposal-no-body.refused.json': {
    validator: 'proposal',
    code: 'record-invalid',
  },
  'proposal-unknown-schema-version.refused.json': {
    validator: 'proposal',
    code: 'schema-version-unknown',
  },
  'checkpoint-unknown-schema-version.refused.json': {
    validator: 'checkpoint',
    code: 'schema-version-unknown',
  },
  'checkpoint-empty-head-digest.refused.json': {
    validator: 'checkpoint',
    code: 'record-invalid',
    notes:
      'one violation, so deleting the headEnvelopeDigest guard turns it red',
  },
  'checkpoint-absent-log-digest.refused.json': {
    validator: 'checkpoint',
    code: 'record-invalid',
    notes: 'one violation, so deleting the logDigest guard turns it red',
  },

  // --- accepted, and adversarial anyway ---------------------------------
  'proposal-future-happened-at.valid.json': {
    validator: 'proposal',
    adversarialButAccepted: true,
    notes:
      '§5.2 accepts an author clock in the future and clamps DISPLAY; refusing it here would treat the untrusted clock as authoritative',
  },
  'proposal-asserts-assurance-level.valid.json': {
    validator: 'proposal',
    adversarialButAccepted: true,
    notes:
      'carries assuranceLevel/signature/verified as self-asserted fields; the assurance DERIVATION must ignore all of them',
  },
  'proposal-prototype-keys.refused.json': {
    validator: 'proposal',
    code: 'forbidden-key',
    notes:
      'a __proto__ member survives JSON.parse as data and changes meaning in any consumer that re-materialises it — refused rather than accommodated',
  },
  'checkpoint-conflicting-head.valid.json': {
    validator: 'checkpoint',
    adversarialButAccepted: true,
    notes:
      'the equivocation pair; conflict lives in the comparison, not the shape',
  },
  'checkpoint-other-epoch.valid.json': {
    validator: 'checkpoint',
    adversarialButAccepted: true,
    notes: 'a different coordinate is not-comparable, never a conflict',
  },
};

describe('the channel-state fixture corpus is exhaustively classified', () => {
  test('every fixture on disk has a manifest entry', () => {
    const onDisk = readdirSync(CHANNEL_FIXTURE_DIR)
      .filter((name) => name.endsWith('.json'))
      .sort();
    const unclassified = onDisk.filter((name) => !(name in CORPUS));
    expect(unclassified).toEqual([]);
  });

  test('every manifest entry names a fixture that exists', () => {
    const onDisk = new Set(readdirSync(CHANNEL_FIXTURE_DIR));
    const phantom = Object.keys(CORPUS)
      .filter((name) => !onDisk.has(name))
      .sort();
    expect(phantom).toEqual([]);
  });

  test('the suffix and the expectation agree', () => {
    const disagreements = Object.entries(CORPUS)
      .filter(([name, entry]) => {
        const refused = name.endsWith('.refused.json');
        return refused !== (entry.code !== undefined);
      })
      .map(([name]) => name);
    expect(disagreements).toEqual([]);
  });

  test('the corpus covers every validator', () => {
    const covered = new Set(
      Object.values(CORPUS).map((entry) => entry.validator),
    );
    expect([...covered].sort()).toEqual(Object.keys(VALIDATORS).sort());
  });

  test('every station.channel-* record type HAS a validator', () => {
    // Slice-1 review, MEDIUM: "the corpus covers every validator" is
    // satisfied vacuously by a record type that has none — the gate could
    // report a missing fixture but never a missing validator, and three
    // record types (the refusal receipt and BOTH revocations) shipped
    // unguarded behind it. This asserts the other direction, and the map is
    // the ownership statement: adding a `station.channel-*` schema version
    // without a validator fails here.
    const OWNERSHIP: Record<string, ValidatorId> = {
      [CHANNEL_PROPOSAL_SCHEMA_VERSION]: 'proposal',
      [CHANNEL_SEQUENCE_SCHEMA_VERSION]: 'envelope',
      [CHANNEL_CHECKPOINT_SCHEMA_VERSION]: 'checkpoint',
      [CHANNEL_HOME_SCHEMA_VERSION]: 'channel-home',
      [CHANNEL_REFUSAL_RECEIPT_SCHEMA_VERSION]: 'refusal-receipt',
      [CHANNEL_MEMBER_KEY_SCHEMA_VERSION]: 'member-key',
      [CHANNEL_DEVICE_CERTIFICATE_SCHEMA_VERSION]: 'device-certificate',
      [CHANNEL_KEY_REVOCATION_SCHEMA_VERSION]: 'key-revocation',
      [CHANNEL_AGENT_AUTHORIZATION_SCHEMA_VERSION]: 'agent-grant',
      [CHANNEL_AGENT_AUTHORIZATION_REVOCATION_SCHEMA_VERSION]:
        'authorization-revocation',
    };

    // Its owner must get PAST the version gate (and then fail on the missing
    // fields), while every other versioned validator must refuse the version.
    const unowned: string[] = [];
    const misclaimed: string[] = [];
    for (const [schemaVersion, owner] of Object.entries(OWNERSHIP)) {
      const ownerResult = VALIDATORS[owner]({ schemaVersion });
      const ownerRefusedTheVersion =
        !ownerResult.ok &&
        ownerResult.diagnostics.some(
          (d) => d.code === 'schema-version-unknown',
        );
      if (ownerResult.ok || ownerRefusedTheVersion) unowned.push(schemaVersion);

      for (const [otherId, validate] of Object.entries(VALIDATORS)) {
        // The locator hint is not a versioned record — it is the bare
        // {channelId, locatorHint} a manifest may carry — so it has no
        // version gate to check.
        if (otherId === owner || otherId === 'locator-hint') continue;
        const other = validate({ schemaVersion });
        const refused =
          !other.ok &&
          other.diagnostics.some((d) => d.code === 'schema-version-unknown');
        if (!refused) misclaimed.push(`${otherId} accepted ${schemaVersion}`);
      }
    }
    expect(unowned).toEqual([]);
    expect(misclaimed).toEqual([]);
  });

  test('every validator has at least one accepted and one refused fixture', () => {
    for (const validator of Object.keys(VALIDATORS) as ValidatorId[]) {
      const entries = Object.values(CORPUS).filter(
        (entry) => entry.validator === validator,
      );
      expect(
        entries.some((entry) => entry.code === undefined),
        `${validator} has no accepted fixture`,
      ).toBe(true);
      expect(
        entries.some((entry) => entry.code !== undefined),
        `${validator} has no refused fixture`,
      ).toBe(true);
    }
  });
});

describe('every fixture behaves exactly as the manifest declares', () => {
  test.each(Object.entries(CORPUS))('%s', (name, entry) => {
    const parsed = readChannelFixture(name);
    const result = VALIDATORS[entry.validator](parsed);

    if (entry.code === undefined) {
      if (!result.ok) {
        throw new Error(
          `${name} was expected to validate and did not: ${result.errors.join(' | ')}`,
        );
      }
      return;
    }

    expect(result.ok, `${name} was expected to be refused`).toBe(false);
    if (result.ok) return;
    expect(
      result.diagnostics.map((diagnostic) => diagnostic.code),
      `${name}: diagnostics were ${JSON.stringify(result.diagnostics)}`,
    ).toContain(entry.code);
    // A refusal that says nothing is a refusal nobody can act on.
    for (const diagnostic of result.diagnostics) {
      expect(diagnostic.message.length).toBeGreaterThan(0);
    }
    expect(result.errors).toHaveLength(result.diagnostics.length);
  });
});

describe('round trip', () => {
  test('every accepted fixture survives JSON.parse(JSON.stringify(...)) and re-validates identically', () => {
    for (const [name, entry] of Object.entries(CORPUS)) {
      if (entry.code !== undefined) continue;
      const parsed = readChannelFixture(name);
      const roundTripped = JSON.parse(JSON.stringify(parsed)) as unknown;
      expect(roundTripped, name).toEqual(parsed);
      const before = VALIDATORS[entry.validator](parsed);
      const after = VALIDATORS[entry.validator](roundTripped);
      expect(after.ok, name).toBe(before.ok);
    }
  });

  test('a validator returns the SAME object it was handed, never a copy', () => {
    // If a validator reconstructed the record, the embedded proposal's bytes
    // would stop being byte-identical and its signature would stop being
    // checkable (§3.2's whole reason for embedding verbatim).
    const parsed = readChannelFixture('envelope-mid-chain.valid.json');
    const result = validateChannelSequencingEnvelope(parsed);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record).toBe(parsed);
    expect(result.record.proposal).toBe(
      (parsed as { proposal: unknown }).proposal,
    );
  });
});
