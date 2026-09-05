/**
 * @vitest-environment jsdom
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { render } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  assertNoImportsSurvive,
  chromiumIsInstalled,
  resolveCssImports,
} from '../../../tests/helpers/css-cascade-fixture';
import { TaskPicker } from '../components/chat/TaskPicker';

/**
 * The picker's dialog opened from inside a message bubble and rendered BEHIND
 * the next message card.
 *
 * The z-index was never the problem: `.station-dialog__overlay` already
 * declares `position: fixed` and `--layer-dialog` (10000). `.message-row`
 * animates its entry with a transform and keeps `will-change: transform` on the
 * newest row, and either one makes that row a containing block AND a stacking
 * context for `position: fixed` descendants. So the panel was positioned
 * against the ROW instead of the viewport, and its 10000 was scoped inside the
 * row — which the following row's own stacking context then painted over. No
 * layer token can climb out of an ancestor stacking context.
 *
 * jsdom computes no layout, so this measures the real markup in a real Chromium
 * page against the real cascade-resolved stylesheet (the harness
 * `ConnectionsSectionFrame.banner-hittest.test.tsx` established).
 *
 * DRIVEN: the user bubble as a non-final row (an assistant answer follows it,
 * the audited case) and as the FINAL row (where `will-change: transform`
 * survives permanently rather than only during the entry animation). NOT
 * driven: the mobile sheet geometry, which the shared overlay owns.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../');

const VIEWPORT = { width: 1200, height: 800 };

/**
 * Production puts this row in a fixed-descendant-trapping state two ways:
 * `.message-row`'s `animation: message-slide-in` applies a live transform while
 * it runs, and `.message-row:not(:last-child) { will-change: auto }` means the
 * NEWEST row keeps the hint permanently. Either one makes the row a containing
 * block AND a stacking context.
 *
 * The fixture states `will-change: transform` and CANCELS the animation, so the
 * hint is the single mechanism under test. Both halves matter: leaving the
 * animation on made the test's power a race against a duration (the review
 * finding), and it also hid the hint's own contribution — with the animation
 * running, removing `will-change` changed nothing and the self-guard below could
 * not tell a live fixture from a dead one.
 *
 * With the animation cancelled the two parameterised cases then exercise the two
 * production mechanisms separately: as a NON-final row the inline hint is the
 * only trap (proved — removing it reds the self-guard), and as the FINAL row
 * `.message-row`'s own `will-change` supplies it regardless, which is the state
 * the newest message in every transcript sits in permanently.
 */
function userRow() {
  return (
    <div
      className="message-row message-row--user"
      style={{ animation: 'none', willChange: 'transform' }}
    >
      <div className="message user">
        <div>Reply with exactly: TURN TWO OK</div>
        <div className="message__task-input-action">
          <TaskPicker
            target={{ sessionId: 'session-1', eventId: 'event-1' }}
            triggerLabel="Add input to Task"
            dialogTitle="Add input to Task"
            eyebrow="Pinned input"
            adapter={{ tasks: [{ id: 'task-1', title: 'Ship it' }] }}
            initiallyOpen
            attach={async () => undefined}
            successMessage={() => 'added'}
          />
        </div>
      </div>
    </div>
  );
}

function assistantRow() {
  return (
    <div className="message-row">
      <div className="message assistant">
        <p>
          An assistant answer that follows the user bubble in the DOM, and used
          to paint over the picker opened from it.
        </p>
      </div>
    </div>
  );
}

/**
 * Snapshots the whole BODY, not the render container: the dialog is portaled to
 * `document.body`, which is the fix under test — and the un-portaled shape this
 * fixture must also be able to reproduce still appears in the body markup, so
 * the same harness measures both.
 */
function renderTranscript(withFollowingAnswer: boolean): string {
  const { unmount } = render(
    <div className="chat-messages">
      {userRow()}
      {withFollowingAnswer ? assistantRow() : null}
    </div>,
  );
  const markup = document.body.innerHTML;
  unmount();
  return markup;
}

const fixtureCss = (() => {
  const css = [
    resolve(HERE, '../index.css'),
    resolve(HERE, '../components/chat/chat.css'),
    resolve(HERE, '../components/chat/TaskPicker.css'),
  ]
    .map((path) => resolveCssImports(path))
    .join('\n');
  assertNoImportsSurvive(css);
  return css;
})();

const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

type PanelGeometry = {
  top: number;
  left: number;
  width: number;
  height: number;
  /** The same overlay re-parented into the message row: the un-portaled shape. */
  trappedTop: number;
  hitIsInsidePanel: boolean;
  hitDescription: string;
};

