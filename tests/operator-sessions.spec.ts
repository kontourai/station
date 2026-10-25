/** S3 browser evidence: real pairing routes, private registry, consent listener and per-action step-up,
 * HTTP admission and Chromium WebAuthn. The surrounding shell mounts the actual
 * PairedDevicesPanel, keeping this journey independent of provider availability. */
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { BrowserContext } from '@playwright/test';
import { expect } from '@playwright/test';
import { execFileSyncBounded } from '../scripts/lib/bounded-capture.mjs';
import { test } from './helpers/fixture-audit';

const run = promisify(execFile);

test('paired browser signs in and changes access only after consent-origin passkey step-up', async ({
  browser,
}, testInfo) => {
  test.setTimeout(300_000);
  const home = mkdtempSync(join(tmpdir(), 'station-operator-s3-browser-'));
  let fixture: ChildProcess | undefined;
  const contexts: BrowserContext[] = [];

  const retainCapture = (name: string) => {
    const directory = process.env.STATION_UI_REVIEW_SCREENSHOT_DIR;
    if (!directory) return;
    mkdirSync(directory, { recursive: true });
    copyFileSync(testInfo.outputPath(name), join(directory, name));
  };

  try {
    execFileSyncBounded(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        join(home, 'key.pem'),
        '-out',
        join(home, 'cert.pem'),
        '-subj',
        '/CN=localhost',
        '-days',
        '1',
      ],
      { windowsHide: true, stdio: 'pipe' },
    );
    fixture = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        resolve(
          'src-server/__test-utils__/operator-session-browser-fixture.ts',
        ),
        home,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          STATION_HOME: home,
          STATION_INSTANCE: 'operator-s3-browser',
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
      },
    );
    let output = '';
    const retain = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-64 * 1024);
    };
    fixture.stdout!.on('data', retain);
    fixture.stderr!.on('data', retain);
    const ready = await new Promise<{
      appOrigin: string;
      consentOrigin: string;
      cliOrigin: string;
    }>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error(`Operator session fixture timed out: ${output}`)),
        60_000,
      );
      fixture!.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      fixture!.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Operator session fixture exited ${code}: ${output}`));
      });
      fixture!.once('message', (message) => {
        clearTimeout(timer);
        resolve(
          message as {
            appOrigin: string;
            consentOrigin: string;
            cliOrigin: string;
          },
        );
      });
    });
    const { appOrigin, consentOrigin, cliOrigin } = ready;
    const operator = JSON.parse(
      readFileSync(join(home, 'security/environment.json'), 'utf8'),
    ) as { credential: string };
    async function host(method: string, path: string, body?: unknown) {
      const response = await fetch(`${cliOrigin}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${operator.credential}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      expect(response.ok, `${method} ${path}`).toBe(true);
      return response.json();
    }
    async function pair(name: string) {
      const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width: 390, height: 844 },
      });
      contexts.push(context);
      const offer = await host('POST', '/api/pairing/offers', {
        endpoint: appOrigin,
        scope: 'orchestration:read',
      });
      const requested = await context.request.post(
        `${appOrigin}/.well-known/station/v1/pairing/request`,
        {
          headers: { Origin: appOrigin },
          data: {
            offerId: offer.offerId,
            proof: offer.challenge,
            deviceName: name,
          },
        },
      );
      expect(requested.status()).toBe(202);
      const pending = await requested.json();
      await host(
        'POST',
        `/api/pairing/requests/${pending.requestId}/confirm`,
        {},
      );
      const exchanged = await context.request.post(
        `${appOrigin}/.well-known/station/v1/pairing/exchange`,
        {
          headers: { Origin: appOrigin },
          data: {
            offerId: offer.offerId,
            proof: offer.challenge,
            requestId: pending.requestId,
            delivery: 'browser-cookie',
          },
        },
      );
      expect(exchanged.status()).toBe(200);
      const result = await exchanged.json();
      expect(result.credential).toBeUndefined();
      expect(
        (await context.cookies()).some((cookie) =>
          cookie.name.startsWith('__Host-station-device'),
        ),
      ).toBe(true);
      return { context, device: result.device };
    }
    const first = await pair('Operator browser');
    const second = await pair('Second browser');
    const page = await first.context.newPage();
    await page.goto(appOrigin);
    await expect(
      page.getByRole('link', { name: 'Sign in as operator' }),
    ).toBeVisible();
    await expect(page.getByText('Second browser', { exact: true })).toHaveCount(
      0,
    );
    await page.screenshot({
      path: testInfo.outputPath('paired-before-sign-in.png'),
      fullPage: true,
    });
    retainCapture('paired-before-sign-in.png');

    const ceremony = await first.context.newPage();
    const cdp = await first.context.newCDPSession(ceremony);
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
    await ceremony.goto(`${consentOrigin}/operator/passkeys/enroll`);
    const opened = ceremony.waitForResponse(
      (response) =>
        response.url().endsWith('/enroll/requests') &&
        response.request().method() === 'POST',
    );
    await ceremony.getByRole('button', { name: 'Start', exact: true }).click();
    const request = await (await opened).json();
    const approved = await run(
      process.execPath,
      [
        '--import',
        'tsx',
        resolve('scripts/station-cli.ts'),
        'environment',
        'operator',
        'passkeys',
        'approve',
        request.code,
        '--device',
        first.device.id,
        `--api-base=${cliOrigin}`,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          STATION_HOME: home,
          STATION_INSTANCE: 'operator-s3-browser',
        },
        windowsHide: true,
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      },
    );
    expect(approved.stderr).not.toContain('Error:');
    await ceremony
      .getByRole('textbox', { name: 'Name this passkey' })
      .fill('Browser test key');
    await ceremony
      .getByRole('button', { name: 'Create passkey', exact: true })
      .click();
    await expect(
      ceremony.getByText('Passkey saved.', { exact: true }),
    ).toBeVisible();
    await ceremony.goto(`${consentOrigin}/operator/sign-in`);
    await ceremony.screenshot({
      path: testInfo.outputPath('consent-sign-in.png'),
      fullPage: true,
    });
    retainCapture('consent-sign-in.png');
    await ceremony
      .getByRole('button', { name: 'Sign in with passkey' })
      .click();
    await expect(ceremony.getByRole('status')).toContainText('Signed in.');
    await expect(page.getByText('Second browser', { exact: true })).toBeVisible(
      { timeout: 30_000 },
    );
    await expect(
      page.getByRole('button', { name: 'Revoke Second browser', exact: true }),
    ).toBeEnabled();
    await page
      .getByRole('heading', { name: 'Paired devices', exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath('paired-after-sign-in.png'),
      fullPage: true,
    });
    retainCapture('paired-after-sign-in.png');
    async function hostInventory() {
      const result = await run(
        process.execPath,
        [
          '--import',
          'tsx',
          resolve('scripts/station-cli.ts'),
          'environment',
          'access',
          'devices',
          '--json',
          `--api-base=${cliOrigin}`,
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            STATION_HOME: home,
            STATION_INSTANCE: 'operator-s3-browser',
          },
          windowsHide: true,
          timeout: 60_000,
          maxBuffer: 1024 * 1024,
        },
      );
      const inventory = JSON.parse(result.stdout) as {
        devices: { id: string; scopes: string[] }[];
      };
      expect(Array.isArray(inventory.devices)).toBe(true);
      return {
        devices: inventory.devices.map((device) => ({
          id: device.id,
          scope: device.scopes.join(' '),
        })),
      };
    }
    await page
      .getByRole('button', {
        name: 'Change access for Second browser',
        exact: true,
      })
      .click();
    await page.getByRole('checkbox', { name: /Skip approval prompts/ }).check();
    const popup = first.context.waitForEvent('page');
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    const review = await popup;
    await review.waitForURL(`${consentOrigin}/consent/**`);
    const stepCdp = await first.context.newCDPSession(review);
    await stepCdp.send('WebAuthn.enable');
    const { authenticatorId: stepId } = await stepCdp.send(
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
    const keys = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
    for (const credential of keys.credentials)
      await stepCdp.send('WebAuthn.addCredential', {
        authenticatorId: stepId,
        credential,
      });
    await expect(
      review.getByRole('heading', { name: 'Review access change' }),
    ).toBeVisible();
    await expect(
      review.getByText(/Change access for “Second browser”/),
    ).toBeVisible();
    await expect(review.getByText(/Full access allows/)).toBeVisible();
    await review.screenshot({
      path: testInfo.outputPath('consent-step-up-review.png'),
      fullPage: true,
    });
    retainCapture('consent-step-up-review.png');
    const before = await hostInventory();
    expect(
      before.devices.find(
        (device: { id: string }) => device.id === second.device.id,
      )!.scope,
    ).not.toContain('approval:full-access');
    await review.getByRole('button', { name: 'Confirm with passkey' }).click();
    await expect(review.getByRole('status')).toContainText('Applied.');
    await expect(review.getByRole('button')).toHaveCount(0);
    const changed = await hostInventory();
    expect(
      changed.devices.find(
        (device: { id: string }) => device.id === second.device.id,
      )!.scope,
    ).toContain('approval:full-access');
    await expect(
      page.getByRole('link', { name: 'Review access change' }),
    ).toHaveCount(0, { timeout: 30_000 });
    await page.screenshot({
      path: testInfo.outputPath('paired-after-step-up.png'),
      fullPage: true,
    });
    retainCapture('paired-after-step-up.png');

    // Cancel closes the server transaction and the initiating panel without WebAuthn.
    await page
      .getByRole('button', { name: 'Revoke Second browser', exact: true })
      .click();
    const cancelPopup = first.context.waitForEvent('page');
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    const cancelReview = await cancelPopup;
    await cancelReview.waitForURL(`${consentOrigin}/consent/**`);
    await cancelReview
      .getByRole('button', { name: 'Cancel', exact: true })
      .click();
    await expect(cancelReview.getByRole('status')).toContainText(
      'Cancelled. Nothing changed.',
    );
    await expect(page.getByRole('alert')).toContainText(
      'Cancelled. Nothing was applied.',
      { timeout: 30_000 },
    );
    await expect(
      page.getByRole('link', { name: 'Review access change' }),
    ).toHaveCount(0);
    expect(await hostInventory()).toEqual(changed);
    await expect(cancelReview.getByRole('button')).toHaveCount(0);
    await cancelReview.screenshot({
      path: testInfo.outputPath('consent-step-up-cancelled.png'),
      fullPage: true,
    });
    retainCapture('consent-step-up-cancelled.png');

    // The same paired browser cannot make a second change without new UV.
    await page
      .getByRole('button', {
        name: 'Change access for Second browser',
        exact: true,
      })
      .click();
    await page
      .getByRole('checkbox', { name: /Skip approval prompts/ })
      .uncheck();
    const secondPopup = first.context.waitForEvent('page');
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    const refusedReview = await secondPopup;
    await refusedReview.waitForURL(`${consentOrigin}/consent/**`);
    const refusedCdp = await first.context.newCDPSession(refusedReview);
    await refusedCdp.send('WebAuthn.enable');
    const { authenticatorId: refusedId } = await refusedCdp.send(
      'WebAuthn.addVirtualAuthenticator',
      {
        options: {
          protocol: 'ctap2',
          transport: 'internal',
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: false,
          automaticPresenceSimulation: true,
        },
      },
    );
    const updatedKeys = await stepCdp.send('WebAuthn.getCredentials', {
      authenticatorId: stepId,
    });
    for (const credential of updatedKeys.credentials)
      await refusedCdp.send('WebAuthn.addCredential', {
        authenticatorId: refusedId,
        credential,
      });
    await refusedCdp.send('WebAuthn.setUserVerified', {
      authenticatorId: refusedId,
      isUserVerified: false,
    });
    await refusedReview
      .getByRole('button', { name: 'Confirm with passkey' })
      .click();
    await expect(refusedReview.getByRole('status')).toContainText(
      /refused|cancelled|not allowed|timed out/i,
      { timeout: 140_000 },
    );
    await expect(refusedReview.getByRole('button')).toHaveCount(0);
    const unchanged = await hostInventory();
    expect(
      unchanged.devices.find(
        (device: { id: string }) => device.id === second.device.id,
      )!.scope,
    ).toBe(
      changed.devices.find(
        (device: { id: string }) => device.id === second.device.id,
      )!.scope,
    );

    const operatorCookie = (await first.context.cookies()).find(
      (cookie) => cookie.name === '__Host-station-operator',
    );
    expect(operatorCookie).toBeDefined();
    const mutationUrl = `${appOrigin}/api/pairing/devices/${first.device.id}/scope`;
    const mutationInput = {
      headers: { Origin: appOrigin },
      data: {
        scope: ['orchestration:read'],
        expectedScope: first.device.scope,
      },
    };
    const withoutOperatorCookie = await second.context.request.post(
      mutationUrl,
      mutationInput,
    );
    expect(withoutOperatorCookie.status()).toBe(403);
    const noCookieBody = await withoutOperatorCookie.json();
    expect(noCookieBody).toMatchObject({
      error: { code: 'insufficient_scope' },
    });
    await second.context.addCookies([operatorCookie!]);
    const refused = await second.context.request.get(
      `${appOrigin}/api/pairing/devices`,
      { headers: { Origin: appOrigin } },
    );
    expect(refused.status()).toBe(403);
    expect(await refused.json()).toMatchObject({
      error: { code: 'operator_session_required' },
    });
    const refusedMutation = await second.context.request.post(
      mutationUrl,
      mutationInput,
    );
    expect(refusedMutation.status()).toBe(403);
    const copiedCookieBody = await refusedMutation.json();
    expect(copiedCookieBody).toMatchObject({
      error: { code: 'operator_session_required' },
    });
    expect(copiedCookieBody.error.code).not.toBe(noCookieBody.error.code);
    expect(await hostInventory()).toEqual(unchanged);
    const unprivileged = await second.context.newPage();
    await unprivileged.goto(appOrigin);
    await expect(
      unprivileged.getByRole('link', { name: 'Sign in as operator' }),
    ).toBeVisible();
    await expect(
      unprivileged.getByText('Operator browser', { exact: true }),
    ).toHaveCount(0);
    await unprivileged
      .getByRole('heading', { name: 'Paired devices', exact: true })
      .scrollIntoViewIfNeeded();
    await unprivileged.screenshot({
      path: testInfo.outputPath('other-browser-refused.png'),
      fullPage: true,
    });
    retainCapture('other-browser-refused.png');
    await host('DELETE', `/api/pairing/devices/${first.device.id}`);
    await expect(
      page.getByText(
        "This device's access to this Station needs review. Reconnect it, then try again.",
        { exact: true },
      ),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Second browser', { exact: true })).toHaveCount(
      0,
    );
  } finally {
    for (const context of contexts) await context.close();
    if (fixture && fixture.exitCode === null) {
      const exited = new Promise<void>((resolve) =>
        fixture!.once('exit', () => resolve()),
      );
      fixture.kill('SIGTERM');
      await exited;
    }
    rmSync(home, { recursive: true, force: true });
  }
});
