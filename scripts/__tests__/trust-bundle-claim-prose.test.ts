/**
 * station#1552 — an attestation claim may not state a suite count as prose.
 *
 * A public synthetic `trust.bundle` fixture asserts a pass count on an
 * attestation claim. The evidence class is honest; the reader-facing prose
 * must be too. It either names the count as session-local attestation evidence
 * or omits it, because an attestation does not substantiate CI output.
 *
 * An earlier attempt at this went after the metadata, which was already
 * correct, and had to be abandoned on review. The metadata was never the lie.
 *
 * This test is the ratchet under that discipline: state the result as an
 * attestation, or omit the count. A count is a claim about an execution and
 * belongs on a claim that has supporting evidence.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const FIXTURE_ROOT = join(HERE, 'fixtures', 'trust-bundle-claim-prose');
const EXPECTED_FIXTURE_BUNDLES = [
  'scripts/__tests__/fixtures/trust-bundle-claim-prose/disclosed-attestation/trust.bundle',
  'scripts/__tests__/fixtures/trust-bundle-claim-prose/grandfathered-undisclosed-count/trust.bundle',
];

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
 * Committed public fixtures that model records predating this rule.
 *
 * They are GRANDFATHERED, not tolerated. The fixture keeps an undisclosed
 * count so the exemption mechanism remains observable and removable without
 * carrying any private historical record into this public repository.
 *
 * The list is asserted EXACT below: an entry that stops violating is stale
 * and fails, and a new violation cannot be absorbed by appending to it
 * without a reviewer seeing the diff.
 */
const GRANDFATHERED_CLAIMS = [
  {
    bundle:
      'scripts/__tests__/fixtures/trust-bundle-claim-prose/grandfathered-undisclosed-count/trust.bundle',
    claimId: 'fixture.grandfathered-undisclosed-count',
    reason: 'synthetic-legacy-attestation-count',
  },
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

function collectBundleViolations(
  bundle: TrustBundle,
  path: string,
): Violation[] {
  const attestationClaimIds = new Set(
    (bundle.evidence ?? [])
      .filter((entry) => entry.evidenceType === 'attestation')
      .map((entry) => entry.claimId),
  );
  return (bundle.claims ?? []).flatMap((claim) => {
    const policyIsAttestation =
      claim.verificationPolicyId?.endsWith(':attestation') === true;
    const classified = attestationClaimIds.has(claim.id) || policyIsAttestation;
    const text = claim.fieldOrBehavior ?? '';
    if (
      !classified ||
      !statesResultCount(text) ||
      ATTESTATION_DISCLOSURES.test(text)
    )
      return [];
    return [
      {
        bundle: relative(REPO_ROOT, path),
        claimId: claim.id ?? '(unnamed claim)',
        fieldOrBehavior: text,
      },
    ];
  });
}

function collectViolations(root = FIXTURE_ROOT): Violation[] {
  return findBundles(root).flatMap((path) =>
    collectBundleViolations(
      JSON.parse(readFileSync(path, 'utf8')) as TrustBundle,
      path,
    ),
  );
}

function isGrandfatheredViolation(violation: Violation): boolean {
  return GRANDFATHERED_CLAIMS.some(
    (record) =>
      record.bundle === violation.bundle &&
      record.claimId === violation.claimId,
  );
}

describe('a trust-bundle claim does not state more than its evidence class supports', () => {
  it('finds the exact nonzero public fixture inventory', () => {
    // Vacuous green is the failure mode this whole cluster of issues is
    // about; a corpus scan that silently found nothing would be an instance
    // of it.
    expect(
      findBundles(FIXTURE_ROOT)
        .map((path) => relative(REPO_ROOT, path))
        .sort(),
    ).toEqual([...EXPECTED_FIXTURE_BUNDLES].sort());
  });

  it('accepts a disclosed session-local attestation count', () => {
    const positive = join(
      FIXTURE_ROOT,
      'disclosed-attestation',
      'trust.bundle',
    );
    expect(
      collectBundleViolations(
        JSON.parse(readFileSync(positive, 'utf8')) as TrustBundle,
        positive,
      ),
    ).toEqual([]);
  });

  it('identifies the public undisclosed count fixture before its explicit grandfather exemption', () => {
    expect(collectViolations()).toEqual([
      expect.objectContaining({
        claimId: 'fixture.grandfathered-undisclosed-count',
      }),
    ]);
  });

  it('carries no un-disclosed pass/fail count on an attestation claim', () => {
    const violations = collectViolations().filter(
      (violation) => !isGrandfatheredViolation(violation),
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
    const violating = collectViolations().map(({ bundle, claimId }) => ({
      bundle,
      claimId,
    }));
    expect(
      GRANDFATHERED_CLAIMS.map(({ bundle, claimId }) => ({ bundle, claimId })),
    ).toEqual(violating);
    for (const record of GRANDFATHERED_CLAIMS) {
      expect(record.reason).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });

  it('fails mutations that hide an attestation count or rely only on policy classification', () => {
    const positivePath = join(
      FIXTURE_ROOT,
      'disclosed-attestation',
      'trust.bundle',
    );
    const positive = JSON.parse(
      readFileSync(positivePath, 'utf8'),
    ) as TrustBundle;
    const hiddenCount = structuredClone(positive);
    hiddenCount.claims![0]!.fieldOrBehavior = 'Fixture run passed: 12/12.';
    expect(collectBundleViolations(hiddenCount, positivePath)).toHaveLength(1);

    const unsupported = structuredClone(positive);
    unsupported.evidence = [];
    unsupported.claims![0]!.fieldOrBehavior = 'Fixture run passed: 18/18.';
    expect(collectBundleViolations(unsupported, positivePath)).toHaveLength(1);

    const relocated = structuredClone(positive);
    relocated.claims![0]!.id = 'fixture.grandfathered-undisclosed-count';
    relocated.claims![0]!.fieldOrBehavior = 'Fixture run passed: 12/12.';
    const relocatedViolation = collectBundleViolations(relocated, positivePath);
    expect(relocatedViolation).toHaveLength(1);
    expect(isGrandfatheredViolation(relocatedViolation[0]!)).toBe(false);

    const designatedPath = join(
      FIXTURE_ROOT,
      'grandfathered-undisclosed-count',
      'trust.bundle',
    );
    const designatedViolation = collectBundleViolations(
      JSON.parse(readFileSync(designatedPath, 'utf8')) as TrustBundle,
      designatedPath,
    );
    expect(designatedViolation).toHaveLength(1);
    expect(isGrandfatheredViolation(designatedViolation[0]!)).toBe(true);
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
