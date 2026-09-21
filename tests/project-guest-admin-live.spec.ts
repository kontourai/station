import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createProject } from '@kontourai/station-sdk/client';
import {
  changeProjectAccess,
  getProjectAccess,
} from '@kontourai/station-sdk/project-access-client';
import { expect } from '@playwright/test';
import { localLabEnvironment } from '../scripts/lib/local-collaboration-process.mjs';
import { readE2EOperatorCredential } from './helpers/e2e-operator-credential';
import { test } from './helpers/fixture-audit';
import {
  allocateLiveStation,
  startStation,
  stationRootForLiveHome,
  stopStation,
} from './helpers/live-station-task';
import { pairBrowser } from './live/helpers/station-instance.mjs';

test.describe
  .serial('invited-admin People and access journey (#488)', () => {
    test.setTimeout(240_000);
    let live: Awaited<ReturnType<typeof allocateLiveStation>>;
    let operatorCredential = '';

    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture destructuring before testInfo
    test.beforeAll(async ({}, testInfo) => {
      testInfo.setTimeout(180_000);
      live = await allocateLiveStation(
        'station-guest-admin-',
        'guest-admin-proof',
      );
      await startStation(live, true, {
        logFile: testInfo.outputPath(`${live.instance}.log`),
        environment: {
          ...localLabEnvironment(),
          STATION_LOCAL_ACCOUNTS: '1',
          STATION_PROJECT_SHARING: '1',
          STATION_AUTHENTICATION_ORIGIN: live.ui,
          ALLOWED_ORIGINS: live.ui,
          STATION_LOG_LEVEL: 'error',
          OTEL_SDK_DISABLED: 'true',
          AWS_EC2_METADATA_DISABLED: 'true',
        },
      });
      operatorCredential = readE2EOperatorCredential(live.home);
    });

    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture destructuring before testInfo
    test.afterAll(async ({}, testInfo) => {
      testInfo.setTimeout(120_000);
      let stopError: unknown;
      try {
        if (live) await stopStation(live);
      } catch (error) {
        stopError = error;
      }
      if (
        live?.home &&
        !stopError &&
        testInfo.status === testInfo.expectedStatus
      )
        rmSync(stationRootForLiveHome(live.home), {
          recursive: true,
          force: true,
        });
      if (stopError)
        throw new Error(
          `Failed to stop isolated admin Station ${live.instance}; diagnostic home preserved`,
          { cause: stopError },
        );
    });

    test('admin guest manages invitations, survives rescope, and self-demotion is honest', async ({
      browser,
      page: operator,
    }, testInfo) => {
      await pairBrowser(operator, {
        root: process.cwd(),
        instance: live.instance,
        serverPort: live.serverPort,
        uiOrigin: live.ui,
      });
      const operatorOptions = {
        origin: live.api,
        credential: operatorCredential,
        credentialOrigin: live.api,
        authentication: 'required' as const,
        timeoutMs: 15_000,
      };
      const shared = await createProject(
        live.api,
        { name: 'Admin acceptance', slug: 'admin-acceptance' },
        operatorOptions,
      );
      const operatorHeaders = {
        Authorization: `Bearer ${operatorCredential}`,
        'Content-Type': 'application/json',
        Origin: live.ui,
      };
      const enabled = await changeProjectAccess(
        live.api,
        shared.slug,
        { kind: 'enable', localProjectId: shared.id },
        operatorOptions,
      );
      expect(enabled.kind).toBe('enabled');
      if (enabled.kind !== 'enabled')
        throw new Error('Sharing was not enabled');
      const invitation = await changeProjectAccess(
        live.api,
        shared.slug,
        {
          kind: 'invite',
          scope: enabled.view.scope,
          email: null,
          role: 'admin',
          expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        },
        operatorOptions,
      );
      expect(invitation.kind).toBe('invited');
      if (invitation.kind !== 'invited')
        throw new Error('Admin invitation was not created');

      const guestContext = await browser.newContext({ colorScheme: 'dark' });
      const guest = await guestContext.newPage();
      const guestAuthorization: string[] = [];
      guest.on('request', (request) => {
        const value = request.headers().authorization;
        if (value) guestAuthorization.push(value);
      });
      try {
        await guest.goto(
          `${live.ui}/account/join#invitation=${encodeURIComponent(invitation.token)}`,
        );
        await guest.getByRole('button', { name: 'Create an account' }).click();
        await guest.getByLabel('Username').fill('guest.admin');
        await guest.getByLabel('Password').fill('Guest-admin-Aa1!234567');
        await guest.getByRole('button', { name: 'Create account' }).click();
        await guest.getByLabel('Password').fill('Guest-admin-Aa1!234567');
        await guest.getByRole('button', { name: 'Sign in' }).click();
        await guest.getByRole('button', { name: 'Accept invitation' }).click();
        await guest
          .getByRole('button', { name: 'Request access for this browser' })
          .click();
        await guest.getByRole('button', { name: 'Request access' }).click();

        const deadline = Date.now() + 15_000;
        let requestId = '';
        while (!requestId && Date.now() < deadline) {
          const pending = await fetch(`${live.api}/api/pairing/requests`, {
            headers: { Authorization: `Bearer ${operatorCredential}` },
          });
          expect(pending.status).toBe(200);
          const body = (await pending.json()) as {
            requests?: Array<{
              requestId: string;
              requireAccountBinding?: true;
              accountCandidate?: unknown;
            }>;
          };
          const candidate = body.requests?.find(
            (value) => value.requireAccountBinding && value.accountCandidate,
          );
          requestId = candidate?.requestId ?? '';
          if (!requestId)
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(requestId).not.toBe('');
        const confirmation = await fetch(
          `${live.api}/api/pairing/requests/${encodeURIComponent(requestId)}/confirm`,
          {
            method: 'POST',
            headers: operatorHeaders,
            body: JSON.stringify({ bindAccountIdentity: true }),
          },
        );
        expect(confirmation.status).toBe(200);

        await expect(
          guest.getByRole('heading', { name: 'Available Projects' }),
        ).toBeVisible({ timeout: 15_000 });

        const listDevices = async () => {
          const response = await fetch(`${live.api}/api/pairing/devices`, {
            headers: { Authorization: `Bearer ${operatorCredential}` },
          });
          expect(response.status).toBe(200);
          return (await response.json()).devices as Array<{
            id: string;
            scope: string;
            revokedAt: number | null;
            principalBinding?: { kind?: string };
          }>;
        };
        const accountBoundDevices = (await listDevices()).filter(
          (device) =>
            device.revokedAt === null &&
            device.principalBinding?.kind === 'account',
        );
        expect(accountBoundDevices).toHaveLength(1);
        const admittedDeviceId = accountBoundDevices[0].id;

        const evidenceDir = process.env.STATION_GUEST_ACCEPTANCE_EVIDENCE_DIR;
        const retainCapture = (name: string) => {
          if (!evidenceDir) return;
          mkdirSync(evidenceDir, { recursive: true });
          cpSync(testInfo.outputPath(name), join(evidenceDir, name));
        };
        const capture = async (name: string) => {
          await guest.screenshot({
            path: testInfo.outputPath(name),
            fullPage: true,
          });
          retainCapture(name);
        };
        const readLayout = () =>
          guest.evaluate(() => {
            const surface = document.querySelector('.account-entry');
            const targets = [
              ...document.querySelectorAll('.account-entry button'),
            ].filter((element) => {
              const box = element.getBoundingClientRect();
              return box.width > 0 && box.height > 0;
            });
            const wide = [...document.querySelectorAll('body *')]
              .filter((element) => {
                const box = element.getBoundingClientRect();
                return box.right > window.innerWidth + 1 && box.width > 0;
              })
              .slice(0, 8)
              .map(
                (element) =>
                  `${element.tagName.toLowerCase()}.${(
                    element as HTMLElement
                  ).className
                    .toString()
                    .split(' ')
                    .slice(0, 3)
                    .join('.')}`,
              );
            return {
              horizontalOverflow:
                document.documentElement.scrollWidth > window.innerWidth + 1,
              wide,
              palette: surface
                ? getComputedStyle(surface).backgroundColor
                : undefined,
              smallestTarget: targets.length
                ? Math.min(
                    ...targets.map((element) => {
                      const box = element.getBoundingClientRect();
                      return Math.min(box.width, box.height);
                    }),
                  )
                : null,
            };
          });

        await guest
          .getByRole('button', { name: 'Read Project details' })
          .click();
        await expect(
          guest.getByRole('heading', { name: 'People and access' }),
        ).toBeVisible({ timeout: 15_000 });
        await expect(guest.getByText('can submit changes')).toBeVisible();
        // The operator-only bootstrap must never render for a guest,
        // even on an error surface: the guest counterpart has no such action.
        await expect(
          guest.getByRole('button', { name: 'Enable Project sharing' }),
        ).toHaveCount(0);

        const darkLayout = await readLayout();
        expect(
          darkLayout.horizontalOverflow,
          `dark capture must not overflow horizontally: ${darkLayout.wide.join(', ')}`,
        ).toBe(false);
        expect(darkLayout.palette).toBeTruthy();
        await capture('guest-admin-wide-dark.png');

        // The guest creates a manual single-use link (no mail service) and
        // cancels it again: the full write path through the guest UI.
        await guest.getByRole('button', { name: 'Create invitation' }).click();
        const link = guest.getByRole('textbox', { name: 'Invitation link' });
        await expect(link).toHaveValue(/\/account\/join#invitation=/);
        await expect(
          guest.getByText(/copy the link now, it is shown once/),
        ).toBeVisible();
        // Two rows list before the cancel: the accepted admin invitation
        // plus the pending one just created. Only the pending row offers a
        // cancel; afterwards the cancelled row stays listed as revoked,
        // like on the operator surface — history, not a live link.
        await expect(
          guest.getByText('Single-use invitation link'),
        ).toHaveCount(2);
        await guest.getByRole('button', { name: 'Cancel invitation' }).click();
        await expect(
          guest.getByRole('button', { name: 'Cancel invitation' }),
        ).toHaveCount(0);
        await expect(guest.getByText(/· revoked ·/)).toBeVisible();

        // Narrow light capture with the touch-target floor asserted.
        await guest.setViewportSize({ width: 390, height: 844 });
        await guest.evaluate(() => {
          localStorage.setItem(
            'station-device-settings-v1',
            JSON.stringify({ version: 2, values: { theme: 'light' } }),
          );
        });
        await guest.reload();
        await expect(
          guest.getByRole('heading', { name: 'Available Projects' }),
        ).toBeVisible({ timeout: 15_000 });
        await guest
          .getByRole('button', { name: 'Read Project details' })
          .click();
        await expect(
          guest.getByRole('heading', { name: 'People and access' }),
        ).toBeVisible({ timeout: 15_000 });
        const lightTheme = await guest.evaluate(() =>
          document.documentElement.getAttribute('data-theme'),
        );
        expect(lightTheme).toBe('light');
        const lightLayout = await readLayout();
        expect(lightLayout.palette).toBeTruthy();
        expect(lightLayout.palette).not.toBe(darkLayout.palette);
        expect(
          lightLayout.horizontalOverflow,
          'light capture must not overflow horizontally',
        ).toBe(false);
        expect(lightLayout.smallestTarget).toBeGreaterThanOrEqual(44);
        await capture('guest-admin-narrow-light.png');

        // Operator narrows the SAME browser to read-only: inspection stays,
        // editing explains itself instead of failing silently.
        const narrowed = await fetch(
          `${live.api}/api/pairing/devices/${admittedDeviceId}/scope`,
          {
            method: 'POST',
            headers: operatorHeaders,
            body: JSON.stringify({ scope: ['orchestration:read'] }),
          },
        );
        expect(narrowed.status).toBe(200);
        await guest
          .getByRole('button', { name: 'Refresh people and access' })
          .click();
        await expect(
          guest.getByText(/approve collaborator management for this browser/),
        ).toBeVisible({ timeout: 15_000 });
        await expect(
          guest.getByRole('button', { name: 'Create invitation' }),
        ).toBeDisabled();

        // Operator restores the explicit read+operate grant: the guest
        // submits again with no re-pairing and no escalation.
        const restored = await fetch(
          `${live.api}/api/pairing/devices/${admittedDeviceId}/scope`,
          {
            method: 'POST',
            headers: operatorHeaders,
            body: JSON.stringify({
              scope: ['orchestration:read', 'orchestration:operate'],
            }),
          },
        );
        expect(restored.status).toBe(200);
        await guest
          .getByRole('button', { name: 'Refresh people and access' })
          .click();
        await expect(guest.getByText('can submit changes')).toBeVisible({
          timeout: 15_000,
        });
        await guest.getByRole('button', { name: 'Create invitation' }).click();
        await expect(
          guest.getByRole('textbox', { name: 'Invitation link' }),
        ).toHaveValue(/\/account\/join#invitation=/, { timeout: 15_000 });

        // Honest ending: the guest demotes itself and the UI says exactly
        // what that means instead of retrying or going blank.
        await guest.getByLabel(/Role for /).selectOption('contributor');
        await expect(
          guest.getByText(/You changed your own Project role/),
        ).toBeVisible({ timeout: 15_000 });
        await expect(
          guest.getByText(/limited to Project admins/),
        ).toBeVisible();

        // The guest browser never carried operator authority: no
        // Authorization header left the page, and no operator credential
        // reached its storage.
        expect(guestAuthorization).toEqual([]);
        const storage = await guest.evaluate(() => ({
          local: JSON.stringify(localStorage),
          session: JSON.stringify(sessionStorage),
        }));
        expect(JSON.stringify(storage)).not.toContain(operatorCredential);

        // Membership administration still answers for the operator after
        // the guest's demotion: the project inventory is unchanged apart
        // from the guest's own role.
        const access = await getProjectAccess(
          live.api,
          shared.slug,
          operatorOptions,
        );
        const session = await guest.evaluate(async () => {
          const response = await fetch('/api/account-auth/session');
          return (await response.json()).data;
        });
        const member = access.members.find(
          (entry) => entry.principal.id === session.principal.id,
        );
        expect(member?.role).toBe('contributor');
      } finally {
        await guestContext.close();
      }
    });
  });
