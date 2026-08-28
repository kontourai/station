import type { Page } from '@playwright/test';
import {
  agentRow,
  agentRowAction,
  deleteAgent,
  seedAgent,
  waitForAgentRemoved,
  waitForAgentsRail,
  waitForSeededAgent,
} from './helpers/agents-journey';
import {
  type AuthenticatedE2ERequest,
  expect,
  test,
} from './helpers/authenticated-request';
import {
  type DeviceClass,
  openDeviceClassContext,
} from './helpers/device-class-context';

/**
 * archive#3843 §4 — a paired device is a REMOTE CONTROL for the host, not a
 * second host.
 *
 * Every affordance below executes on the host's machine. The same three
 * surfaces are driven in both device classes, from fixtures that each prove
 * their own class first (`tests/helpers/device-class-context.ts`), so each
 * assertion is a difference the projection caused rather than a string that
 * happens to be on screen:
 *
 *  T1 the SSH creator's trust command — HOST-HANDS. It appends a line to a
 *     known_hosts file on the machine `ssh` runs from, so on a paired device
 *     the affordance becomes the instruction, with the host named, the exact
 *     command, and a Copy control. Never a disabled button, never hidden.
 *  T2 the Agents row's engine setup — REMOTE-SAFE. "Set up" navigates to
 *     Connections, which a paired device can browse, so the row keeps its ONE
 *     verb and only the action's accessible name says whose machine the
 *     engine would be set up on.
 *  T3 the Developer surface's redacted log read — REMOTE-SAFE. D6 redacts it
 *     for a principal that did not prove home possession; the page says where
 *     the full logs are rather than degrading in silence.
 *
 * The host variants are not decoration: they are what makes the paired
 * assertions mean something. A change that named the host unconditionally
 * would pass every paired assertion here and fail every host one.
 */

const BROKEN_SLUG = 'e2e-paired-device-broken';
const BROKEN_NAME = 'E2E Paired Device Broken';
const MISSING_ENGINE_ID = 'e2e-nonexistent-engine';

/**
 * The unknown-host probe result, served to the page.
 *
 * The probe makes a real outbound SSH attempt against whatever host it is
 * given, and an unknown host key only happens for a host this machine has
 * never confirmed — neither is reproducible on a CI runner. What is under
 * test here is the PRESENTATION of a `unknownHost` evidence record, so the
 * record is supplied and everything else on the page — including
 * `/api/system/status`, which is what decides the device class — stays the
 * live server's answer.
 */
const UNKNOWN_HOST_EVIDENCE = {
  evidenceVersion: 1,
  level: 'discovered',
  freshness: 'fresh',
  observedAt: '2026-08-23T00:00:00.000Z',
  reachable: false,
  summary: 'box-b has never been confirmed from this computer.',
  action: 'Record the host key, then test again.',
  unknownHost: {
    fingerprint: 'SHA256:e2ePairedDevicePresentationFingerprintFixture',
    keyType: 'ssh-ed25519',
    knownHostsLine: 'box-b ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE2EFIXTURE',
    trustCommand:
      "echo 'box-b ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE2EFIXTURE' >> ~/.ssh/known_hosts",
  },
} as const;

async function serveUnknownHostProbe(page: Page): Promise<void> {
  await page.route('**/api/environments/ssh/probe', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: UNKNOWN_HOST_EVIDENCE }),
    }),
  );
}

/**
 * Opens the SSH creator and runs one probe.
 *
 * The status query must have ANSWERED before the probe result renders:
 * `devicePresentation` is `undefined` until it does, which `HostAction` reads
 * as "make no claim" and renders as the host branch. Asserting through that
 * window would test a race rather than a class.
 */
async function gotoWithProjectionAnswered(
  page: Page,
  url: string,
): Promise<void> {
  const answered = page.waitForResponse(
    (response) =>
      response.url().includes('/api/system/status') &&
      response.status() === 200,
    { timeout: 30_000 },
  );
  await page.goto(url);
  await answered;
}

async function openSshTrustEvidence(page: Page, baseURL: string) {
  await gotoWithProjectionAnswered(page, `${baseURL}/connections/computers`);
  await page.getByRole('button', { name: 'Add computer' }).click();
  await page
    .getByRole('button', { name: /Run work on another computer over SSH/ })
    .click();
  const dialog = page.getByRole('dialog', {
    name: 'Run work on another computer over SSH',
  });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder('box-b, or 192.168.1.20').fill('box-b');
  await dialog.getByRole('button', { name: 'Test connection' }).click();
  const evidence = dialog.locator('.ssh-computer-creator__host-key');
  await expect(evidence).toBeVisible();
  return evidence;
}