describe.skipIf(!chromiumAvailable)(
  'the Task picker opened from a message bubble is not trapped by that bubble',
  () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>>;

    beforeAll(async () => {
      browser = await chromium.launch();
    });

    afterAll(async () => {
      await browser?.close();
    });

    async function measure(
      withFollowingAnswer: boolean,
    ): Promise<PanelGeometry> {
      const page = await browser.newPage({ viewport: VIEWPORT });
      try {
        await page.setContent(
          `<!doctype html><html><head><style>${fixtureCss}</style></head>` +
            `<body style="margin:0">${renderTranscript(withFollowingAnswer)}</body></html>`,
        );
        return await page.evaluate(() => {
          const panel = document.querySelector('.task-picker__dialog');
          if (!panel) throw new Error('the picker dialog did not render');
          const overlay = panel.closest('.responsive-surface-overlay');
          const row = document.querySelector('.message-row--user');
          if (!overlay || !row) throw new Error('fixture shape changed');
          // The SAME overlay, re-parented into the message row: the shape this
          // dialog had before it was portaled. Measuring it here is what keeps
          // this test honest — if the row ever stops trapping a fixed
          // descendant, `trappedTop` equals `top` and the assertion below says
          // the fixture lost its power instead of quietly passing.
          const clone = overlay.cloneNode(true) as HTMLElement;
          clone.dataset.unportaled = '';
          row.appendChild(clone);
          const trapped = clone.querySelector('.task-picker__dialog');
          if (!trapped) throw new Error('clone lost its panel');
          const trappedRect = trapped.getBoundingClientRect();
          const rect = panel.getBoundingClientRect();
          const hit = document.elementFromPoint(
            rect.left + rect.width / 2,
            rect.top + rect.height / 2,
          );
          clone.remove();
          return {
            top: Math.round(rect.top),
            left: Math.round(rect.left),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            trappedTop: Math.round(trappedRect.top),
            hitIsInsidePanel: !!hit && panel.contains(hit),
            hitDescription: hit
              ? `${hit.tagName.toLowerCase()}.${hit.className || '(no class)'}`
              : 'nothing',
          };
        });
      } finally {
        await page.close();
      }
    }

    test.each([
      ['an assistant answer follows it', true],
      ['it is the final row', false],
    ] as const)(
      'the panel is positioned against the viewport when %s',
      async (_label, withFollowingAnswer) => {
        const panel = await measure(withFollowingAnswer);
        // FIRST: the trap this fixture exists to escape is really here. The
        // un-portaled clone is positioned against the ROW, not the viewport —
        // measured at y = -129 when the real panel was inside the row. Equal
        // tops would mean the row no longer traps a fixed descendant and every
        // assertion below had stopped proving anything.
        expect(
          Math.abs(panel.trappedTop - panel.top),
          `the un-portaled clone and the panel measured the same top ` +
            `(${panel.trappedTop}). EITHER the dialog is no longer portaled — ` +
            'in which case the panel IS the trapped one and this is the ' +
            'regression — OR the fixture stopped reproducing the ' +
            'containing-block trap and can no longer prove anything. The ' +
            'viewport assertions below tell the two apart: a portal regression ' +
            'also puts the panel outside the viewport.',
        ).toBeGreaterThan(1);
        // THEN: the portaled panel is positioned against the viewport…
        expect({ top: panel.top >= 0, left: panel.left >= 0 }).toEqual({
          top: true,
          left: true,
        });
        expect(panel.height).toBeGreaterThan(0);
        expect(panel.top + panel.height).toBeLessThanOrEqual(VIEWPORT.height);
        // …and the pointer reaches it there. Folded into this test rather than
        // standing alone: on its own the hit test passed even for the trapped
        // panel, because the trap MOVED the panel rather than covering it, so
        // its centre still hit itself. Only paired with the containment above
        // does it discriminate.
        expect(
          panel.hitIsInsidePanel,
          `the point at the open panel's centre resolved to ${panel.hitDescription}`,
        ).toBe(true);
      },
    );
  },
);

/**
 * A `describe.skipIf` alone would make an uninstalled browser look like a
 * pass — the exact absence-as-success shape this suite exists to catch. The
 * sibling `HeaderActions.connection-reflow.test.tsx` established this guard.
 */
test.skipIf(chromiumAvailable)(
  'Task picker message-row stacking (#1536 B2) — Chromium not installed, cannot verify',
  () => {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so the ' +
        'browser-backed geometry assertions above did not run. Install it ' +
        '(`npx playwright install chromium`) and re-run.',
    );
  },
);
