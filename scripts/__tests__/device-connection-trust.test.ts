import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ApprovedStationConnectionTrust } from '@kontourai/station-contracts/connection-proof';
import {
  connectionDescriptionDigest,
  signStationConnectionProof,
  stationConnectionSigningKeyId,
} from '@kontourai/station-shared/connection-proof';
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
} from '@playwright/test';
import { build, stop } from 'esbuild';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import {
  browserAccept,
  browserHasNoRemoteDescription,
} from '../lib/browser-transport-page.mjs';
import {
  corruptBrowserTrustRecord,
  deviceTrustOperation,
  downgradeBrowserTrustDurability,
  fillBrowserTrustStore,
  openBrowserTrustStore,
  prepareBrowserTrustProof,
  refuseBrowserTrustStorage,
  refuseBrowserTrustWrites,
  upgradeBrowserTrustDatabase,
} from '../lib/device-connection-trust-page.mjs';

let browser: Browser;
let url: string;
let script = '';
const contexts = new Set<BrowserContext>();
const roots: string[] = [];
const server = createServer((request, response) => {
  if (request.url === '/trust.js') {
    response.writeHead(200, { 'Content-Type': 'text/javascript' });
    response.end(script);
  } else {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(
      '<!doctype html><title>Device trust fixture</title><script src="/trust.js"></script>',
    );
  }
});

beforeAll(async () => {
  const output = await build({
    stdin: {
      contents:
        "import {openDeviceConnectionTrustStore} from '@kontourai/station-connect/connection-trust'; import {createStationConnectionProofVerifier, connectionDescriptionDigest} from '@kontourai/station-shared/connection-proof'; import {createStationProofNonce} from './packages/connect/src/core/environmentProof.ts'; window.stationConnectionProof = {createStationConnectionProofVerifier, connectionDescriptionDigest}; window.deviceTrustNonce = createStationProofNonce; window.deviceTrustApi = {openDeviceConnectionTrustStore};",
      resolveDir: resolve(import.meta.dirname, '../..'),
    },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    write: false,
  });
  expect(output.outputFiles).toHaveLength(1);
  script = output.outputFiles[0].text;
  stop();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing fixture listener');
  url = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
}, 30000);

afterEach(async () => {
  const results = await Promise.allSettled(
    [...contexts].map((context) => context.close()),
  );
  contexts.clear();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  const failed = results.filter((value) => value.status === 'rejected');
  expect(failed).toEqual([]);
});
afterAll(async () => {
  try {
    await browser?.close();
  } finally {
    server.closeAllConnections();
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    stop();
  }
});

async function pageIn(context?: BrowserContext) {
  const owner = context ?? (await browser.newContext());
  contexts.add(owner);
  const page = await owner.newPage();
  await page.goto(url);
  await page.evaluate(openBrowserTrustStore);
  return page;
}
async function key(previous?: ApprovedStationConnectionTrust) {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKey = pair.publicKey.export({ format: 'jwk' });
  const trust: ApprovedStationConnectionTrust = {
    stationId: previous?.stationId ?? randomUUID(),
    enrollmentId: previous?.enrollmentId ?? randomUUID(),
    generation: (previous?.generation ?? 0) + 1,
    signingKey: { kty: 'EC', crv: 'P-256', x: publicKey.x!, y: publicKey.y! },
  };
  return {
    trust,
    keyId: await stationConnectionSigningKeyId(trust),
    privateKey: pair.privateKey,
  };
}
function operation(page: Page, name: string, ...args: unknown[]) {
  return page.evaluate(deviceTrustOperation, {
    operation: name,
    arguments: args,
  });
}

test('trust requires the independently approved key and persists across a real browser restart', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'station-device-trust-'));
  roots.push(profile);
  const firstContext = await chromium.launchPersistentContext(profile, {
    headless: true,
  });
  const page = await pageIn(firstContext);
  const { trust, keyId } = await key();
  expect(await operation(page, 'read', trust.stationId)).toBeNull();
  await expect(
    operation(page, 'approve', trust, null, 'a'.repeat(43)),
  ).rejects.toThrow('device_trust_conflict');
  expect(await operation(page, 'read', trust.stationId)).toBeNull();
  const approved = await operation(page, 'approve', trust, null, keyId);
  expect(approved).toEqual({
    schemaVersion: 1,
    revision: 1,
    status: 'approved',
    trust,
  });
  await firstContext.close();
  contexts.delete(firstContext);
  const reopened = await chromium.launchPersistentContext(profile, {
    headless: true,
  });
  const second = await pageIn(reopened);
  expect(await operation(second, 'read', trust.stationId)).toEqual(approved);
  expect(await operation(await pageIn(), 'read', trust.stationId)).toBeNull();
}, 60000);

