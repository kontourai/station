import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { networkInterfaces, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getResponder } from '@homebridge/ciao';
import { readE2EOperatorCredential } from '../helpers/e2e-operator-credential.js';
import {
  type DirectWebDriver,
  startTauriShellFixture,
  type TauriShellFixture,
} from './direct-webdriver.js';

interface ProfileStore {
  defaultProfile: string | null;
  profiles: Array<{
    name: string;
    endpoint: string;
    configurationState: string;
    credentialRef?: { kind: string; id: string };
  }>;
}

function profiles(
  fixture: Pick<TauriShellFixture, 'stationRoot'>,
): ProfileStore {
  return JSON.parse(
    readFileSync(join(fixture.stationRoot, 'config', 'profiles.json'), 'utf8'),
  );
}

function remoteTraffic() {
  const path = process.env.STATION_NEARBY_REMOTE_TRAFFIC;
  assert.ok(
    path &&
      /^\/tmp\/station-nearby-host-[A-Za-z0-9]+\/nearby-traffic\.ndjson$/.test(
        path,
      ),
  );
  return execFileSync(
    'ssh',
    ['-o', 'BatchMode=yes', 'brian@bmedia', `cat ${path}`],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
    },
  )
    .split('\n')
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as {
          stage: 'start' | 'finish';
          path: string;
          method: string;
          status: number;
          authenticated: boolean;
          authorizationHash: string | null;
        },
    );
}

async function ipc(driver: DirectWebDriver, command: string, args = {}) {
  const response = await driver.executeAsyncSource<
    {
      value?: { status: string; candidates?: unknown[] };
      error?: string;
    },
    [string, object]
  >(
    `const [command, args, done] = arguments;
     window.__TAURI_INTERNALS__.invoke(command, args).then(
       value => done({value}), error => done({error: String(error)}));`,
    command,
    args,
  );
  assert.equal(response.error, undefined);
  assert.ok(response.value);
  return response.value;
}

async function waitForElement(driver: DirectWebDriver, selector: string) {
  let elementId: string | undefined;
  await driver.waitUntil(
    async () => {
      elementId = await driver.findElement(selector);
      return elementId !== undefined;
    },
    { timeout: 30_000, timeoutMsg: `Missing element: ${selector}` },
  );
  assert.ok(elementId);
  return elementId;
}

async function clickButton(driver: DirectWebDriver, text: string) {
  let elementId: string | undefined;
  await driver.waitUntil(
    async () => {
      const selector = await driver.execute<string | null, [string]>(
        (label) => {
          const button = Array.from(document.querySelectorAll('button')).find(
            (button) =>
              button.textContent?.trim() === label ||
              button
                .querySelector('.add-machine-modal__option-title')
                ?.textContent?.trim() === label,
          );
          if (!button) return null;
          const parts: string[] = [];
          let element: Element | null = button;
          while (element?.parentElement) {
            const position =
              Array.from(element.parentElement.children).indexOf(element) + 1;
            parts.unshift(
              `${element.tagName.toLowerCase()}:nth-child(${position})`,
            );
            element = element.parentElement;
          }
          return `html > ${parts.join(' > ')}`;
        },
        text,
      );
      elementId = selector ? await driver.findElement(selector) : undefined;
      return elementId !== undefined;
    },
    { timeout: 30_000, timeoutMsg: `Missing button: ${text}` },
  );
  assert.ok(elementId);
  await driver.clickElement(elementId);
}

function custodyAccount(reference: string) {
  const prefix = 'credential-custody:v2';
  const parts = [Buffer.from(`${prefix}\0`)];
  for (const value of ['io.kontourai.station.webdriver', 'dev', reference]) {
    const bytes = Buffer.from(value);
    const length = Buffer.alloc(8);
    length.writeBigUInt64LE(BigInt(bytes.length));
    parts.push(length, bytes);
  }
  return `${prefix}:${createHash('sha256').update(Buffer.concat(parts)).digest('base64url')}`;
}

