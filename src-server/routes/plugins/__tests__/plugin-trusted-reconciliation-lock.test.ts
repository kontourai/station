import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { clearPluginProviders } from '../../../providers/registries/registry.js';
import { createConsentApp } from '../../../runtime/consent/consent-listener.js';
import { ConsentChannelService } from '../../../services/consent/consent-channel.js';
import { withPluginContentLock } from '../../../services/plugins/plugin-content-integrity.js';
import type { Logger } from '../../../utils/logger.js';
import { createPluginRoutes } from '../plugins.js';

test('trusted approval retains an independent content lease through a real delayed provider import', async () => {
  const root = mkdtempSync(join(tmpdir(), 'station-trusted-provider-lease-'));
  const pluginsDir = join(root, 'plugins');
  const pluginName = 'provider-plugin';
  const pluginDir = join(pluginsDir, pluginName);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    join(pluginDir, 'plugin.json'),
    JSON.stringify({
      name: pluginName,
      version: '1.0.0',
      providers: [{ type: 'settings', module: './provider.mjs' }],
    }),
  );
  writeFileSync(
    join(pluginDir, 'payload.mjs'),
    'export const marker = "reviewed";',
  );
  writeFileSync(
    join(pluginDir, 'provider.mjs'),
    [
      'const probe = globalThis.__stationTrustedProviderLeaseProbe;',
      'probe.started = true;',
      'await probe.gate;',
      'const { marker } = await import("./payload.mjs");',
      'probe.observed.push(marker);',
      'export default { marker };',
    ].join('\n'),
  );
  let finishImport!: () => void;
  const probe = {
    started: false,
    observed: [] as string[],
    gate: new Promise<void>((resolve) => {
      finishImport = resolve;
    }),
  };
  const testGlobal = globalThis as typeof globalThis & {
    __stationTrustedProviderLeaseProbe?: typeof probe;
  };
  testGlobal.__stationTrustedProviderLeaseProbe = probe;
  const channel = new ConsentChannelService();
  channel.markListening(4978);
  const credential = 'O'.repeat(43);
  const consent = createConsentApp({
    channel,
    credentials: {
      verifyOperatorCredential: (candidate) => candidate === credential,
      identifyDevice: () => null,
    },
  });
  const app = createPluginRoutes(
    root,
    {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as Logger,
    undefined,
    {
      consentChannel: channel,
      applyConfigurationMutation: async (operation) =>
        operation(() => {}, { status: 'applied' }),
      settleProviderAdapterRetirements: async () => {},
      reconcileEngineConnections: async () => {},
      removeEngineConnections: async () => {},
      quiesceEventSubscriptions: async () => ({ release() {} }),
      reconcileEventSubscriptions: async () => ({ kind: 'applied' }),
    },
  );
  let updating: Promise<void> | undefined;
  try {
    const opening = await app.request('/host-approvals', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'localhost:3141' },
      body: JSON.stringify({ pluginName, permissions: ['providers.register'] }),
    });
    const opened = (await opening.json()) as { approval: { id: string } };
    expect(opening.status, JSON.stringify(opened)).toBe(200);
    const review = await consent.request(`/consent/${opened.approval.id}`, {
      headers: {
        host: 'localhost:4978',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
        cookie: `station-device=${credential}`,
      },
    });
    const nonce = (await review.text()).match(
      /name="nonce" value="([^"]+)"/,
    )?.[1];
    expect(nonce).toBeTruthy();
    const decision = await consent.request(
      `/consent/${opened.approval.id}/decide`,
      {
        method: 'POST',
        headers: {
          host: 'localhost:4978',
          origin: 'http://localhost:4978',
          'sec-fetch-site': 'same-origin',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-dest': 'document',
          'sec-fetch-user': '?1',
          'content-type': 'application/x-www-form-urlencoded',
          cookie: `station-device=${credential}`,
        },
        body: new URLSearchParams({
          decision: 'approve',
          nonce: nonce!,
        }).toString(),
      },
    );
    expect(decision.status).toBe(200);
    expect(
      await (await app.request(`/host-approvals/${opened.approval.id}`)).json(),
    ).toMatchObject({
      approval: {
        status: 'approved',
        reconciliation: { status: 'winding-down' },
      },
    });
    await vi.waitFor(() => expect(probe.started).toBe(true));

    let updateEntered = false;
    // This is the real cooperative mutation boundary used by update/uninstall,
    // not a mock lock. Write replacement bytes while the import is suspended.
    updating = withPluginContentLock(pluginsDir, pluginName, async () => {
      updateEntered = true;
      writeFileSync(
        join(pluginDir, 'payload.mjs'),
        'export const marker = "replacement";',
      );
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const updateWaited = !updateEntered;
    finishImport();
    await updating;
    await vi.waitFor(() => expect(probe.observed).toHaveLength(1));
    // The public revoke joins the retained reconciliation chain, so teardown
    // waits for that original background work, not just its bounded response.
    const revoked = await app.request(`/${pluginName}/grant`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ permissions: ['providers.register'] }),
    });
    expect(revoked.status).toBe(200);
    expect({ updateWaited, executed: probe.observed }).toEqual({
      updateWaited: true,
      executed: ['reviewed'],
    });
    expect(readFileSync(join(pluginDir, 'payload.mjs'), 'utf8')).toContain(
      'replacement',
    );
  } finally {
    finishImport();
    await updating;
    clearPluginProviders();
    delete testGlobal.__stationTrustedProviderLeaseProbe;
    await rm(root, { recursive: true, force: true });
  }
});
