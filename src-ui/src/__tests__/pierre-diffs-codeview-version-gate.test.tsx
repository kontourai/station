/**
 * @vitest-environment jsdom
 */

// archive#3159 tripwire.
//
// DiffPanel.tsx's controlled `<CodeView items={...} />` seam depends on an
// *installed-package internal* behaviour that nothing in @pierre/diffs'
// public type declarations documents: a controlled item is only re-consulted
// (its header/annotation render callbacks re-invoked, its DOM updated) when
// `item.version` changes from what CodeView last saw. If `version` is
// unchanged, the update is silently discarded — see
// `node_modules/@pierre/diffs/dist/components/CodeView.js`'s
// `syncItemRecord` ("Matching versions mean CodeView keeps the current
// record snapshot"), and two further version-keyed equality checks upstream
// of it in the same file and in
// `node_modules/@pierre/diffs/dist/utils/areManagedSnapshotsEqual.js` that
// gate the exact same field before a controlled update ever reaches React.
// (Verified empirically, not by reading the.d.ts: patching all three of
// those checks to stop comparing `.version` is what makes the "same
// version" assertion below go red — see the fault-injection note.)
//
// DiffPanel.tsx's `itemsRevisionRef` (added by archive#3104) exists solely to
// satisfy this contract by stamping a fresh `version` on every genuine
// `items` recompute. This test exercises the real @pierre/diffs `CodeView`
// component directly (no DiffPanel, no mocks of the library) to prove that
// contract holds today, so a future @pierre/diffs upgrade that changes the
// gate's shape (renames the field, stops gating on it, gates on something
// else) reddens here instead of silently reintroducing stale renders in
// DiffPanel.
//
// Fault-injection evidence (not re-run by CI, recorded for reviewers):
// temporarily patching `node_modules/@pierre/diffs/dist/components/CodeView.js`'s
// `syncItemRecord` and `areSlotSnapshotsEqual`, plus
// `dist/utils/areManagedSnapshotsEqual.js`'s `areManagedSnapshotsEqual`, so
// none of the three compare `.version` anymore turned the "stays stale"
// assertion below red (`expected 'v1-updated' to be 'v1'`) and left the
// "updates after a version bump" assertion passing either way — confirming
// this test is actually sensitive to the gate's current shape, not just to
// whether *some* update ever lands.

import { parsePatchFiles } from '@pierre/diffs';
import { CodeView, type CodeViewDiffItem } from '@pierre/diffs/react';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, test } from 'vitest';

// This test drives a REAL `CodeView` — real Shiki tokenization, real custom
// elements — so its cost is render work, not assertions, and it is therefore
// sensitive to host contention rather than to anything it asserts. Measured
// at ~670ms of test time on a loaded host, which is single-digit-multiple
// headroom against `waitFor`'s 1000ms default.
//
// archive#3161 was exactly this shape: a heavy, contention-sensitive test
// inheriting a default tuned for assertion-shaped ones, timing out at 5007ms
// against 5000ms and reading as a failure. Shipping another one in the batch
// that fixed it would be self-defeating, so both the per-`waitFor` budget and
// the test budget are explicit and generous. A genuine regression fails on
// the assertion, not the clock.
const RENDER_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = 30_000;

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

const PATCH = `diff --git a/foo.ts b/foo.ts
--- a/foo.ts
+++ b/foo.ts
@@ -1,3 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 3;
 const c = 4;
`;

// A marker field CodeView itself never reads, only our own
// renderHeaderMetadata callback does — so its rendered value tells us
// exactly which `item.item` object CodeView is currently retaining
// internally, independent of anything CodeView derives from `fileDiff`.
type MarkedItem = CodeViewDiffItem<never> & { marker: string };

function buildItem(version: number, marker: string): MarkedItem {
  const [fileDiff] = parsePatchFiles(PATCH, 'test').flatMap((p) => p.files);
  return {
    id: 'foo.ts',
    type: 'diff',
    fileDiff,
    version,
    marker,
  } as MarkedItem;
}

describe('@pierre/diffs CodeView controlled-item version gate (station#3159 tripwire)', () => {
  test(
    'an item update is withheld when version is unchanged, and applied once version changes',
    async () => {
      const renderHeaderMetadata = (item: unknown) => (
        <span data-testid="marker">{(item as MarkedItem).marker}</span>
      );
      const options = { theme: 'pierre-dark', themeType: 'dark' as const };

      const { rerender } = render(
        <CodeView
          items={[buildItem(1, 'first')]}
          renderHeaderMetadata={renderHeaderMetadata}
          disableWorkerPool
          options={options}
        />,
      );
      await waitFor(() => screen.getByTestId('marker'), {
        timeout: RENDER_TIMEOUT_MS,
      });
      expect(screen.getByTestId('marker').textContent).toBe('first');

      // Same version, different content: CodeView's controlled-item gate must
      // discard this update entirely. This is exactly DiffPanel's pre-archive#3104
      // bug shape — a fresh item object with an unchanged `version`.
      rerender(
        <CodeView
          items={[buildItem(1, 'second')]}
          renderHeaderMetadata={renderHeaderMetadata}
          disableWorkerPool
          options={options}
        />,
      );
      // Give any (async, e.g. Shiki-tokenization-driven) update a real chance
      // to land before asserting it didn't.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(screen.getByTestId('marker').textContent).toBe('first');

      // Bumping version must apply the update — this is the half of the
      // contract DiffPanel's `itemsRevisionRef` relies on.
      rerender(
        <CodeView
          items={[buildItem(2, 'third')]}
          renderHeaderMetadata={renderHeaderMetadata}
          disableWorkerPool
          options={options}
        />,
      );
      await waitFor(
        () => expect(screen.getByTestId('marker').textContent).toBe('third'),
        { timeout: RENDER_TIMEOUT_MS },
      );
    },
    TEST_TIMEOUT_MS,
  );
});
