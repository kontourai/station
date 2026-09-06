import { describe, expect, test } from 'vitest';
import { collectTestContractReview } from '../test-contract-review.mjs';

describe('contract-test review is advisory and scoped to the actual diff', () => {
  test('flags removed assertions and newly skipped tests', () => {
    expect(
      collectTestContractReview(`diff --git a/tests/mobile.spec.ts b/tests/mobile.spec.ts
--- a/tests/mobile.spec.ts
+++ b/tests/mobile.spec.ts
- expect(project).toBeVisible();
+ test.skip('project switching', () => {});
`),
    ).toEqual([
      {
        path: 'tests/mobile.spec.ts',
        signals: ['assertion-or-selector-removed', 'test-selection-changed'],
      },
    ]);
  });
  test('flags a deleted test file rather than losing it at /dev/null', () => {
    expect(
      collectTestContractReview(`diff --git a/tests/mobile.spec.ts b/tests/mobile.spec.ts
--- a/tests/mobile.spec.ts
+++ /dev/null
- await expect(project).toBeVisible();
`)[0]?.path,
    ).toBe('tests/mobile.spec.ts');
  });
  test('separates policy decisions from implementation changes and unchanged context', () => {
    expect(
      collectTestContractReview(`diff --git a/src-ui/src/view.tsx b/src-ui/src/view.tsx
- const assert = true;
+ const assert = false;
diff --git a/config/product-laws.json b/config/product-laws.json
- "invariant": "direct project switching"
+ "invariant": "project switching through a menu"
`),
    ).toEqual([
      {
        path: 'config/product-laws.json',
        signals: ['contract-or-evidence-policy-changed'],
      },
    ]);
    expect(
      collectTestContractReview(`diff --git a/tests/mobile.spec.ts b/tests/mobile.spec.ts
  expect(project).toBeVisible();
+ // extra explanation
`),
    ).toEqual([]);
  });
});
