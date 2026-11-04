import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { materializeRepairCredential } from '../repair-credentials.mjs';
import type { RepairExecutionProfile } from '../repair-store.js';
import { executeDockerRepair } from '../repair-worker.mjs';

type Transport = {
  providerProxy: { baseUrl: string; capability: string; model: string };
  model: string;
};
const state = vi.hoisted(() => ({
  forwarded: 0,
  worker: undefined as ((input: Transport) => Promise<void>) | undefined,
  requestHeaders: [] as string[],
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: Object.assign(vi.fn(), {
      [Symbol.for('nodejs.util.promisify.custom')]: async (
        command: string,
        args: string[],
      ) => {
        expect(command).toBe('docker');
        expect(args[0]).toBe('ps');
        return { stdout: '', stderr: '' };
      },
    }),
  };
});
vi.mock('@kontourai/flow-agents/provider-broker', async () => {
  const actual = await vi.importActual<{
    startProviderProxy(input: Record<string, unknown>): Promise<unknown>;
  }>('@kontourai/flow-agents/provider-broker');
  return {
    startProviderProxy: (input: Record<string, unknown>) =>
      actual.startProviderProxy({
        ...input,
        fetchImpl: async (
          _url: string,
          request: { headers: { authorization: string } },
        ) => {
          state.forwarded++;
          state.requestHeaders.push(request.headers.authorization);
          return Response.json({ fixture: true });
        },
      }),
  };
});
vi.mock('@kontourai/flow-agents/docker-worker', () => ({
  runCodexDockerWorker: async (input: Transport) => {
    expect(JSON.stringify(input)).not.toContain(
      'host-provider-synthetic-secret',
    );
    await state.worker!(input);
    return {
      observed: { host_user_mapping: 'fixture-only' },
      container_removed: true,
    };
  },
}));
const temporary = trackTempDirs();
afterEach(() => {
  vi.unstubAllEnvs();
  state.forwarded = 0;
  state.requestHeaders.length = 0;
  state.worker = undefined;
});

test('real published broker accepts the durable run binding and enforces request quota behind a revocable, bounded front capability', async () => {
  const directory = temporary('repair-broker-boundary-');
  const home = join(directory, 'home');
  mkdirSync(home);
  const workspace = join(directory, 'workspace');
  mkdirSync(workspace);
  const sourceRoot = join(directory, 'source');
  mkdirSync(sourceRoot);
  vi.stubEnv('STATION_SYNTHETIC_PROVIDER', 'host-provider-synthetic-secret');
  let allowed = true;
  state.worker = async ({ providerProxy, model }) => {
    const url = `${providerProxy.baseUrl.replace('host.docker.internal', '127.0.0.1')}/responses`;
    const call = (input: unknown) =>
      fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${providerProxy.capability}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model, reasoning: { effort: 'medium' }, input }),
      });
    expect((await call('first')).status).toBe(200);
    expect(
      (
        await call(
          Array.from({ length: 1025 }, () => ({
            type: 'input_text',
            text: 'amplified',
          })),
        )
      ).status,
    ).toBe(403);
    expect((await call('second')).status).toBe(200);
    expect((await call('over budget')).status).toBe(429);
    expect(state.forwarded).toBe(2);
    allowed = false;
    expect((await call('revoked')).status).toBe(403);
    expect(state.forwarded).toBe(2);
  };
  const profile: RepairExecutionProfile = {
    id: crypto.randomUUID(),
    revision: 1,
    enabled: true,
    kind: 'execution',
    configuredBy: 'fixture',
    projectId: 'project',
    agentId: 'repairer',
    repository: 'owner/repo',
    repositoryId: 1,
    image: `sha256:${'a'.repeat(64)}`,
    model: 'fixture-model',
    reasoningEffort: 'medium',
    providerAuth: { env: 'STATION_SYNTHETIC_PROVIDER' },
  };
  const runId = crypto.randomUUID();
  const result = await executeDockerRepair({
    runId,
    ownerId: crypto.randomUUID(),
    containerName: `kontour-worker-${runId}`,
    home,
    profile,
    directory,
    workspace,
    sourceRoot,
    bindingDigest: 'b'.repeat(64),
    instructions: 'Controlled transport fixture.',
    observation: {},
    budget: { maxProviderRequests: 2, maxWallRuntimeMs: 60_000 },
    signal: new AbortController().signal,
    assertCurrent: async () => {
      if (!allowed) throw new Error('revoked');
    },
  });
  expect(result.provider.transportMode).toBe('mocked-test-only');
  expect(result.provider.counters.total_forwarded).toBe(2);
  expect(state.requestHeaders).toEqual([
    'Bearer host-provider-synthetic-secret',
    'Bearer host-provider-synthetic-secret',
  ]);
});

test.runIf(process.platform !== 'win32')(
  'a stalled secret tool remains asynchronously cancelable after it starts',
  async () => {
    const root = temporary('repair-secret-cancellation-');
    const marker = join(root, 'started');
    const executable = join(root, 'op');
    writeFileSync(
      executable,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); setInterval(() => {}, 1000);\n`,
      { mode: 0o700 },
    );
    vi.stubEnv('PATH', `${root}${delimiter}${process.env.PATH ?? ''}`);
    const controller = new AbortController();
    const pending = materializeRepairCredential(
      { op: 'op://fixture/item/key' },
      { signal: controller.signal, assertCurrent: async () => {} },
    );
    const rejected = expect(pending).rejects.toThrow(
      'repair-credential-unavailable',
    );
    try {
      await vi.waitFor(() => expect(existsSync(marker)).toBe(true));
      controller.abort();
      await rejected;
    } finally {
      controller.abort();
      await pending.catch(() => {});
    }
  },
);
