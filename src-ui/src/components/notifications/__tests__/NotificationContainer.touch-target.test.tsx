/**
 * @vitest-environment jsdom
 *
 * archive#3513. Same gap `BannerHost.touch-target.test.tsx` (archive#3453)
 * closed, found again in this component: `index.css`'s global mobile
 * touch-target net is a DESCENDANT selector
 * (`:is([class*="__actions"], [class*="__footer"], [class*="__toolbar"],...)
 * > :is(button, a,.button, [role="button"])`), so it only reaches a control
 * that is a CHILD of one of those named wrappers. Three controls in this
 * component sit outside its reach:
 *
 * - `.notification-container__dismiss-all` (`NotificationContainer.tsx`) is a
 *   direct child of `.notification-container`, not of any `__actions`/
 *   `__footer`/`__toolbar` wrapper — its own declared `min-height: 36px`
 *   (`NotificationContainer.css`) is the only thing sizing it, at every
 *   viewport, with no mobile override anywhere in the file.
 * - `.toast-card__dismiss` sits inside `.toast-card__header`, not
 *   `.toast-card__actions` — the net cannot reach it either. It has its own
 *   44px override, but it used to live at `@media (max-width: 640px)`, a
 *   *different* breakpoint from the shell's `@media (max-width: 768px)`, so a
 *   viewport between 641px and 768px (and 915x412, the exact landscape-phone
 *   geometry archive#3453 measured) got the un-overridden 32x32 declaration.
 * - `.toast-card__link` ( finding) sits inside
 *   `.toast-card__conversation`, not `.toast-card__actions`, so the net
 *   cannot reach it either — and it had no override anywhere at all, at any
 *   viewport, the same as `.notification-container__dismiss-all`. It renders
 *   whenever a notification carries `conversationTitle` + `onNavigate`,
 *   which `toolActivityNotifications.ts` sets on essentially every
 *   tool-activity toast and `ToastContext.tsx` sets unconditionally
 *   (`conversationTitle` defaults to `'Conversation'`) for approvals — not a
 *   rare shape. An earlier version of this file's fixture set neither field,
 *   so this control never appeared in the enumerated audit below at all:
 *   the check's own docblock claimed "every interactive control" while
 *   deriving that claim from the fixture, not the component.
 *
 * Same check shape as `BannerHost.touch-target.test.tsx`: render the REAL
 * `NotificationContainer` (via `@testing-library/react`, jsdom) with a
 * fixture that exercises `.notification-container__dismiss-all` and every
 * `.toast-card` control (`.toast-card__dismiss`, `.toast-card__action`,
 * `.toast-card__link`), inject the resulting markup into a real Chromium
 * page carrying the REAL, unmodified source stylesheets (`index.css`'s
 * global net + `NotificationContainer.css`'s own rules, `@import`s fully
 * resolved), and enumerate EVERY `button, a` under `.notification-container`
 * as an exact, ordered class-name list.
 *
 * The approval queue is deliberately NOT in this fixture, for two different
 * reasons that do not both apply to both of its parts:
 * `.notification-approval-queue__trigger` renders whenever
 * `approvals.length > 0` — nothing gates it closed — but archive#3513 is
 * scoped to the transient-toast controls named above, and the trigger
 * already clears the floor (measured independently at 180.08x44 — NOT
 * verified by this file, since it never renders here). Its PANEL's controls
 * (Allow/Deny, dismiss) genuinely are closed by default
 * (`display: none` until `.is-open`) and would need the panel opened before
 * measurement, which this file does not attempt. An approval-queue audit
 * belongs with whatever issue actually targets it.
 *
 * PRECONDITION / RESOURCE CLASSIFICATION: identical to
 * `BannerHost.touch-target.test.tsx` — this launches a real Chromium via
 * `@playwright/test` (provisioned by `npm run install:playwright`, not
 * plain `npm ci`) and is listed in
 * `scripts/vitest-resource-manifest.mjs`'s `PROCESS_HEAVY_VITEST_FILES`.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { render } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import {
  isWslHost,
  WSL_QUARANTINE_REASON,
} from '../../../../../scripts/lib/wsl-host-class.mjs';
import {
  assertNoImportsSurvive,
  chromiumIsInstalled,
  resolveCssImports,
} from '../../../../../tests/helpers/css-cascade-fixture';
import { MIN_TOUCH_TARGET_PX } from '../../../../../tests/helpers/touch-target';
import { NotificationContainer } from '../NotificationContainer';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../../');
const INDEX_CSS_PATH = resolve(HERE, '../../../index.css');
const NOTIFICATION_CSS_PATH = resolve(HERE, '../NotificationContainer.css');

function buildFixtureCss(): string {
  const css = `${resolveCssImports(INDEX_CSS_PATH)}\n${resolveCssImports(NOTIFICATION_CSS_PATH)}`;
  assertNoImportsSurvive(css);
  return css;
}

// Same mocking shape as `NotificationContainer.test.tsx`: the component reads
// three contexts this file has no reason to provide real instances of.
const dismissToast = vi.fn();
const dismissAllToasts = vi.fn();
let notifications: Array<Record<string, unknown>> = [];

vi.mock('../../../contexts/ToastContext', () => ({
  useNotificationHistory: () => notifications,
  useToast: () => ({ dismissToast, dismissAllToasts }),
}));
vi.mock('../../../contexts/ActiveChatsContext', () => ({
  useAllActiveChats: () => ({}),
}));
vi.mock('../../../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    setProject: vi.fn(),
    setLayout: vi.fn(),
    navigate: vi.fn(),
  }),
}));

/**
 * Three transient notifications: enough to cross the `>= 3` threshold that
 * renders `.notification-container__dismiss-all`, and enough to populate the
 * toast stack with more than one `.toast-card__dismiss`. The front card also
 * carries an action button so `.toast-card__action` is in the same audit —
 * it is already reached by the global net (a child of `.toast-card__actions`,
 * which matches `[class*="__actions"]`) and is included as a passing control,
 * not a suspected defect. The mid card carries `conversationTitle` +
 * `onNavigate` (the real shape `toolActivityNotifications.ts` sets on a
 * tool-activity toast), which is what makes `NotificationContainer.tsx`
 * render `.toast-card__link` — the fix-round finding that was previously
 * invisible to this audit because no fixture notification set those fields.
 */
