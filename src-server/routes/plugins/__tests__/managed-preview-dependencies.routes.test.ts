/**
 * #4521 round 2: `POST /preview` resolves a source-less dependency through the
 * registry. Under `limits.registries.unsignedPackages: false` an unsigned
 * registry claim for that dependency is refused BEFORE its source is staged,
 * and the refusal is the preview's answer (the managed 403), never
 * `valid: true` after a failed clone.
 *
 * The real route stages the parent from a local folder through the real
 * `fetchPluginSource`. The dependency's package host is a TCP listener that
 * records every connection, so a clone attempt is observable. The control
 * takes the same path with no policy and does contact the host.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import {
  MANAGED_POLICY_CAPABILITY_DISABLED_CODE,
  parseManagedPolicyDocument,
  summarizeManagedPolicy,
} from '@kontourai/station-contracts/managed-policy';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  clearAll,
  registerPluginRegistryProvider,
} from '../../../providers/registries/registry.js';
import { installManagedCapabilityLimits } from '../../../security/managed-capability-limits.js';
import { registerPluginInstallRoutes } from '../plugin-install-routes.js';

const temporary = trackTempDirs();
const REGISTRY = 'https://approved.example.com/registry.json';

afterEach(() => {
  installManagedCapabilityLimits(null);
  clearAll();
});

async function packageHost() {
  const connections: string[] = [];
  const server = createServer((socket) => {
    connections.push('connection');
    socket.destroy();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no TCP');
  return {
    url: `https://127.0.0.1:${address.port}/unsigned-dep.git`,
    connections,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

async function previewWithUnsignedDependency(policy: boolean) {
  const host = await packageHost();
  try {
    const root = temporary('managed-preview-deps-');
    mkdirSync(join(root, 'plugins'), { recursive: true });
    const source = join(root, 'parent');
    mkdirSync(source);
    writeFileSync(
      join(source, 'plugin.json'),
      JSON.stringify({
        name: 'parent-plugin',
        version: '1.0.0',
        // Source-less: the registry supplies where it comes from.
        dependencies: [{ id: 'unsigned-dep' }],
      }),
    );
    const claim = {
      packageSchema:
        'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      registryId: 'unsigned-dep',
      registryKey: REGISTRY,
      pluginName: 'unsigned-dep',
      packageVersion: '1.0.0',
      source: host.url,
      packageDigest: `sha256:${'0'.repeat(64)}`,
    };
    registerPluginRegistryProvider(
      {
        registryKey: REGISTRY,
        // The catalog listing carries the source, as a manifest's does.
        listAvailable: async () => [
          { id: 'unsigned-dep', installed: false, source: host.url },
        ],
        listInstalled: async () => [],
        resolvePackage: async () => ({ source: host.url, claim }),
        install: async () => ({ success: false, message: 'n/a' }),
        uninstall: async () => ({ success: false, message: 'n/a' }),
      },
      'Configured registry',
    );
    if (policy)
      (() => {
        const parsed = parseManagedPolicyDocument({
          schemaVersion: 1,
          organization: 'Acme',
          limits: { registries: { unsignedPackages: false } },
        });
        if (!parsed.ok) throw new Error('fixture policy refused');
        installManagedCapabilityLimits({
          summary: summarizeManagedPolicy(parsed.document),
        });
      })();
    const app = new Hono();
    registerPluginInstallRoutes(app, {
      projectVisiblePlugins: () => (installed) => installed,
      agentsDir: join(root, 'agents'),
      logger: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      } as never,
      pluginsDir: join(root, 'plugins'),
      projectHomeDir: root,
    });
    const response = await app.request('/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source }),
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
      connections: [...host.connections],
    };
  } finally {
    await host.close();
  }
}

describe('preview dependencies under unsignedPackages false', () => {
  test('control: without a policy the dependency source is fetched', async () => {
    const { connections, body } = await previewWithUnsignedDependency(false);
    expect(connections.length).toBeGreaterThan(0);
    expect(body.code).not.toBe(MANAGED_POLICY_CAPABILITY_DISABLED_CODE);
  });

  test('an unsigned registry dependency is refused with the managed 403 and the package host is never contacted', async () => {
    const { status, body, connections } =
      await previewWithUnsignedDependency(true);
    expect(connections).toEqual([]);
    expect(status).toBe(403);
    expect(body).toMatchObject({
      valid: false,
      code: MANAGED_POLICY_CAPABILITY_DISABLED_CODE,
      reason: 'managed-signature-required',
    });
    expect(String(body.error)).toContain(
      "Acme's policy manages unsigned registry packages",
    );
  });
});
