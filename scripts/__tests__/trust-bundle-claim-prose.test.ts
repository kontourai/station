/**
 * station#1552 — an attestation claim may not state a suite count as prose.
 *
 * `delivery/kontourai-station-558/trust.bundle` asserts, in the field a human
 * reads:
 *
 *   "Node 24 ci:fast passed: … 539/539 unit files with 3822 passed/7
 *    skipped, 151/151 dogfood-reconcile, …"
 *
 * on a claim carrying `check_kind: "external"` and `evidenceType:
 * "attestation"`. **The metadata is honest** — that vocabulary is the
 * ratified way to say "session-local, not CI-reconcilable", and a machine
 * consumer reads it correctly. The sentence is not: a precise, falsifiable
 * count sitting in the human-readable field of a claim that substantiates
 * none of it. The two audiences get different answers from one artifact, and
 * the audience that gets the wrong one is the human.
 *
 * An earlier attempt at this went after the metadata, which was already
 * correct, and had to be abandoned on review. The metadata was never the lie.
 *
 * The fix is writer discipline, and the exemplar needs no code:
 * `flow-agents/delivery/codex-capture-false-pass-470/` handles the identical
 * situation by naming what it is — "recorded as a session-local attestation,
 * not a CI-reconcilable test_output claim". This test is the ratchet under
 * that discipline: state the result AS an attestation, or omit the count. A
 * count is a claim about an execution and belongs on a claim that has one.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const DELIVERY_ROOT = join(REPO_ROOT, 'delivery');

interface BundleEvidence {
  claimId?: string;
  evidenceType?: string;
}

/**
 * Only the fields this test actually reads. `value` and `metadata.check_kind`
 * were declared here and never consulted — a type stating more than its use
 * supports, which is the defect class this very file is about (review M2).
 */
interface BundleClaim {
  id?: string;
  fieldOrBehavior?: string;
  verificationPolicyId?: string;
}

interface TrustBundle {
  claims?: BundleClaim[];
  evidence?: BundleEvidence[];
}

/**
 * Committed bundles that predate this rule.
 *
 * They are GRANDFATHERED, not tolerated: `delivery/README.md` records what
 * each sentence overstates. They are not reworded because a claim's `id` is
 * derived from its `fieldOrBehavior` — `trust.checkpoint.json` keys its
 * per-claim verdicts by that id, and the bundles carry an event chain — so
 * editing the prose would silently orphan the checkpoint. Rewriting history
 * to look better is the wrong fix for a bundle whose whole purpose is to be
 * a record.
 *
 * The list is asserted EXACT below: an entry that stops violating is stale
 * and fails, and a new violation cannot be absorbed by appending to it
 * without a reviewer seeing the diff.
 */
const GRANDFATHERED_CLAIM_IDS = [
  'kontourai-station-333-responsive-action-surface.flow-agents-workflow.responsive-action-inventory-passes-at-50-action-surfaces-16-covered-direct-desktop-row-and-pixel-44px-trigger-geometry-passed-in-focused-playwright-5-5',
  'kontourai-station-558-responsive-foundation-ci-fast.flow-agents-workflow.node-24-ci-fast-passed-responsive-ratchet-biome-warnings-only-typescript-539-539-unit-files-with-3822-passed-7-skipped-151-151-dogfood-reconcile-server-ui-production-builds-and-bundle-budgets',
];

/**
 * Phrases that make a count honest by naming what backs it. Present in the
 * sentence, the reader knows they are looking at a session-local claim
 * rather than a reconciled result — which is all this rule asks for.
 */
const ATTESTATION_DISCLOSURES =
  /attestation|attested|not ci-reconcilable|not reconciled|session-local|unverified/i;

/**
 * A pass/fail COUNT: a figure that reads as the result of an execution.
 *
 * Deliberately narrow. Dates (`2026-07-25/26`), issue numbers (`#642`),
 * digests, and version strings are not results, and a rule that tripped on
 * them would be turned off within a week. The signal is a number tied to a
 * pass/fail vocabulary.
 */
function statesResultCount(text: string): boolean {
  const ratio = /\b\d[\d,]*\s*\/\s*\d[\d,]*\b/;
  const resultWord =
    /\b(pass|passed|passes|passing|fail|failed|failures|green)\b/i;
  if (ratio.test(text) && resultWord.test(text)) return true;
  if (/\b\d[\d,]*\s+(passed|failed|skipped|failures?|errors?)\b/i.test(text)) {
    return true;
  }
  if (/\b(passed|failed)\s+\d[\d,]*\b/i.test(text)) return true;
  return false;
}

