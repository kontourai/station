/**
 * Packaged macOS shell proof for the first native relay onboarding step.
 * This exercises the real WebView -> Tauri command -> OS keyring path. It does
 * not establish a broker route, account session, Device grant, or Project work.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { findFreePortOutside } from '../../scripts/lib/free-ports.mjs';
import {
  startTauriShellFixture,
  type TauriShellFixture,
} from './direct-webdriver.js';

const APP_IDENTIFIER = 'io.kontourai.station.webdriver';
const KEYRING_SERVICE = 'io.kontourai.station.relay-proof';

function proofAccount(clientInstanceId: string) {
  const appHash = createHash('sha256')
    .update(APP_IDENTIFIER)
    .digest('base64url');
  return `native-proof:v1:dev:${appHash}:${clientInstanceId}`;
}

function keyringStatus(account: string) {
  return spawnSync(
    'security',
    ['find-generic-password', '-s', KEYRING_SERVICE, '-a', account],
    { encoding: 'utf8', windowsHide: true },
  );
}

function removeOwnedProofKey(account: string) {
  if (keyringStatus(account).status !== 0) return;
  const deleted = spawnSync(
    'security',
    ['delete-generic-password', '-s', KEYRING_SERVICE, '-a', account],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.equal(
    deleted.status,
    0,
    'could not remove the exact fixture proof key',
  );
  assert.notEqual(
    keyringStatus(account).status,
    0,
    'fixture proof key remained after cleanup',
  );
}

async function main() {
  if (process.platform !== 'darwin')
    throw new Error('native relay keyring shell proof requires macOS');
  const clientInstanceId = randomUUID();
  const account = proofAccount(clientInstanceId);
  const brokerPort = await findFreePortOutside(20_000, 8);
  const route = {
    name: `relay-proof-${clientInstanceId.slice(0, 8)}`,
    endpoint: 'https://station.example',
    brokerOrigin: `http://127.0.0.1:${brokerPort}`,
    stationId: randomUUID(),
    enrollmentId: randomUUID(),
    clientInstanceId,
  };
  let fixture: TauriShellFixture | undefined;
  try {
    fixture = await startTauriShellFixture({
      seedRemoteProfile: false,
      seedRelayRoute: route,
      realCredentialStore: true,
    });
    const driver = fixture.driver;
    await driver.navigate('tauri://localhost/connections/computers');
    let prepare: string | undefined;
    await driver.waitUntil(
      async () => {
        prepare = await driver.findElement(
          '.relay-route-key-approval__prepare button',
        );
        return Boolean(prepare);
      },
      {
        timeout: 60_000,
        timeoutMsg: 'Saved relay route did not expose native key preparation.',
      },
    );
    assert.ok(prepare);
    await driver.clickElement(prepare);
    await driver.waitUntil(
      async () =>
        Boolean(
          await driver.findElement(
            'section[aria-label="Public install proof metadata"]',
          ),
        ),
      {
        timeout: 30_000,
        timeoutMsg: 'Native keyring preparation did not reach the WebView.',
      },
    );
    const metadata = await driver.execute(() => {
      const section = document.querySelector(
        'section[aria-label="Public install proof metadata"]',
      );
      if (!section) return null;
      return Object.fromEntries(
        Array.from(section.querySelectorAll('dl > div')).map((entry) => [
          entry.querySelector('dt')?.textContent?.trim() ?? '',
          entry.querySelector('dd')?.textContent?.trim() ?? '',
        ]),
      );
    });
    assert.ok(metadata);
    assert.equal(metadata.App, APP_IDENTIFIER);
    assert.equal(metadata.Channel, 'dev');
    assert.equal(metadata['Client instance'], clientInstanceId);
    assert.match(metadata['Key thumbprint'] ?? '', /^[A-Za-z0-9_-]{43}$/u);
    const publicKey = JSON.parse(metadata['Public key'] ?? 'null');
    assert.equal(publicKey.kty, 'EC');
    assert.equal(publicKey.crv, 'P-256');
    assert.equal(
      keyringStatus(account).status,
      0,
      'proof key not in OS keyring',
    );
    const trustStatus = await driver.execute(
      () =>
        document.querySelector('.relay-route-key-approval')?.textContent ?? '',
    );
    assert.match(trustStatus, /Station key untrusted/u);
    const routeStatus = await driver.execute(
      () =>
        document.querySelector(
          'section[aria-label="Saved broker routes"] .connections-computers__state',
        )?.textContent ?? '',
    );
    assert.equal(routeStatus.trim(), 'Not connected');
    const outputDir = resolve(
      import.meta.dirname,
      '../../.kontourai/tauri-shell-e2e',
    );
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(
      resolve(outputDir, 'native-relay-key-prepare.png'),
      await driver.screenshot(),
    );
    console.log(
      `native relay key prepare: public proof reached the WebView and owned OS keyring; Station ${route.stationId}; source ${process.env.STATION_TAURI_E2E_SOURCE_SHA ?? 'unrecorded'}`,
    );
  } finally {
    try {
      await fixture?.stop();
    } finally {
      removeOwnedProofKey(account);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
