import { rmSync } from 'node:fs';
import { createProject } from '@kontourai/station-sdk/client';
import { changeProjectAccess } from '@kontourai/station-sdk/project-access-client';
import {
  type BrowserContext,
  expect,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { localLabEnvironment } from '../scripts/lib/local-collaboration-process.mjs';
import { readE2EOperatorCredential } from './helpers/e2e-operator-credential';
import { test } from './helpers/fixture-audit';
import {
  allocateLiveStation,
  startStation,
  stationRootForLiveHome,
  stopStation,
} from './helpers/live-station-task';

/**
 * #4303: invited members use passkeys against a real isolated Station, with
 * Chromium's CDP virtual authenticator standing in for a platform
 * authenticator. WebAuthn refuses an IP address as a relying-party ID, so
 * this Station's authentication origin is `localhost` on the UI port.
 */
test.describe
  .serial('member passkeys journey (#4303)', () => {
    test.setTimeout(300_000);
    let live: Awaited<ReturnType<typeof allocateLiveStation>>;
    let origin = '';
    let operatorCredential = '';

    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture destructuring before testInfo
    test.beforeAll(async ({}, testInfo) => {
      testInfo.setTimeout(180_000);
      live = await allocateLiveStation(
        'station-member-passkeys-',
        'member-passkeys-proof',
      );
      origin = `http://localhost:${live.uiPort}`;
      await startStation(live, true, {
        logFile: testInfo.outputPath(`${live.instance}.log`),
        environment: {
          ...localLabEnvironment(),
          STATION_LOCAL_ACCOUNTS: '1',
          STATION_PROJECT_SHARING: '1',
          STATION_AUTHENTICATION_ORIGIN: origin,
          ALLOWED_ORIGINS: `${origin},${live.ui}`,
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
          `Failed to stop isolated passkey Station ${live.instance}; diagnostic home preserved`,
          { cause: stopError },
        );
    });

    async function virtualAuthenticator(page: Page) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('WebAuthn.enable');
      const { authenticatorId } = await cdp.send(
        'WebAuthn.addVirtualAuthenticator',
        {
          options: {
            protocol: 'ctap2',
            transport: 'internal',
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
            automaticPresenceSimulation: true,
          },
        },
      );
      return {
        async credentials() {
          return (
            await cdp.send('WebAuthn.getCredentials', { authenticatorId })
          ).credentials;
        },
        async remove() {
          await cdp.send('WebAuthn.removeVirtualAuthenticator', {
            authenticatorId,
          });
        },
      };
    }

    /** Each width and theme, for the screen currently shown. */
    async function capture(page: Page, testInfo: TestInfo, name: string) {
      // Station's theme is its own device appearance, not the media query;
      // the gallery switches it the same way.
      const original = await page.evaluate(() =>
        document.documentElement.getAttribute('data-theme'),
      );
      for (const scheme of ['light', 'dark'] as const)
        for (const width of [390, 1440]) {
          await page.evaluate(
            (theme) =>
              document.documentElement.setAttribute('data-theme', theme),
            scheme,
          );
          await page.setViewportSize({
            width,
            height: width === 390 ? 844 : 900,
          });
          await page.screenshot({
            path: testInfo.outputPath(`${name}-${width}-${scheme}.png`),
            fullPage: true,
            // The theme switch starts colour transitions; capture settled colours.
            animations: 'disabled',
          });
        }
      await page.evaluate((theme) => {
        if (theme === null)
          document.documentElement.removeAttribute('data-theme');
        else document.documentElement.setAttribute('data-theme', theme);
      }, original);
      await page.setViewportSize({ width: 1280, height: 900 });
    }

    async function operatorAction(
      accountId: string,
      action: 'disable' | 'enable' | 'create-recovery',
    ) {
      const response = await fetch(
        `${live.api}/api/operator/accounts/${encodeURIComponent(accountId)}/actions`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${operatorCredential}`,
            'Content-Type': 'application/json',
            Origin: live.ui,
          },
          body: JSON.stringify({ action }),
        },
      );
      expect(response.status, await response.clone().text()).toBe(200);
      return (await response.json()) as {
        data: { recoveryUrl?: string };
      };
    }

    async function accountIdFor(username: string): Promise<string> {
      const response = await fetch(`${live.api}/api/operator/accounts`, {
        headers: { Authorization: `Bearer ${operatorCredential}` },
      });
      expect(response.status, await response.clone().text()).toBe(200);
      const body = (await response.json()) as {
        data: { accounts: { accountId: string; username?: string }[] };
      };
      const account = body.data.accounts.find(
        (entry) => entry.username === username,
      );
      if (!account) throw new Error(`account ${username} is missing`);
      return account.accountId;
    }

    test('join with a passkey, sign in with it, lose it to a disabled account, and recover a new one', async ({
      browser,
    }, testInfo) => {
      const operatorOptions = {
        origin: live.api,
        credential: operatorCredential,
        credentialOrigin: live.api,
        authentication: 'required' as const,
        timeoutMs: 15_000,
      };
      const shared = await createProject(
        live.api,
        { name: 'Passkey acceptance', slug: 'passkey-acceptance' },
        operatorOptions,
      );
      const enabled = await changeProjectAccess(
        live.api,
        shared.slug,
        { kind: 'enable', localProjectId: shared.id },
        operatorOptions,
      );
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
          expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        },
        operatorOptions,
      );
      if (invitation.kind !== 'invited')
        throw new Error('Invitation was not created');

      const contexts: BrowserContext[] = [];
      try {
        const context = await browser.newContext();
        contexts.push(context);
        const guest = await context.newPage();
        const device = await virtualAuthenticator(guest);
        const passwords: string[] = [];
        guest.on('request', (request) => {
          const body = request.postData() ?? '';
          if (/"password"|"newPassword"/.test(body)) passwords.push(body);
        });

        // Off by default: the sign-in page offers passwords only.
        await guest.goto(`${origin}/account`);
        await expect(
          guest.getByRole('button', { name: 'Sign in' }),
        ).toBeVisible({ timeout: 15_000 });
        await expect(
          guest.getByRole('button', { name: 'Sign in with a passkey' }),
        ).toHaveCount(0);
        const enabledPreview = await fetch(
          `${live.api}/api/feature-previews/member-passkeys`,
          {
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${operatorCredential}`,
              'Content-Type': 'application/json',
              Origin: live.ui,
            },
            body: JSON.stringify({ enabled: true }),
          },
        );
        expect(enabledPreview.status, await enabledPreview.clone().text()).toBe(
          200,
        );

        // Join: a passkey instead of a password.
        await guest.goto(
          `${origin}/account/join#invitation=${encodeURIComponent(invitation.token)}`,
        );
        await guest.getByRole('button', { name: 'Create an account' }).click();
        await guest.getByLabel('Username').fill('passkey.guest');
        await expect(
          guest.getByRole('button', { name: 'Create account with a passkey' }),
        ).toBeVisible();
        await capture(guest, testInfo, 'join-create-account');
        await guest
          .getByRole('button', { name: 'Create account with a passkey' })
          .click();
        await expect(
          guest.getByRole('button', { name: 'Accept invitation' }),
        ).toBeVisible({ timeout: 15_000 });
        expect(await device.credentials()).toHaveLength(1);
        await expect(guest.getByText('Passkey', { exact: true })).toBeVisible();
        await capture(guest, testInfo, 'joined-passkeys-panel');
        await guest.getByRole('button', { name: 'Accept invitation' }).click();
        await expect(
          guest.getByRole('heading', { name: 'You joined the Project' }),
        ).toBeVisible({ timeout: 15_000 });

        // Sign out, then sign in with the passkey alone.
        await guest.getByRole('button', { name: 'Sign out' }).click();
        await expect(
          guest.getByRole('button', { name: 'Sign in with a passkey' }),
        ).toBeVisible({ timeout: 15_000 });
        await capture(guest, testInfo, 'sign-in');
        await guest
          .getByRole('button', { name: 'Sign in with a passkey' })
          .click();
        await expect(guest.getByText('Signed in as')).toBeVisible({
          timeout: 15_000,
        });
        expect(passwords).toEqual([]);

        // Disabled: the live session ends and the passkey no longer signs in.
        const accountId = await accountIdFor('passkey.guest');
        await operatorAction(accountId, 'disable');
        const refused = await guest.request.get(
          `${origin}/api/account-auth/session`,
        );
        expect(refused.status()).toBe(401);
        await guest.goto(`${origin}/account`);
        await guest
          .getByRole('button', { name: 'Sign in with a passkey' })
          .click();
        await expect(
          guest.getByText('This passkey cannot sign in to this Station.'),
        ).toBeVisible({ timeout: 15_000 });
        await expect(guest.getByText('Signed in as')).toHaveCount(0);

        // Re-enabled, the device is lost: an operator recovery link enrols a
        // replacement passkey on a new authenticator.
        await operatorAction(accountId, 'enable');
        const recovery = await operatorAction(accountId, 'create-recovery');
        const recoveryUrl = recovery.data.recoveryUrl!;
        expect(new URL(recoveryUrl).origin).toBe(origin);
        await device.remove();
        const replacementContext = await browser.newContext();
        contexts.push(replacementContext);
        const replacement = await replacementContext.newPage();
        const replacementDevice = await virtualAuthenticator(replacement);
        await replacement.goto(recoveryUrl);
        await expect(
          replacement.getByRole('heading', { name: 'Recover your account' }),
        ).toBeVisible({ timeout: 15_000 });
        await capture(replacement, testInfo, 'recover');
        await replacement
          .getByRole('button', { name: 'Add a passkey instead' })
          .click();
        await expect(
          replacement.getByText('Passkey added. You are signed in.'),
        ).toBeVisible({ timeout: 15_000 });
        expect(await replacementDevice.credentials()).toHaveLength(1);
        // The link is single use.
        await replacement.goto(recoveryUrl);
        await replacement
          .getByRole('button', { name: 'Add a passkey instead' })
          .click();
        await expect(
          replacement.getByText(
            'This recovery link has expired or was used. Ask the operator for a new one.',
          ),
        ).toBeVisible({ timeout: 15_000 });
      } finally {
        for (const context of contexts) await context.close();
      }
    });
  });