async function assertStoredCredential(
  profile: ProfileStore['profiles'][number],
  beforeCredentials: string,
) {
  assert.ok(profile.credentialRef);
  const reference = `${profile.credentialRef.kind}:${profile.credentialRef.id}`;
  const target = `profile:${reference}.io.kontourai.station`;
  assert.ok(
    !beforeCredentials.includes(target),
    'Read only fixture-owned credentials',
  );
  const listing = execFileSync('cmdkey', ['/list'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.ok(
    listing.includes(target),
    'The native bearer must exist in Windows Credential Manager',
  );
  assert.ok(
    listing.includes(
      `${custodyAccount(reference)}.io.kontourai.station.credential-metadata`,
    ),
    'Native custody metadata must exist in Windows Credential Manager',
  );
  const { AsyncEntry } = await import('@napi-rs/keyring');
  const credential = await new AsyncEntry(
    'io.kontourai.station',
    `profile:${reference}`,
  ).getPassword();
  assert.ok(
    credential,
    'The exact fixture-owned native bearer must be readable',
  );
  return createHash('sha256').update(`Bearer ${credential}`).digest('hex');
}

async function removeOwnedCredentials(
  stationRoot: string,
  beforeCredentials: string,
) {
  const errors: unknown[] = [];
  for (const profile of profiles({ stationRoot }).profiles) {
    if (!profile.credentialRef) continue;
    const reference = `${profile.credentialRef.kind}:${profile.credentialRef.id}`;
    for (const target of [
      `profile:${reference}.io.kontourai.station`,
      `${custodyAccount(reference)}.io.kontourai.station.credential-metadata`,
    ]) {
      try {
        assert.ok(
          !beforeCredentials.includes(target),
          'Never remove a preexisting credential',
        );
        const listing = execFileSync('cmdkey', ['/list'], {
          encoding: 'utf8',
          windowsHide: true,
        });
        if (listing.includes(target))
          execFileSync('cmdkey', [`/delete:${target}`], { windowsHide: true });
        const after = execFileSync('cmdkey', ['/list'], {
          encoding: 'utf8',
          windowsHide: true,
        });
        assert.ok(
          !after.includes(target),
          'An owned native credential remained',
        );
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length)
    throw new AggregateError(errors, 'Owned native credential cleanup failed');
}

async function main() {
  assert.equal(process.platform, 'win32', 'This is a real Windows shell lane');
  const address = process.env.STATION_NEARBY_INTERFACE;
  const remoteOrigin = process.env.STATION_NEARBY_REMOTE_ORIGIN;
  const remoteProject = process.env.STATION_NEARBY_REMOTE_PROJECT;
  assert.ok(address && remoteOrigin && remoteProject);
  assert.equal(new URL(remoteOrigin).protocol, 'https:');
  assert.equal(new URL(remoteOrigin).origin, remoteOrigin);
  assert.ok(
    Object.values(networkInterfaces())
      .flat()
      .some(
        (entry) =>
          entry?.address === address &&
          entry.family === 'IPv4' &&
          !entry.internal,
      ),
    'The advertisement must use a real owned Windows interface',
  );
  const output = resolve('.kontourai/nearby-discovery-e2e');
  mkdirSync(output, { recursive: true });
  const beforeCredentials = execFileSync('cmdkey', ['/list'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const candidateName = `Nearby proof ${randomUUID().slice(0, 8)}`;
  const hintRequests: string[] = [];
  const hintServer = createServer((request, response) => {
    hintRequests.push(
      `${request.method} ${request.url} auth=${Boolean(request.headers.authorization)}`,
    );
    response.writeHead(404).end();
  });
  const responder = getResponder({ interface: address });
  const webviewRoot = mkdtempSync(join(tmpdir(), 'station-nearby-webview-'));
  let service: ReturnType<typeof responder.createService> | undefined;
  let fixture: TauriShellFixture | undefined;
  let shellLaunched = false;
  let processGroupSettled = false;
  try {
    await new Promise<void>((resolve, reject) => {
      hintServer.once('error', reject);
      hintServer.listen(0, address, resolve);
    });
    const listener = hintServer.address();
    assert.ok(listener && typeof listener === 'object');
    service = responder.createService({
      name: candidateName,
      type: 'station',
      port: listener.port,
      restrictedAddresses: [address],
      disabledIpv6: true,
      txt: { v: '1', transport: 'http', appOrigin: remoteOrigin },
    });
    await service.advertise();
    fixture = await startTauriShellFixture({
      onProcessStarted: () => {
        shellLaunched = true;
      },
      onProcessGroupSettled: async (stationRoot) => {
        processGroupSettled = true;
        await removeOwnedCredentials(stationRoot, beforeCredentials);
      },
      seedRemoteProfile: false,
      realCredentialStore: true,
      env: { WEBVIEW2_USER_DATA_FOLDER: webviewRoot },
    });
    const shell = fixture;
    const driver = fixture.driver;
    const bootstrapStarted = performance.now();
    let sidecarReady = false;
    let navigated = false;
    await driver.waitUntil(
      async () => {
        if (!sidecarReady) {
          const status = await driver.executeAsyncSource<
            { value?: { phase: string }; error?: string },
            []
          >(
            `const done = arguments[0];
             window.__TAURI_INTERNALS__.invoke('bundled_server_status').then(
               value => done({value}), error => done({error: String(error)}));`,
          );
          assert.equal(status.error, undefined);
          if (status.value?.phase !== 'running') return false;
          console.log(
            `NEARBY_NATIVE_SIDECAR_READY ${JSON.stringify({ elapsedMs: performance.now() - bootstrapStarted })}`,
          );
          sidecarReady = true;
        }
        const store = profiles(shell);
        const configured = store.profiles.some(
          (profile) =>
            profile.name === 'local' &&
            profile.configurationState === 'configured' &&
            profile.credentialRef,
        );
        if (!configured) return false;
        if (!navigated) {
          console.log(
            `NEARBY_NATIVE_LOCAL_CONFIGURED ${JSON.stringify({ elapsedMs: performance.now() - bootstrapStarted })}`,
          );
          await driver.navigateApp('/connections/computers');
          navigated = true;
        }
        return (
          await driver.execute(() => document.body?.textContent ?? '')
        ).includes('Add computer');
      },
      {
        timeout: 90_000,
        timeoutMsg:
          'The Windows shell did not initialize its authorized local profile',
      },
    );
    assert.ok(
      performance.now() - bootstrapStarted < 90_000,
      'Native local-profile initialization exceeded its bootstrap budget',
    );
    await clickButton(driver, 'Add computer');
    await clickButton(driver, 'Connect a Station');
    const original = profiles(fixture);
    const originalLocal = original.profiles.find(
      (profile) => profile.name === 'local',
    );
    assert.ok(originalLocal);
    const originalCredentialHash = await assertStoredCredential(
      originalLocal,
      beforeCredentials,
    );
    const originalSelection = await driver.execute(() =>
      document
        .querySelector('button[aria-label^="Choose Station"]')
        ?.getAttribute('aria-label'),
    );
    assert.ok(originalSelection);
    assert.equal(
      (await ipc(driver, 'plugin:station-discovery|prepare')).status,
      'unavailable',
    );
    assert.deepEqual(
      await ipc(driver, 'plugin:station-discovery|discover', {
        scanId: randomUUID(),
      }),
      { status: 'unavailable', candidates: [] },
      'Direct IPC must not bypass the default-off preview',
    );
    const local = original.profiles.find((profile) => profile.name === 'local');
    assert.ok(local);
    const preview = await fetch(
      `${local.endpoint}/api/feature-previews/desktop-nearby`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${readE2EOperatorCredential(fixture.stationHome)}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ enabled: true }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    assert.equal(preview.status, 200, await preview.text());
    assert.equal(
      (await ipc(driver, 'plugin:station-discovery|prepare')).status,
      'ready',
    );
    await clickButton(driver, 'Nearby Stations');
    await driver.waitUntil(
      async () =>
        Boolean(
          await driver.findElement(
            `button[aria-label="Request access to ${candidateName}"]`,
          ),
        ),
      {
        timeout: 20_000,
        timeoutMsg:
          'The real DNS-SD advertisement did not reach the shared panel',
      },
    );
    const details = await driver.findElement(
      `summary[aria-label="Connection details for ${candidateName}"]`,
    );
    assert.ok(details);
    await driver.clickElement(details);
    assert.ok(
      (await driver.execute(() => document.body.textContent ?? '')).includes(
        remoteOrigin,
      ),
    );
    const discovered = profiles(fixture);
    assert.deepEqual(
      discovered,
      original,
      'Discovery must not mutate any saved profile or credential reference',
    );
    assert.deepEqual(
      remoteTraffic(),
      [],
      'Discovery must not cause application requests at the advertised HTTPS destination',
    );
    assert.equal(
      await driver.execute(() =>
        document
          .querySelector('button[aria-label^="Choose Station"]')
          ?.getAttribute('aria-label'),
      ),
      originalSelection,
    );
    assert.deepEqual(
      hintRequests,
      [],
      'Browsing must not contact or authenticate the advertised LAN endpoint',
    );
    writeFileSync(
      join(output, 'nearby-https-candidate.png'),
      await driver.screenshot(),
    );
    console.log(
      `NEARBY_NATIVE_DISCOVERED ${JSON.stringify({ candidateName, address, remoteOrigin, selectedUnchanged: true })}`,
    );
    const requestAccess = await driver.findElement(
      `button[aria-label="Request access to ${candidateName}"]`,
    );
    assert.ok(requestAccess);
    await driver.clickElement(requestAccess);
    await clickButton(driver, 'Request selected access');
    await clickButton(driver, 'Request access');
    await driver.waitUntil(
      async () =>
        (await driver.execute(() => document.body.textContent ?? '')).includes(
          'Waiting for approval on',
        ),
      {
        timeout: 30_000,
        timeoutMsg:
          'The real remote Station did not accept an explicit pending access request',
      },
    );
    assert.ok(
      remoteTraffic().every((entry) => !entry.authenticated),
      'No credential may reach the hinted origin before host approval',
    );
    console.log(
      'NEARBY_NATIVE_APPROVAL_REQUIRED approve the one request on the owned remote host',
    );
    await driver.waitUntil(
      async () =>
        profiles(shell).profiles.some(
          (profile) =>
            profile.endpoint === remoteOrigin &&
            profile.configurationState === 'configured' &&
            profile.credentialRef,
        ),
      {
        timeout: 90_000,
        timeoutMsg:
          'Explicit remote host approval and native pairing did not complete',
      },
    );
    const paired = profiles(fixture).profiles.find(
      (profile) => profile.endpoint === remoteOrigin,
    );
    assert.ok(paired?.credentialRef);
    const pairedCredentialHash = await assertStoredCredential(
      paired,
      beforeCredentials,
    );
    assert.deepEqual(
      profiles(fixture).profiles.find(
        (profile) => profile.name === originalLocal.name,
      ),
      originalLocal,
      'Remote pairing must preserve the original controller profile',
    );
    assert.ok(
      original.profiles.every(
        (profile) =>
          JSON.stringify(profile.credentialRef) !==
          JSON.stringify(paired.credentialRef),
      ),
      'Pairing must create a distinct remote credential reference',
    );
    const closeSetup = await driver.findElement(
      'button[aria-label="Close Station setup"]',
    );
    assert.ok(closeSetup);
    await driver.clickElement(closeSetup);
    assert.equal(
      await driver.execute(() =>
        document
          .querySelector('button[aria-label^="Choose Station"]')
          ?.getAttribute('aria-label'),
      ),
      originalSelection,
      'Saving explicit access must not switch the controller',
    );
    const chooseStation = await driver.findElement(
      'button[aria-label^="Choose Station"]',
    );
    assert.ok(chooseStation);
    await driver.clickElement(chooseStation);
    const manageStations = await waitForElement(
      driver,
      'button[aria-label="Manage Stations"]',
    );
    await driver.clickElement(manageStations);
    const savedDetails = await waitForElement(
      driver,
      `button[aria-label="View details for ${paired.name}"]`,
    );
    await driver.clickElement(savedDetails);
    const select = await waitForElement(
      driver,
      `button[aria-label="Switch to ${paired.name}"]`,
    );
    await driver.clickElement(select);
    const workspace = await waitForElement(
      driver,
      `button[title="Open ${remoteProject} workspace"]`,
    );
    await driver.clickElement(workspace);
    await driver.waitUntil(
      async () =>
        driver.execute((project) => {
          const text = document.body.textContent ?? '';
          const heading = document.querySelector(
            '.project-page h2.project-page__name',
          );
          const path = `/projects/${project}`;
          return (
            (window.location.pathname === path ||
              window.location.pathname.startsWith(`${path}/`)) &&
            heading?.textContent === project &&
            !text.includes('Page not found')
          );
        }, remoteProject),
      {
        timeout: 45_000,
        timeoutMsg:
          'The paired remote Project workspace did not open in the real shell',
      },
    );
    assert.deepEqual(hintRequests, []);
    const authenticated = remoteTraffic().filter(
      (entry) => entry.authenticated,
    );
    assert.ok(
      authenticated.some(
        (entry) =>
          entry.stage === 'finish' &&
          entry.method === 'GET' &&
          entry.path === '/api/projects' &&
          entry.status === 200,
      ),
      'Remote authentication must reach the real protected Project route',
    );
    const localOperatorHash = createHash('sha256')
      .update(`Bearer ${readE2EOperatorCredential(fixture.stationHome)}`)
      .digest('hex');
    assert.ok(
      authenticated.every(
        (entry) =>
          entry.authorizationHash !== localOperatorHash &&
          entry.authorizationHash !== originalCredentialHash &&
          entry.authorizationHash === pairedCredentialHash,
      ),
      'Remote requests must use only the explicitly paired native credential, never the original controller or operator bearer',
    );
    const admissionTrafficOffset = remoteTraffic().length;
    assert.equal(
      (await ipc(driver, 'plugin:station-discovery|prepare')).status,
      'unavailable',
      'After explicit switching, admission must come from the selected remote host, not the still-enabled original controller',
    );
    const selectedAdmissionTraffic = remoteTraffic().slice(
      admissionTrafficOffset,
    );
    assert.ok(
      selectedAdmissionTraffic.some(
        (entry) =>
          entry.stage === 'finish' &&
          entry.method === 'GET' &&
          entry.authenticated &&
          entry.path === '/api/feature-previews/desktop-nearby/admission' &&
          entry.status === 404,
      ),
      'The selected remote host must complete the authenticated preview refusal',
    );
    assert.ok(
      selectedAdmissionTraffic.every(
        (entry) =>
          entry.authorizationHash !== localOperatorHash &&
          entry.authorizationHash !== originalCredentialHash &&
          (!entry.authenticated ||
            entry.authorizationHash === pairedCredentialHash),
      ),
      'Authenticated selected-host admission must use only the explicitly paired credential',
    );
    writeFileSync(
      join(output, 'nearby-paired-remote-project.png'),
      await driver.screenshot(),
    );
    console.log(
      `NEARBY_NATIVE_PAIRED ${JSON.stringify({ remoteOrigin, remoteProject, realWindowsCredentialStore: true })}`,
    );
  } catch (error) {
    if (fixture) {
      try {
        writeFileSync(
          join(output, 'failure.png'),
          await fixture.driver.screenshot(),
        );
        const page = await fixture.driver.execute(() => ({
          url: location.href,
          readyState: document.readyState,
          text: document.body?.textContent ?? null,
        }));
        const server = await fixture.driver.executeAsyncSource<unknown, []>(
          `const done = arguments[0];
           window.__TAURI_INTERNALS__.invoke('bundled_server_status').then(
             value => done(value), error => done({error: String(error)}));`,
        );
        writeFileSync(
          join(output, 'failure.json'),
          JSON.stringify({ page, server }, null, 2),
        );
      } catch (diagnosticError) {
        console.error(
          'Nearby failure diagnostics unavailable',
          diagnosticError,
        );
      }
    }
    throw error;
  } finally {
    const cleanup = async (name: string, action: () => Promise<void>) => {
      try {
        await action();
      } catch (error) {
        console.error(`Nearby cleanup failed: ${name}`, error);
        process.exitCode = 1;
      }
    };
    if (fixture) {
      const shell = fixture;
      await cleanup('native process group', () => shell.stop());
    }
    await cleanup('advertisement', async () => {
      await service?.end();
    });
    await cleanup('multicast responder', () => responder.shutdown());
    await cleanup('isolated WebView profile', async () => {
      assert.ok(
        !shellLaunched || processGroupSettled,
        'Do not remove a running WebView profile',
      );
      await rm(webviewRoot, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
    });
    await cleanup(
      'hint listener',
      () =>
        new Promise<void>((resolve, reject) => {
          hintServer.close((error) => (error ? reject(error) : resolve()));
          hintServer.closeAllConnections();
        }),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