async function seedBrokenAgent(
  request: AuthenticatedE2ERequest,
): Promise<void> {
  await deleteAgent(request, BROKEN_SLUG);
  await waitForAgentRemoved(request, BROKEN_SLUG);
  await seedAgent(request, {
    slug: BROKEN_SLUG,
    name: BROKEN_NAME,
    description: 'Bound to an engine connection that is not configured.',
    execution: { agentConnectionId: MISSING_ENGINE_ID },
  });
  await waitForSeededAgent(request, BROKEN_SLUG);
}

const VIEWPORTS = [
  { label: 'desktop', size: { width: 1280, height: 800 } },
  { label: '390x844', size: { width: 390, height: 844 } },
] as const;

for (const deviceClass of ['host', 'paired'] as const) {
  for (const viewport of VIEWPORTS) {
    test.describe(`#3843 on a ${deviceClass} device at ${viewport.label}`, () => {
      test(`T1/T2/T3 present the host-hands and remote-safe affordances as a ${deviceClass} device should read them`, async ({
        browser,
        baseURL,
        authenticatedRequest,
      }) => {
        // Three surfaces, two of which need a live seed and a rail to settle,
        // driven in one context so the class is established once.
        test.setTimeout(120_000);
        if (!baseURL) throw new Error('Playwright baseURL is required');
        await seedBrokenAgent(authenticatedRequest);
        const opened = await openDeviceClassContext(
          browser,
          baseURL,
          deviceClass satisfies DeviceClass,
          viewport.size,
        );
        const { page, hostName } = opened;
        try {
          await serveUnknownHostProbe(page);

          // ---- T1: host-hands ----
          const evidence = await openSshTrustEvidence(page, baseURL);
          // The fingerprint is the part a remote human CAN act on (read it
          // out to whoever owns that computer), so it is present in BOTH.
          await expect(
            evidence.locator('.ssh-computer-creator__fingerprint'),
          ).toContainText(UNKNOWN_HOST_EVIDENCE.unknownHost.fingerprint);
          const guidance = evidence.locator('.host-action--guidance');
          if (deviceClass === 'paired') {
            await expect(guidance).toBeVisible();
            await expect(guidance).toContainText(`Run this on ${hostName}`);
            await expect(guidance.locator('.host-action__command')).toHaveText(
              UNKNOWN_HOST_EVIDENCE.unknownHost.trustCommand,
            );
            // Guidance, never a withheld or disabled control.
            const copy = guidance.getByRole('button', {
              name: 'Copy command',
            });
            await expect(copy).toBeVisible();
            await expect(copy).toBeEnabled();
          } else {
            await expect(guidance).toHaveCount(0);
            await expect(
              evidence.getByRole('button', { name: 'Copy command' }),
            ).toBeEnabled();
            await expect(evidence).not.toContainText(hostName);
          }
          await page.getByRole('button', { name: 'Cancel' }).first().click();

          // ---- T2: remote-safe, and the ONE-verb contract survives ----
          await gotoWithProjectionAnswered(page, `${baseURL}/agents`);
          await waitForAgentsRail(page);
          await expect(agentRow(page, BROKEN_NAME)).toBeVisible({
            timeout: 20_000,
          });
          const action = agentRowAction(page, BROKEN_NAME);
          await expect(action).toHaveCount(1);
          await expect(action).toHaveText('Set up');
          // `toHaveAttribute`, not a one-shot `getAttribute`: the clause
          // appears when the projection answers, and a single read can land in
          // the window before it does. The navigation above already waited for
          // that answer, so the HOST assertion is not merely passing early.
          await expect(action).toHaveAttribute(
            'aria-label',
            deviceClass === 'paired'
              ? `Set up ${BROKEN_NAME} on ${hostName}`
              : `Set up ${BROKEN_NAME}`,
          );

          // ---- T3: remote-safe, and the redaction is accounted for ----
          await gotoWithProjectionAnswered(page, `${baseURL}/developer/logs`);
          await expect(
            page
              .locator('ul[aria-label="Server logs"]')
              .or(page.getByText('No matching logs available.'))
              .first(),
          ).toBeVisible({ timeout: 30_000 });
          const helper = page.locator('.host-action__helper');
          if (deviceClass === 'paired') {
            await expect(helper).toHaveText(
              `Full logs are available on ${hostName}. This device is shown the redacted read.`,
            );
          } else {
            await expect(helper).toHaveCount(0);
          }
          // The search field never claims a redaction the page did not derive.
          await expect(page.getByPlaceholder('Search logs')).toBeVisible();
          await expect(
            page.getByPlaceholder('Search redacted logs'),
          ).toHaveCount(0);

          // The touched surfaces fit their viewport in both classes.
          const overflow = await page.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            innerWidth: window.innerWidth,
          }));
          expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);
        } finally {
          await opened.context.close();
          await deleteAgent(authenticatedRequest, BROKEN_SLUG);
          await waitForAgentRemoved(authenticatedRequest, BROKEN_SLUG);
        }
      });
    });
  }
}
