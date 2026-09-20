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
  .serial('real guest shared Task acceptance (#488/#497)', () => {
    test.setTimeout(240_000);
    let live: Awaited<ReturnType<typeof allocateLiveStation>>;
    let operatorCredential = '';

    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture destructuring before testInfo
    test.beforeAll(async ({}, testInfo) => {
      testInfo.setTimeout(180_000);
      live = await allocateLiveStation(
        'station-guest-acceptance-',
        'guest-proof',
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
          `Failed to stop isolated guest Station ${live.instance}; diagnostic home preserved`,
          { cause: stopError },
        );
    });

    test('registers, accepts, pairs, reads shared content, then loses revoked scope', async ({
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
        { name: 'Shared acceptance', slug: 'shared-acceptance' },
        operatorOptions,
      );
      const privateProject = await createProject(
        live.api,
        {
          name: 'Private operator material',
          slug: 'private-operator-material',
        },
        operatorOptions,
      );
      const operatorHeaders = {
        Authorization: `Bearer ${operatorCredential}`,
        'Content-Type': 'application/json',
        Origin: live.ui,
      };
      const createTask = async (projectId: string, title: string) => {
        const response = await fetch(`${live.api}/api/tasks`, {
          method: 'POST',
          headers: operatorHeaders,
          body: JSON.stringify({ projectId, title }),
        });
        const envelope = (await response.json()) as {
          success?: boolean;
          error?: string;
          data?: { id: string; createdAt: string };
        };
        expect(
          response.status,
          `Task creation failed: ${envelope.error ?? 'unknown error'}`,
        ).toBe(201);
        return envelope.data as { id: string; createdAt: string };
      };
      const sharedTask = await createTask(
        shared.slug,
        'Guest-visible acceptance Task',
      );
      const privateTask = await createTask(
        privateProject.slug,
        'Private ordinary Task marker',
      );
      const messageMarker = 'Guest-visible real human message';
      const openRoom = await fetch(
        `${live.api}/api/tasks/${encodeURIComponent(sharedTask.id)}/room`,
        { headers: operatorHeaders },
      );
      expect(
        openRoom.status,
        `Room open failed: ${await openRoom.clone().text()}`,
      ).toBe(200);
      await openRoom.text();
      const message = await fetch(
        `${live.api}/api/tasks/${encodeURIComponent(sharedTask.id)}/room/messages`,
        {
          method: 'POST',
          headers: operatorHeaders,
          body: JSON.stringify({
            proposalId: 'guest-acceptance-message',
            text: messageMarker,
          }),
        },
      );
      expect(
        message.status,
        `Message post failed: ${await message.clone().text()}`,
      ).toBe(200);
      await message.text();
      const documentMarker = 'Guest-visible real shared document';
      const planResponse = await fetch(
        `${live.api}/api/tasks/${encodeURIComponent(sharedTask.id)}/room/edit-plan`,
        {
          method: 'POST',
          headers: operatorHeaders,
          body: JSON.stringify({
            intentId: 'guest-acceptance-document',
            desiredText: documentMarker,
            selection: { anchor: 0, focus: 0 },
          }),
        },
      );
      expect(
        planResponse.status,
        `Plan post failed: ${await planResponse.clone().text()}`,
      ).toBe(200);
      const planEnvelope = (await planResponse.json()) as {
        data?: { intentId: string; digest: string };
        intentId?: string;
        digest?: string;
      };
      const plan = planEnvelope.data ?? planEnvelope;
      expect(plan.intentId).toBeTruthy();
      expect(plan.digest).toBeTruthy();
      const batch = await fetch(
        `${live.api}/api/tasks/${encodeURIComponent(sharedTask.id)}/room/batches`,
        {
          method: 'POST',
          headers: operatorHeaders,
          body: JSON.stringify({
            intentId: plan.intentId,
            intentDigest: plan.digest,
          }),
        },
      );
      expect(
        batch.status,
        `Batch post failed: ${await batch.clone().text()}`,
      ).toBe(200);
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
          role: 'viewer',
          expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        },
        operatorOptions,
      );
      expect(invitation.kind).toBe('invited');
      if (invitation.kind !== 'invited')
        throw new Error('Invitation was not created');
      const publishResponse = await fetch(
        `${live.api}/api/projects/${shared.slug}/shared-work/${encodeURIComponent(sharedTask.id)}`,
        { method: 'PUT', headers: operatorHeaders },
      );
      expect(publishResponse.status).toBe(201);
      const publication = (await publishResponse.json()).data as {
        shareId: string;
      };

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
        await guest.getByLabel('Username').fill('guest.viewer');
        await guest.getByLabel('Password').fill('Guest-acceptance-Aa1!234567');
        await guest.getByRole('button', { name: 'Create account' }).click();
        await guest.getByLabel('Password').fill('Guest-acceptance-Aa1!234567');
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

        // Exact admitted Device identity, read from the real operator
        // inventory right after the real approval: the one account-bound,
        // non-revoked Device this approval admitted. Its id is what the
        // post-revocation assertions below must find unchanged.
        const listDevices = async () => {
          const response = await fetch(`${live.api}/api/pairing/devices`, {
            headers: { Authorization: `Bearer ${operatorCredential}` },
          });
          expect(response.status).toBe(200);
          return (await response.json()).devices as Array<{
            id: string;
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

        await expect(
          guest.getByRole('heading', { name: 'Available Projects' }),
        ).toBeVisible({ timeout: 15_000 });

        // Explicit caller-owned evidence retention: when the caller exports
        // STATION_GUEST_ACCEPTANCE_EVIDENCE_DIR, each capture is copied there
        // synchronously right after it is taken, because the canonical runner
        // deletes passing-run Playwright output roots. Without it, captures
        // stay in the runner-owned Playwright output as before.
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
            return {
              horizontalOverflow:
                document.documentElement.scrollWidth > window.innerWidth + 1,
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

        const openSharedTaskContent = async () => {
          await guest
            .getByRole('button', { name: 'Read Project details' })
            .click();
          await guest.getByRole('button', { name: 'Read shared Task' }).click();
          await expect(guest.getByText(messageMarker)).toBeVisible();
          await expect(guest.getByText(documentMarker)).toBeVisible();
        };

        await openSharedTaskContent();
        const darkTheme = await guest.evaluate(() =>
          document.documentElement.getAttribute('data-theme'),
        );
        expect(darkTheme).toBe('dark');
        const darkLayout = await readLayout();
        expect(
          darkLayout.horizontalOverflow,
          'dark capture must not overflow horizontally',
        ).toBe(false);
        expect(darkLayout.smallestTarget).toBeGreaterThanOrEqual(44);
        expect(darkLayout.palette).toBeTruthy();
        await capture('guest-shared-task-wide-dark.png');

        // The app theme is the LOCAL device-settings preference, not the
        // media query: seed the exact persisted envelope the canonical
        // device-settings store writes (station-device-settings-v1, v2,
        // partial values), reload so the boot fast path applies it, and
        // verify the document attribute AND the computed palette before
        // capturing.
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
        await openSharedTaskContent();
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
        await capture('guest-shared-task-narrow-light.png');

        const guestRead = (path: string) =>
          guest.evaluate(async (requestPath) => {
            const response = await fetch(requestPath);
            return { status: response.status, body: await response.text() };
          }, path);
        // Exact refusal protocol, source-pinned: an account-bound device may
        // only reach the public allowlist (403
        // account_bound_device_route_forbidden for everything else — task
        // reads, access management), while a non-member Project read that IS
        // on the allowlist fails membership with an opaque 404. A server
        // error must never count as a denial.
        for (const expected of [
          {
            path: `/api/projects/${privateProject.slug}`,
            status: 404,
            fragment: 'Project not found',
          },
          {
            path: `/api/tasks/${encodeURIComponent(privateTask.id)}`,
            status: 403,
            fragment: 'account_bound_device_route_forbidden',
          },
          {
            path: `/api/projects/${shared.slug}/access`,
            status: 403,
            fragment: 'account_bound_device_route_forbidden',
          },
        ]) {
          const denied = await guestRead(expected.path);
          expect(
            denied.status,
            `${expected.path} refused as ${denied.status}: ${denied.body}`,
          ).toBe(expected.status);
          expect(denied.body).toContain(expected.fragment);
          expect(denied.body).not.toContain('Private ordinary Task marker');
          expect(denied.body).not.toContain('Private operator material');
        }
        expect(guestAuthorization).toEqual([]);
        const storage = await guest.evaluate(() => ({
          local: JSON.stringify(localStorage),
          session: JSON.stringify(sessionStorage),
        }));
        expect(JSON.stringify(storage)).not.toContain(operatorCredential);

        const unshared = await fetch(
          `${live.api}/api/projects/${shared.slug}/shared-work/${encodeURIComponent(sharedTask.id)}`,
          {
            method: 'DELETE',
            headers: operatorHeaders,
            body: JSON.stringify({ shareId: publication.shareId }),
          },
        );
        expect(unshared.status).toBe(200);
        await guest
          .getByRole('button', { name: 'Refresh shared Tasks' })
          .click();
        await expect(guest.getByText(messageMarker)).toHaveCount(0);
        expect(
          (
            await guestRead(
              `/api/projects/${shared.slug}/shared-work/${encodeURIComponent(sharedTask.id)}/history`,
            )
          ).status,
        ).toBe(404);

        const session = await guest.evaluate(async () => {
          const response = await fetch('/api/account-auth/session');
          return (await response.json()).data;
        });
        const access = await getProjectAccess(
          live.api,
          shared.slug,
          operatorOptions,
        );
        const member = access.members.find(
          (entry) => entry.principal.id === session.principal.id,
        );
        expect(member).toBeTruthy();
        await changeProjectAccess(
          live.api,
          shared.slug,
          {
            kind: 'change-member',
            scope: access.scope,
            principalId: member!.principal.id,
            revision: member!.revision,
            role: 'viewer',
            status: 'revoked',
          },
          operatorOptions,
        );
        await guest.getByRole('button', { name: 'Refresh' }).click();
        await expect(
          guest.getByText(
            'Projects are not currently shared with this account.',
          ),
        ).toBeVisible();
        expect((await guestRead('/api/account-auth/session')).status).toBe(200);
        // The SAME admitted Device id must still be present, still active
        // (revokedAt null) and still account-bound after the membership
        // revocation — the account was not substituted and the Device was
        // not revoked with the membership.
        const devicesAfterRevocation = await listDevices();
        const retained = devicesAfterRevocation.filter(
          (device) => device.id === admittedDeviceId,
        );
        expect(
          retained,
          'the admitted Device must survive an independent membership revocation',
        ).toHaveLength(1);
        expect(retained[0].revokedAt).toBeNull();
        expect(retained[0].principalBinding?.kind).toBe('account');
        expect(
          devicesAfterRevocation.filter(
            (device) =>
              device.revokedAt === null &&
              device.principalBinding?.kind === 'account',
          ),
        ).toHaveLength(1);
      } finally {
        await guestContext.close();
      }
    });
  });