test('two tabs racing first approval commit exactly one key', async () => {
  const context = await browser.newContext();
  const first = await pageIn(context);
  const second = await pageIn(context);
  const a = await key();
  const b = await key(a.trust);
  const contenders = await Promise.allSettled([
    operation(first, 'approve', a.trust, null, a.keyId),
    operation(second, 'approve', b.trust, null, b.keyId),
  ]);
  const successful = contenders.filter((value) => value.status === 'fulfilled');
  expect(successful).toHaveLength(1);
  const failed = contenders.filter((value) => value.status === 'rejected');
  expect(failed).toHaveLength(1);
  expect(String(failed[0].reason)).toContain('device_trust_conflict');
  expect(await operation(first, 'read', a.trust.stationId)).toEqual(
    successful[0].value,
  );
  expect(await operation(second, 'read', a.trust.stationId)).toEqual(
    successful[0].value,
  );
});

test('a committed rotation invalidates snapshots and rejects rollback, stale approval and changed enrollment', async () => {
  const page = await pageIn();
  const first = await key();
  const next = await key(first.trust);
  const original = await operation(
    page,
    'approve',
    first.trust,
    null,
    first.keyId,
  );
  const current = await operation(page, 'approve', next.trust, 1, next.keyId);
  expect(current.revision).toBe(2);
  expect(await operation(page, 'isCurrent', original)).toBe(false);
  expect(await operation(page, 'isCurrent', current)).toBe(true);
  await expect(
    operation(page, 'approve', next.trust, 1, next.keyId),
  ).rejects.toThrow('device_trust_conflict');
  await expect(
    operation(page, 'approve', first.trust, 2, first.keyId),
  ).rejects.toThrow('device_trust_conflict');
  await expect(
    operation(
      page,
      'approve',
      { ...next.trust, enrollmentId: randomUUID() },
      2,
      next.keyId,
    ),
  ).rejects.toThrow('device_trust_conflict');
  await page.reload();
  await page.evaluate(openBrowserTrustStore);
  expect(await operation(page, 'read', first.trust.stationId)).toEqual(current);
});

test('revocation persists as a tombstone and only independently approved fresh rotation restores trust', async () => {
  const page = await pageIn();
  const { trust, keyId } = await key();
  const original = await operation(page, 'approve', trust, null, keyId);
  const revoked = await operation(page, 'revoke', trust.stationId, 1);
  expect(revoked.status).toBe('revoked');
  expect(revoked.revision).toBe(2);
  await page.reload();
  await page.evaluate(openBrowserTrustStore);
  expect(await operation(page, 'read', trust.stationId)).toEqual(revoked);
  expect(await operation(page, 'isCurrent', original)).toBe(false);
  await expect(operation(page, 'approve', trust, null, keyId)).rejects.toThrow(
    'device_trust_conflict',
  );
  await expect(operation(page, 'approve', trust, 2, keyId)).rejects.toThrow(
    'device_trust_conflict',
  );
  const next = await key(trust);
  expect(
    (await operation(page, 'approve', next.trust, 2, next.keyId)).revision,
  ).toBe(3);
});

test.each([
  'future-version',
  'undefined',
  'null',
  'unknown-field',
  'wrong-station',
  'invalid-revision',
  'invalid-status',
])(
  'corrupt %s state is refused instead of being silently treated as first approval',
  async (kind) => {
    const page = await pageIn();
    const { trust, keyId } = await key();
    const record: Record<string, unknown> = {
      schemaVersion: 1,
      revision: 1,
      status: 'approved',
      trust,
    };
    if (kind === 'future-version') record.schemaVersion = 99;
    if (kind === 'unknown-field') record.operator = true;
    if (kind === 'wrong-station')
      record.trust = { ...trust, stationId: randomUUID() };
    if (kind === 'invalid-revision') record.revision = 0;
    if (kind === 'invalid-status') record.status = 'unknown';
    const invalid =
      kind === 'undefined' ? undefined : kind === 'null' ? null : record;
    await page.evaluate(corruptBrowserTrustRecord, {
      stationId: trust.stationId,
      value: invalid,
    });
    await expect(operation(page, 'read', trust.stationId)).rejects.toThrow(
      'device_trust_invalid',
    );
    await expect(
      operation(page, 'approve', trust, null, keyId),
    ).rejects.toThrow('device_trust_invalid');
    await expect(operation(page, 'revoke', trust.stationId, 1)).rejects.toThrow(
      'device_trust_invalid',
    );
  },
);