function findBundles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      findBundles(full, out);
    } else if (entry === 'trust.bundle') {
      out.push(full);
    }
  }
  return out;
}

interface Violation {
  bundle: string;
  claimId: string;
  fieldOrBehavior: string;
}

function collectViolations(): Violation[] {
  const violations: Violation[] = [];
  for (const path of findBundles(DELIVERY_ROOT)) {
    const bundle = JSON.parse(readFileSync(path, 'utf8')) as TrustBundle;
    const attestationClaimIds = new Set(
      (bundle.evidence ?? [])
        .filter((entry) => entry.evidenceType === 'attestation')
        .map((entry) => entry.claimId),
    );
    for (const claim of bundle.claims ?? []) {
      const policyIsAttestation =
        claim.verificationPolicyId?.endsWith(':attestation') === true;
      const classified =
        attestationClaimIds.has(claim.id) || policyIsAttestation;
      if (!classified) continue;

      const text = claim.fieldOrBehavior ?? '';
      if (!statesResultCount(text)) continue;
      if (ATTESTATION_DISCLOSURES.test(text)) continue;

      violations.push({
        bundle: relative(REPO_ROOT, path),
        claimId: claim.id ?? '(unnamed claim)',
        fieldOrBehavior: text,
      });
    }
  }
  return violations;
}

describe('a trust-bundle claim does not state more than its evidence class supports', () => {
  it('finds bundles to check', () => {
    // Vacuous green is the failure mode this whole cluster of issues is
    // about; a corpus scan that silently found nothing would be an instance
    // of it.
    expect(findBundles(DELIVERY_ROOT).length).toBeGreaterThan(0);
  });

  it('carries no un-disclosed pass/fail count on an attestation claim', () => {
    const violations = collectViolations().filter(
      (violation) => !GRANDFATHERED_CLAIM_IDS.includes(violation.claimId),
    );
    expect(
      violations,
      violations.length === 0
        ? ''
        : `An attestation claim states a pass/fail count as fact:\n${violations
            .map(
              (violation) =>
                `  ${violation.bundle}\n    ${violation.fieldOrBehavior}`,
            )
            .join(
              '\n',
            )}\nEither omit the count or name it as an attestation, e.g. "recorded as a session-local attestation, not a CI-reconcilable test_output claim".`,
    ).toEqual([]);
  });

  it('keeps the grandfathered list exact', () => {
    // A stale exemption is an exemption for nothing, and a growing one is the
    // rule quietly repealed. Both fail here.
    const violating = collectViolations().map((violation) => violation.claimId);
    expect([...GRANDFATHERED_CLAIM_IDS].sort()).toEqual([...violating].sort());
  });

  it('does not fire on dates, issue numbers, or digests', () => {
    // The corpus contains all three on attestation claims. A rule that
    // flagged them would be switched off, so its narrowness is load-bearing.
    expect(
      statesResultCount(
        'owner-directed slice (2026-07-25/26 sessions); worktree at origin/main a85e9ea8',
      ),
    ).toBe(false);
    expect(statesResultCount('PR #642 opened for the reviewed #609 work')).toBe(
      false,
    );
    expect(
      statesResultCount(
        'assignment sha256:0e1f7f061f946d559429a991e96885f8f70a7b77479bcf878b826118439b1666',
      ),
    ).toBe(false);
    // And it does fire on the shapes that made #1552.
    expect(statesResultCount('539/539 unit files with 3822 passed')).toBe(true);
    // The ratio rule alone, with no `<count> passed` phrase to fall back on —
    // this is station#333's sentence, and disabling the ratio rule must not
    // leave the other two rules quietly covering for it.
    expect(
      statesResultCount(
        'Pixel >=44px trigger geometry passed in focused Playwright 5/5',
      ),
    ).toBe(true);
    expect(statesResultCount('product 232 passed / 4 failed')).toBe(true);
    expect(statesResultCount('Playwright passed 196/196')).toBe(true);
    // Naming the class is the escape hatch, and it has to work.
    expect(
      ATTESTATION_DISCLOSURES.test(
        'Recorded as a session-local attestation, not a CI-reconcilable test_output claim: 539/539 unit files passed.',
      ),
    ).toBe(true);
  });
});