function presentFixtureNotifications(): void {
  const now = Date.now();
  notifications = [
    {
      id: 'station-3513:front',
      message: 'Build finished',
      type: 'info',
      timestamp: now,
      dismissed: false,
      actions: [{ label: 'Retry', variant: 'secondary', onClick: () => {} }],
    },
    {
      id: 'station-3513:mid',
      message: 'Dev Agent finished shell exec',
      type: 'tool-activity',
      timestamp: now,
      dismissed: false,
      conversationTitle: 'Repo Chat',
      onNavigate: () => {},
    },
    {
      id: 'station-3513:back',
      message: 'A third notification',
      type: 'info',
      timestamp: now,
      dismissed: false,
    },
  ];
}

function renderFixtureMarkup(): string {
  presentFixtureNotifications();
  const { container, unmount } = render(<NotificationContainer />);
  const markup = container.innerHTML;
  unmount();
  return markup;
}

/**
 * The stack's own peek/scale presentation (`toast-stack-layout.ts`,
 * `NotificationContainer.css`'s `.toast-stack:not(:hover)...` rule) shrinks
 * every card behind the front one AND sets `pointer-events: none` on them —
 * they are not tappable at all in that state. Forcing `data-expanded="true"`
 * (the same attribute a coarse-pointer tap on the collapsed stack sets,
 * `NotificationContainer.tsx`'s `expandStackOnCoarseTap`) matches the state
 * the cards are actually interactive in, so their measured size is the real
 * touch target rather than an artifact of the collapsed peek's `scale`.
 */
function expandToastStack(markup: string): string {
  return markup.replace(
    'data-testid="toast-stack"',
    'data-testid="toast-stack" data-expanded="true"',
  );
}

function buildFixtureHtml(): string {
  const css = buildFixtureCss();
  const markup = expandToastStack(renderFixtureMarkup());
  return `<!doctype html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <style>${css}</style>
  </head>
  <body>${markup}</body>
</html>`;
}

const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

/**
 * archive#4177 INTERIM quarantine — WSL2 fleet-runner host class ONLY. With
 * archive#4170's provisioning live, this file's real-Chromium assertions executed on
 * the runner's Chromium for the first time ever and failed there while green
 * on macOS Chromium — the same never-green-baseline shape as the
 * verification-coordinator family (WSL2 Chromium rendering metrics; evidence
 * on archive#4177). On a WSL host the real-Chromium cases skip and the
 * sentinel below names the skip with the archive#4177 reason; the missing-Chromium
 * fail-loud sentinel keeps its behavior on ALL hosts. The open fix is WSL
 * compatibility, not this skip.
 */
const wslQuarantinedHost = isWslHost();

/**
 * Three viewports, each proving a different half of archive#3513:
 * - 390x844: an ordinary portrait phone, well under every breakpoint in play
 * `.notification-container__dismiss-all` has no breakpoint that helps it
 *   at all, so this alone is enough to catch that defect.
 * - 700x900 coarse: inside the 641-768px gap between the shell's 768px net
 *   and `.toast-card__dismiss`'s old 640px override — the case that made the
 *   two controls different defects, not the same one.
 * - 915x412 coarse: the exact landscape-phone geometry archive#3453 measured
 *   for the same class of defect.
 */
