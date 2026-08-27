/**
 * station#1598 — the answer-share channel binding's fixture corpus.
 *
 * Same discipline as the slice-1 channel-state corpus and for the same
 * reason: a contracts slice's risk is that it is unfalsifiable, so the
 * binding gets a fail-closed validator and the validator gets real JSON
 * parsed off disk with `JSON.parse` rather than typed literals the compiler
 * has already vouched for.
 *
 * The manifest below gates the directory in BOTH directions, so a fixture
 * cannot be added and left unasserted and an entry cannot outlive its file.
 * Refused fixtures declare a diagnostic CODE, never a message substring.
 *
 * A separate directory from `channel-state/` on purpose: that corpus's own
 * bidirectional gate would fail on any file it does not classify, and these
 * records are validated by a different module.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { validateAnswerShareChannelBinding } from '../answer-share-channel.js';
import type { ChannelDiagnosticCode } from '../channel-log.js';

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'answer-share-channel',
);

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')) as unknown;
}

interface FixtureEntry {
  /** For a `.refused.json` fixture: the code that MUST appear. */
  code?: ChannelDiagnosticCode;
  /**
   * A `.legacy.json` fixture is a whole stored share record rather than a
   * binding — it is here to pin the shape of a record minted BEFORE bindings
   * existed, which is a fixture no binding validator can classify.
   */
  legacyRecord?: true;
  notes?: string;
}

const CORPUS: Record<string, FixtureEntry> = {
  // --- the two states mint time can actually observe --------------------
  'binding-committed.valid.json': {
    notes: 'identity in `ref`, position in `coordinate`, anchor alongside',
  },
  'binding-none.valid.json': {
    notes:
      'the affirmative observation "no channel coordinate" — a FACT, not a gap',
  },

  // --- §3.2: identity, never position -----------------------------------
  'binding-ref-by-position.refused.json': {
    code: 'parent-position-not-identity',
    notes:
      'the coordinate may carry a seq; the REF may never. Resolution goes through identity only, because a position names a different record after a recovery',
  },
  'binding-ref-to-proposal.refused.json': {
    code: 'record-invalid',
    notes:
      'a proposal is what a member ASKED for (§5.1); binding to one would cite a request as a place in history',
  },

  // --- §8.1: a cited read names its epoch AND its anchor -----------------
  'binding-absent-checkpoint-digest.refused.json': {
    code: 'record-invalid',
    notes:
      'one violation, so deleting the checkpointDigest guard turns this red',
  },
  'binding-seq-below-genesis.refused.json': {
    code: 'record-invalid',
    notes: 'a position no log ever assigned',
  },
  'binding-fractional-seq.refused.json': {
    code: 'record-invalid',
    notes: 'a sequence number is an integer or it is not a sequence number',
  },

  // --- a claim smuggled into a record that claims nothing ----------------
  'binding-none-with-coordinate.refused.json': {
    code: 'record-invalid',
    notes:
      'deny-by-default: a `none` binding carrying a coordinate is a claim hiding inside a record whose entire content is "there is no claim here"',
  },
  'binding-unknown-discriminant.refused.json': {
    code: 'record-invalid',
    notes:
      'there is no third stored state; "could not resolve" is computed at read time and lives in AnswerShareChannelStatus',
  },
  'binding-prototype-key.refused.json': {
    code: 'forbidden-key',
    notes:
      'refused through the SAME sweep a proposal uses, not a second copy of the list',
  },

  // --- the absent field, which is a state and not a missing value --------
  'share-record-without-binding.legacy.json': {
    legacyRecord: true,
    notes:
      'minted before bindings existed: reads as "unknown", never as "none"',
  },
};