test('the browser caller refuses a valid signed answer after another tab revokes trust', async () => {
  const context = await browser.newContext();
  const page = await pageIn(context);
  const revoker = await pageIn(context);
  const { trust, keyId, privateKey } = await key();
  await operation(page, 'approve', trust, null, keyId);
  const description = await page.evaluate(
    prepareBrowserTrustProof,
    trust.stationId,
  );
  const fingerprint = (sdp: string) => {
    const value = sdp.match(/^a=fingerprint:sha-256 (.+)$/m)?.[1]?.trim();
    if (!value)
      throw new Error('Missing actual browser certificate fingerprint');
    return value;
  };
  const binding = {
    stationId: trust.stationId,
    enrollmentId: trust.enrollmentId,
    generation: trust.generation,
    clientNonce: description.clientNonce,
    connectionId: description.connectionId,
    clientFingerprint: fingerprint(description.offer),
    stationFingerprint: fingerprint(description.answer),
    offerSha256: await connectionDescriptionDigest(description.offer),
    answerSha256: await connectionDescriptionDigest(description.answer),
  };
  const proof = await signStationConnectionProof({
    trust,
    binding,
    signingKey: privateKey,
    now: Math.floor(Date.now() / 1000),
  });
  await operation(revoker, 'revoke', trust.stationId, 1);
  await expect(
    page.evaluate(browserAccept, {
      sdp: description.answer,
      pin: binding.stationFingerprint,
      candidates: [],
      proof,
    }),
  ).rejects.toThrow(
    'Device signing trust changed before accepting the connection',
  );
  expect(await page.evaluate(browserHasNoRemoteDescription)).toBe(true);
});

test('denied persistence fails instead of publishing memory-only approval', async () => {
  const page = await pageIn();
  const { trust, keyId } = await key();
  await page.evaluate(refuseBrowserTrustWrites);
  await expect(operation(page, 'approve', trust, null, keyId)).rejects.toThrow(
    'device_trust_unavailable',
  );
  expect(await operation(page, 'read', trust.stationId)).toBeNull();
});

test('a browser that cannot honor the strict durability request cannot approve trust', async () => {
  const page = await pageIn();
  const { trust, keyId } = await key();
  await page.evaluate(downgradeBrowserTrustDurability);
  await expect(operation(page, 'approve', trust, null, keyId)).rejects.toThrow(
    'device_trust_unavailable',
  );
  expect(await operation(page, 'read', trust.stationId)).toBeNull();
});

test('unsupported storage and database versions are unavailable without a fallback', async () => {
  const page = await pageIn();
  const { trust } = await key();
  await page.evaluate(upgradeBrowserTrustDatabase);
  await expect(operation(page, 'read', trust.stationId)).rejects.toThrow(
    'device_trust_unavailable',
  );
  await expect(page.evaluate(openBrowserTrustStore)).rejects.toThrow(
    'device_trust_unavailable',
  );
  const denied = await pageIn();
  await denied.evaluate(refuseBrowserTrustStorage);
  await expect(denied.evaluate(openBrowserTrustStore)).rejects.toThrow(
    'device_trust_unavailable',
  );
});

test('the bounded store rejects another Station at capacity while preserving revocation', async () => {
  const page = await pageIn();
  const { trust, keyId } = await key();
  const stationIds = Array.from({ length: 256 }, () => randomUUID());
  await page.evaluate(fillBrowserTrustStore, { trust, keyId, stationIds });
  await expect(operation(page, 'approve', trust, null, keyId)).rejects.toThrow(
    'device_trust_unavailable',
  );
  expect(await operation(page, 'read', trust.stationId)).toBeNull();
  expect((await operation(page, 'revoke', stationIds[0], 1)).status).toBe(
    'revoked',
  );
});