const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 700, height: 900 },
  { width: 915, height: 412 },
] as const;

describe.skipIf(!chromiumAvailable || wslQuarantinedHost)(
  'NotificationContainer mobile touch targets (station#3513)',
  () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>>;

    beforeAll(async () => {
      browser = await chromium.launch();
    });

    afterAll(async () => {
      await browser?.close();
    });

    for (const viewport of VIEWPORTS) {
      // Named for what this fixture renders, not for the component: the
      // approval-queue trigger is a control NotificationContainer renders and
      // this file never measures (see the docblock). Claiming "every control"
      // in the name is the same defect one layer up from the one this file
      // exists to catch — a control outside the fixture's reach reads as
      // covered because the enumeration derives from the fixture.
      test(`every interactive control this fixture renders clears the touch-target floor at ${viewport.width}x${viewport.height} coarse`, async () => {
        const page = await browser.newPage({
          viewport,
          hasTouch: true,
          isMobile: true,
        });
        try {
          await page.setContent(buildFixtureHtml());
          const controls = page
            .locator('.notification-container')
            .locator('button, a');
          const count = await controls.count();
          const classNames: string[] = [];
          for (let i = 0; i < count; i += 1) {
            classNames.push(
              (await controls.nth(i).getAttribute('class')) ?? '',
            );
          }
          // Exact, ORDERED membership — see BannerHost.touch-target.test.tsx
          // for why a bare count cannot substitute for this, and why it
          // matters even more here: this exact list is what caught
          // `.toast-card__link` being silently absent from every prior
          // version of this fixture. DOM order here is fixed by
          // NotificationContainer.tsx's render: dismiss-all first, then the
          // toast stack front-to-back; within one card, `.toast-card__link`
          // (inside the header's content div, when conversationTitle +
          // onNavigate are set) before that card's own dismiss button,
          // before its (optional) action row.
          expect(
            classNames,
            `expected exactly these controls under .notification-container, ` +
              `in DOM order, but found ${JSON.stringify(classNames)} — ` +
              `NotificationContainer.tsx's render changed. Update this list ` +
              `and audit whichever control differs.`,
          ).toEqual([
            'notification-container__dismiss-all',
            'toast-card__dismiss',
            'toast-card__action toast-card__action--secondary',
            'toast-card__link',
            'toast-card__dismiss',
            'toast-card__dismiss',
          ]);

          const failures: string[] = [];
          for (let i = 0; i < count; i += 1) {
            const control = controls.nth(i);
            const className = classNames[i] ?? '';
            const accessibleName =
              (await control.getAttribute('aria-label')) ??
              (await control.textContent())?.trim() ??
              '';
            const label = `<${await control.evaluate((el) => el.tagName.toLowerCase())} class="${className}"> "${accessibleName}"`;

            const box = await control.boundingBox();
            if (box === null) {
              failures.push(
                `${label}: not visible (boundingBox() returned null)`,
              );
              continue;
            }
            if (box.height < MIN_TOUCH_TARGET_PX) {
              failures.push(
                `${label}: height ${box.height}px < ${MIN_TOUCH_TARGET_PX}px floor`,
              );
            }
            if (box.width < MIN_TOUCH_TARGET_PX) {
              failures.push(
                `${label}: width ${box.width}px < ${MIN_TOUCH_TARGET_PX}px floor`,
              );
            }
          }

          expect(
            failures,
            `touch-target floor violation(s) at ${viewport.width}x${viewport.height}:\n${failures.join('\n')}`,
          ).toEqual([]);
        } finally {
          await page.close();
        }
      });
    }
  },
);

test.skipIf(chromiumAvailable)(
  'NotificationContainer mobile touch targets — Chromium not installed, cannot verify (station#3513)',
  () => {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so the ' +
        'NotificationContainer touch-target floor (station#3513) could not ' +
        'be checked — this is a missing precondition, not a passing check. ' +
        'Install it with `npm run install:playwright` and re-run.',
    );
  },
);

// Runs (and immediately self-skips, named) ONLY on a WSL host with Chromium
// installed — the one configuration where the real cases above were
// quarantined — so the runner's reporter shows WHY this file went quiet
// instead of a silent deselection. Everywhere else this sentinel is itself
// skipped at collection.
test.runIf(chromiumAvailable && wslQuarantinedHost)(
  'NotificationContainer mobile touch targets — quarantined on the WSL2 host class (station#4177)',
  (ctx) => {
    ctx.skip(WSL_QUARANTINE_REASON);
  },
);