describe('the answer-share channel corpus is exhaustively classified', () => {
  test('every fixture on disk has a manifest entry', () => {
    const onDisk = readdirSync(FIXTURE_DIR)
      .filter((name) => name.endsWith('.json'))
      .sort();
    expect(onDisk.filter((name) => !(name in CORPUS))).toEqual([]);
  });

  test('every manifest entry names a fixture that exists', () => {
    const onDisk = new Set(readdirSync(FIXTURE_DIR));
    expect(
      Object.keys(CORPUS)
        .filter((name) => !onDisk.has(name))
        .sort(),
    ).toEqual([]);
  });

  test('the suffix and the expectation agree', () => {
    const disagreements = Object.entries(CORPUS)
      .filter(([name, entry]) => {
        if (name.endsWith('.legacy.json')) return entry.legacyRecord !== true;
        return name.endsWith('.refused.json') !== (entry.code !== undefined);
      })
      .map(([name]) => name);
    expect(disagreements).toEqual([]);
  });

  test('the corpus carries at least one accepted and one refused binding', () => {
    const entries = Object.values(CORPUS).filter(
      (entry) => !entry.legacyRecord,
    );
    expect(entries.some((entry) => entry.code === undefined)).toBe(true);
    expect(entries.some((entry) => entry.code !== undefined)).toBe(true);
  });

  test('the manifest declares exactly the codes the validator actually produces', () => {
    // The other direction of the gate, derived from the real artifact rather
    // than from a literal list. Comparing the manifest against a hardcoded
    // array only proves the manifest matches the array — a fixture that
    // starts producing a fourth code leaves it green, which is the shape of
    // gap slice 1's review found three record types shipping behind.
    //
    // What this DOES catch: any code the corpus actually elicits that nobody
    // declared, and any declared code no fixture elicits. What it still does
    // not catch, stated rather than implied: a coded refusal in the validator
    // that no fixture reaches at all — nothing here can enumerate the
    // module's unreached branches.
    const declared = new Set(
      Object.values(CORPUS)
        .map((entry) => entry.code)
        .filter((code): code is ChannelDiagnosticCode => code !== undefined),
    );
    const produced = new Set<ChannelDiagnosticCode>();
    for (const [name, entry] of Object.entries(CORPUS)) {
      if (entry.legacyRecord || entry.code === undefined) continue;
      const result = validateAnswerShareChannelBinding(readFixture(name));
      if (result.ok) continue;
      for (const diagnostic of result.diagnostics) {
        produced.add(diagnostic.code);
      }
    }
    expect([...produced].sort()).toEqual([...declared].sort());
  });
});

describe('every fixture behaves exactly as the manifest declares', () => {
  test.each(
    Object.entries(CORPUS).filter(([, entry]) => entry.legacyRecord !== true),
  )('%s', (name, entry) => {
    const parsed = readFixture(name);
    const result = validateAnswerShareChannelBinding(parsed);

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

describe('an absent binding is a state, not a missing value', () => {
  test('the legacy record carries no channel field at all', () => {
    const parsed = readFixture('share-record-without-binding.legacy.json') as
      | Record<string, unknown>
      | undefined;
    expect(parsed).toBeTypeOf('object');
    expect(Object.hasOwn(parsed ?? {}, 'channel')).toBe(false);
    expect(Object.hasOwn(parsed ?? {}, 'contentDigest')).toBe(false);
  });

  test('absence cannot be laundered through the validator into `none`', () => {
    // The failure this refuses is a caller that "helpfully" defaults an
    // absent binding before validating it: `none` is the positive claim
    // "this answer has no channel coordinate", and a record that predates
    // bindings supports no such claim. The validator refuses the argument
    // rather than inventing a record for it.
    const result = validateAnswerShareChannelBinding(undefined);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((d) => d.code)).toContain('record-invalid');
  });
});

describe('the accepted fixtures survive a round trip', () => {
  test('JSON.parse(JSON.stringify(...)) re-validates identically', () => {
    for (const [name, entry] of Object.entries(CORPUS)) {
      if (entry.code !== undefined || entry.legacyRecord) continue;
      const parsed = readFixture(name);
      const roundTripped = JSON.parse(JSON.stringify(parsed)) as unknown;
      expect(roundTripped, name).toEqual(parsed);
      // `.toBe(true)`, not `.toBe(validate(parsed).ok)`: the loop already
      // filters to accepted fixtures, so asserting the validator against
      // itself on two equal inputs is a tautology that would stay green if
      // both sides started refusing.
      expect(validateAnswerShareChannelBinding(roundTripped).ok, name).toBe(
        true,
      );
    }
  });

  test('a validator returns the SAME object it was handed, never a copy', () => {
    const parsed = readFixture('binding-committed.valid.json');
    const result = validateAnswerShareChannelBinding(parsed);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record).toBe(parsed);
  });
});
