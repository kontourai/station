// @vitest-environment node

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KIT_OBSERVABILITY_CONFORMANCE_VECTORS } from '@kontourai/flow-agents/kit-observability-conformance';
import { afterEach, describe, expect, test } from 'vitest';

const scratch: string[] = [];
afterEach(() => {
  for (const root of scratch.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe('Kit lifecycle cross-process transitions', () => {
  test('a stale process cannot overwrite a newer disable transition', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-kit-process-'));
    scratch.push(root);
    const kitDirectory = join(root, 'kit');
    const statePath = join(root, 'config', 'kit-observability-lifecycle.json');
    mkdirSync(kitDirectory);
    writeFileSync(
      join(kitDirectory, 'kit.json'),
      JSON.stringify({
        observability_contribution: {
          path: 'kit-observability.contribution.json',
        },
      }),
    );
    const descriptor = structuredClone(
      KIT_OBSERVABILITY_CONFORMANCE_VECTORS[0].contribution,
    );
    writeFileSync(
      join(kitDirectory, 'kit-observability.contribution.json'),
      JSON.stringify(descriptor),
    );
    const registryUrl = new URL(
      '../kit-observability-registry.ts',
      import.meta.url,
    ).href;
    const hostUrl = new URL('../kit-observability-host.ts', import.meta.url)
      .href;
    const child = (action: 'disable' | 'enable', ready: string, go: string) =>
      spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '--eval',
          `import { existsSync, writeFileSync } from 'node:fs';
           import { StationKitObservabilityRegistry } from ${JSON.stringify(registryUrl)};
           import { StationKitObservabilityHost } from ${JSON.stringify(hostUrl)};
           const registry = new StationKitObservabilityRegistry(new StationKitObservabilityHost({ supported_contract_versions: ['1.0'], capabilities: ['standard_views', 'mcp_apps_resource_bridge', 'resource.open'] }), { statePath: process.argv[1] });
           await registry.discoverInstalled([process.argv[2]]);
           writeFileSync(process.argv[3], 'ready');
           while (!existsSync(process.argv[4])) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
           try { await registry[process.argv[5]](${JSON.stringify(descriptor.metadata.name)}); process.exit(0); }
           catch (error) { process.stderr.write(String(error)); process.exit(error?.name === 'KitLifecycleConflictError' ? 3 : 2); }`,
          statePath,
          root,
          ready,
          go,
          action,
        ],
        { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
      );
    const firstReady = join(root, 'first.ready');
    const secondReady = join(root, 'second.ready');
    const firstGo = join(root, 'first.go');
    const secondGo = join(root, 'second.go');
    const first = child('disable', firstReady, firstGo);
    const stale = child('enable', secondReady, secondGo);
    await waitFor(() => existsSync(firstReady) && existsSync(secondReady));
    writeFileSync(firstGo, 'go');
    expect((await once(first, 'exit'))[0]).toBe(0);
    writeFileSync(secondGo, 'go');
    expect((await once(stale, 'exit'))[0]).toBe(3);

    const persisted = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(persisted.contributions[descriptor.metadata.name]).toMatchObject({
      available: true,
      enabled: false,
    });
  }, 20_000);
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error('children did not become ready');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
