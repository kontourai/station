import { rmSync } from 'node:fs';
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
        expect(
          response.status,
          `Task creation failed: ${await response.text()}`,
        ).toBe(201);
        return (await response.json()).data as {
          id: string;
          createdAt: string;
        };
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
      expect(message.status).toBe(200);
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
      expect(planResponse.status).toBe(200);
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
      expect(batch.status).toBe(200);
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

        await expect(
          guest.getByRole('heading', { name: 'Available Projects' }),
        ).toBeVisible({ timeout: 15_000 });
        await guest
          .getByRole('button', { name: 'Read Project details' })
          .click();
        await guest.getByRole('button', { name: 'Read shared Task' }).click();
        await expect(guest.getByText(messageMarker)).toBeVisible();
        await expect(guest.getByText(documentMarker)).toBeVisible();
        await guest.screenshot({
          path: testInfo.outputPath('guest-shared-task-wide-dark.png'),
          fullPage: true,
        });
        await guest.setViewportSize({ width: 390, height: 844 });
        await guest.emulateMedia({ colorScheme: 'light' });
        await guest.screenshot({
          path: testInfo.outputPath('guest-shared-task-narrow-light.png'),
          fullPage: true,
        });

        const guestRead = (path: string) =>
          guest.evaluate(async (requestPath) => {
            const response = await fetch(requestPath);
            return { status: response.status, body: await response.text() };
          }, path);
        for (const path of [
          `/api/projects/${privateProject.slug}`,
          `/api/tasks/${encodeURIComponent(privateTask.id)}`,
          `/api/projects/${shared.slug}/access`,
        ]) {
          const denied = await guestRead(path);
          expect(denied.status).toBeGreaterThanOrEqual(400);
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
        const devices = await fetch(`${live.api}/api/pairing/devices`, {
          headers: { Authorization: `Bearer ${operatorCredential}` },
        });
        expect(devices.status).toBe(200);
        expect(await devices.text()).toContain('account');
      } finally {
        await guestContext.close();
      }
    });
  });
