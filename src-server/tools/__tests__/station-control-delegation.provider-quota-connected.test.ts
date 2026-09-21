/**
 * #2265 connected projection test — the FULL storage/serving composition.
 *
 * One genuine SDK `RequestError` carrying the synthetic quota shape is
 * injected at the ONLY fake seam — the ACP provider process boundary
 * (`processFactory`, the same constructor-level seam the full
 * `acp-adapter.test.ts` fakes use). Everything else is real:
 *
 *   real `AcpAdapter` (terminal seam `bindPromptSettlement`)
 *   → real `OrchestrationService` over a real `EventStore`
 *     (`delegateTask`'s create-path dispatch starts the session and sends
 *     the turn; the adapter's quota `runtime.error` is persisted by the
 *     service's own event subscription loop)
 *   → the real read fold over the PERSISTED rows
 *   → the real `createOrchestrationRoutes` GET read endpoints
 *     (`/delegations/:taskId`, `/delegations/:taskId/events`) through the
 *     real `observeDelegatedTask`/`observeDelegatedTaskEvents`
 *     (`loadDelegatedTask` → binding check → service read)
 *   → the real SDK carrier (`observeDelegatedTask` client over HTTP).
 *
 * It fails if any joint drops the quota `details`, the failed `turnId`, or
 * the reason — including the storage/serving composition the unit suites
 * cannot see. The readback below is asserted to originate from the
 * persisted row, not from in-memory adapter state.
 *
 * Not covered here (labelled, unchanged from the prior round): the CLI's
 * human-output rendering (pinned by `packages/cli/src/__tests__/delegate.test.ts`
 * against a field-identical reason) and the remote-peer forwarding path.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Client,
  type ContentBlock,
  type PromptResponse,
  RequestError,
} from '@agentclientprotocol/sdk';
import { agentId } from '@kontourai/station-contracts/agent-identity';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import {
  observeDelegatedTask as observeDelegatedTaskClient,
  observeDelegatedTaskEvents as observeDelegatedTaskEventsClient,
} from '@kontourai/station-sdk/client';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AcpAdapter } from '../../providers/adapters/acp-adapter.js';
import type { IProviderAdapterRegistry } from '../../providers/provider-interfaces.js';
import { createOrchestrationRoutes } from '../../routes/orchestration/orchestration.js';
import type {
  ACPProcess,
  ACPProcessOptions,
} from '../../services/acp/acp-process.js';
import { AgentPolicyService } from '../../services/agents/agent-policy-service.js';
import { WorkflowSidecarService } from '../../services/evidence/workflow-sidecar-service.js';
import { FlowRunService } from '../../services/flow/flow-run-service.js';
import { EventBus } from '../../services/orchestration/event-bus.js';
import { EventStore } from '../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../services/orchestration/orchestration-service.js';
import { createSessionAgentResolver } from '../../services/orchestration/session-agent-resolution.js';
import {
  delegateTask,
  observeDelegatedTask,
  observeDelegatedTaskEvents,
} from '../station-control-delegation.js';

process.env.STATION_API_BASE = 'http://quota-connected.test';
process.env.STATION_INTERNAL_API_TOKEN = 'internal-test-token';

const QUOTA_MESSAGE =
  'quota: Usage limit reached for 5 hour. Your limit will reset at 2026-09-21 18:55:29';
const CONNECTION_ID = 'opencode-connection';
// The process-real fetch, captured before any stubbing, so the loop-back
// HTTP bridge below is a genuine network round trip.
const bridgeFetch = globalThis.fetch.bind(globalThis);

class QuotaStubProcess {
  client!: Client;
  initResult = {
    protocolVersion: 1,
    agentCapabilities: { promptCapabilities: { image: true } },
  };
  sessionId: string | null = null;
  private rejectPrompt?: (error: unknown) => void;

  constructor(readonly opts: ACPProcessOptions) {}

  async start() {
    this.client = this.opts.createClient(undefined as never);
    return this.initResult;
  }

  async newSession(cwd: string) {
    this.sessionId = `native-${this.opts.command}-${cwd}`;
    return {
      sessionId: this.sessionId,
      modes: { availableModes: [], currentModeId: 'default' },
      configOptions: [],
    };
  }

  async loadSession(sessionId: string) {
    this.sessionId = sessionId;
  }

  async setMode(_modeId: string): Promise<void> {}

  async setConfigOption(): Promise<unknown> {
    return { configOptions: [] };
  }

  prompt(_content: ContentBlock[]): Promise<PromptResponse> {
    return new Promise<PromptResponse>((_resolve, reject) => {
      this.rejectPrompt = reject;
    });
  }

  failPrompt(error: unknown): void {
    this.rejectPrompt?.(error);
  }

  async cancel(): Promise<void> {}

  async extMethod(): Promise<unknown> {
    return {};
  }

  async destroy(): Promise<void> {}
}

async function waitFor<T>(
  read: () => T,
  matches: (value: T) => boolean,
  timeoutMs = 4000,
): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = read();
    if (matches(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for test condition');
}

let httpServers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(
    httpServers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  httpServers = [];
});

describe('delegation provider-plan quota connected projection (#2265)', () => {
  let tmp: string;
  let shimBin: string;
  let fakeHome: string;
  let previousPath: string | undefined;
  let previousStationHome: string | undefined;
  let eventStore: EventStore;
  let service: OrchestrationService;
  let adapter: AcpAdapter;
  let stubs: QuotaStubProcess[];
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    // The real adapter's readiness derivation (`assertAdapterReady` in the
    // service) probes the connection's CLI through `findCliBinary` +
    // `runCliCommand`. A throwaway shim binary on PATH plus an admissible
    // throwaway STATION_HOME make that real derivation report installed in
    // this sandbox — the same environmental admission the ACP suite needs
    // (see that suite's prerequisite test). No product seam is stubbed.
    tmp = mkdtempSync(join(tmpdir(), 'station-quota-connected-'));
    shimBin = join(tmp, 'bin');
    mkdirSync(shimBin, { recursive: true });
    writeFileSync(
      join(shimBin, 'opencode'),
      '#!/bin/sh\necho "opencode 1.0.0"\nexit 0\n',
      { mode: 0o755 },
    );
    fakeHome = join(tmp, 'station-home');
    mkdirSync(fakeHome, { recursive: true });
    previousPath = process.env.PATH;
    previousStationHome = process.env.STATION_HOME;
    process.env.PATH = `${shimBin}:${previousPath ?? ''}`;
    process.env.STATION_HOME = fakeHome;
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      const json = (data: unknown) =>
        new Response(JSON.stringify(data), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      if (url.endsWith('/.well-known/station/v1')) {
        return json({ environmentId: 'environment-current' });
      }
      if (url.endsWith(`/api/agents/opencode-agent`)) {
        return json({
          success: true,
          data: {
            slug: 'opencode-agent',
            name: 'OpenCode Agent',
            available: true,
            execution: { agentConnectionId: CONNECTION_ID },
          },
        });
      }
      if (url.endsWith(`/api/connections/${CONNECTION_ID}`)) {
        return json({
          success: true,
          data: {
            id: CONNECTION_ID,
            kind: 'agent',
            type: 'acp',
            enabled: true,
            status: 'ready',
            capabilities: ['agent-runtime'],
            config: { provider: 'acp' },
          },
        });
      }
      throw new Error(`Unexpected request in quota connected test: ${url}`);
    });

    eventStore = new EventStore(join(tmp, 'orchestration.sqlite'));
    stubs = [];
    // The fake lives ONLY at the provider process boundary: the adapter is
    // the real `AcpAdapter`, driven through the same `processFactory` seam
    // the full adapter suite fakes.
    adapter = new AcpAdapter({
      getConnections: async () => [
        {
          id: CONNECTION_ID,
          name: 'OpenCode',
          command: 'opencode',
          args: [],
          enabled: true,
        },
      ],
      logger: { debug: () => {}, warn: () => {}, error: () => {} },
      processFactory: (opts) => {
        const stub = new QuotaStubProcess(opts);
        stubs.push(stub);
        return stub as unknown as ACPProcess;
      },
    });
    const registry = {
      register() {},
      get(provider: string) {
        return provider === 'acp' ? adapter : undefined;
      },
      list() {
        return [adapter];
      },
    } as IProviderAdapterRegistry;
    service = new OrchestrationService({
      adapterRegistry: registry,
      eventBus: new EventBus(),
      eventStore,
      adoptionLedger: eventStore.createAdoptionLedger(),
      sessionOwnerCacheMaxEntries: 2,
      ownerlessSessionAccess: 'single-user-compat',
      flowRunService: new FlowRunService(),
      listProjects: () => [],
      agentPolicyService: new AgentPolicyService({
        env: { ...process.env, SA_HOOK_PROFILE: '', SA_DISABLED_HOOKS: '' },
        logger: { debug: vi.fn(), warn: vi.fn() },
      }),
      workflowSidecarService: new WorkflowSidecarService({
        logger: { debug: vi.fn(), warn: vi.fn() },
      }),
      resolveSessionAgent: createSessionAgentResolver({
        loadAgentSpec: async (slug) =>
          slug === 'opencode-agent'
            ? { name: 'OpenCode Agent', prompt: '' }
            : null,
        resolveToolServer: async () => null,
        resolveSkillDir: async () => null,
      }),
      logger: { debug: vi.fn(), warn: vi.fn() },
    } as never);
  });

  afterEach(() => {
    eventStore.close();
    rmSync(tmp, { recursive: true, force: true });
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousStationHome === undefined) delete process.env.STATION_HOME;
    else process.env.STATION_HOME = previousStationHome;
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  test('a fake ACP quota rejection persists through the EventStore and reads back via the real delegation routes and SDK', async () => {
    // The REAL create path: delegateTask starts the session through the
    // service (persisting session.started/configured with the binding
    // metadata) and dispatches the first turn through the real adapter.
    const handle = await delegateTask(
      {
        prompt: 'do the thing',
        target: {
          environment: { kind: 'current' },
          agent: agentId('opencode-agent'),
        },
      },
      service,
    );
    const taskId = handle.taskId;
    expect(taskId.startsWith('task:')).toBe(true);

    await waitFor(
      () => eventStore.listEvents(taskId).map((event) => event.payload.method),
      (methods) => methods.includes('session.configured'),
    );

    // Inject the quota failure at the process boundary — a genuine SDK
    // `RequestError` carrying the synthetic quota shape, the same rejection
    // the unit seam tests classify.
    expect(stubs.length).toBeGreaterThan(0);
    stubs[0].failPrompt(new RequestError(-32603, QUOTA_MESSAGE));

    // The adapter's terminal event is persisted by the service's own
    // subscription loop — wait for the PERSISTED row.
    const persisted = await waitFor(
      () =>
        eventStore
          .listEvents(taskId)
          .map((row) => row.payload as unknown as CanonicalRuntimeEvent)
          .find((event) => event.method === 'runtime.error'),
      (event) =>
        event?.code === 'provider-plan-quota-exhausted' &&
        typeof (event.details as Record<string, unknown> | undefined)
          ?.quotaWindow === 'string',
    );

    // The persisted terminal row names the failed turn and carries ONLY
    // fixed copy plus bounded details — the raw provider sentence is gone.
    if (!persisted) throw new Error('quota terminal row not persisted');
    expect(persisted.turnId).toBeTruthy();
    expect(JSON.stringify(persisted)).not.toContain('Usage limit');
    expect(persisted.details).toEqual({
      quotaWindow: '5 hour',
      resetReported: '2026-09-21 18:55:29',
      resetPrecision: 'unqualified',
    });
    const failedTurnId = persisted.turnId;

    // The actual read routes: createOrchestrationRoutes wired to the REAL
    // delegation observe functions bound to the service — no hand-built
    // projection anywhere — mounted at the production prefix. The readback
    // below originates from the persisted rows via `loadDelegatedTask` →
    // service read.
    const app = new Hono().route(
      '/api/orchestration',
      createOrchestrationRoutes({} as never, {
        eventBus: new EventBus(),
        logger: { debug: vi.fn() },
        getUserId: () => 'brian',
        observeDelegatedTask: (input: { taskId: string }) =>
          observeDelegatedTask(input, service),
        observeDelegatedTaskEvents: (input: { taskId: string }) =>
          observeDelegatedTaskEvents(input, service),
      }),
    );

    const statusRes = await app.request(
      `/api/orchestration/delegations/${encodeURIComponent(taskId)}`,
    );
    expect(statusRes.status).toBe(200);
    const statusBody = (await statusRes.json()) as {
      success: boolean;
      data: {
        status: string;
        resumable: boolean;
        reason?: { code: string; detail?: string } & Record<string, unknown>;
      };
    };
    expect(statusBody.success).toBe(true);
    const served = statusBody.data;
    expect(served.status).toBe('failed');
    expect(served.resumable).toBe(true);
    expect(served.reason).toMatchObject({
      code: 'provider-plan-quota-exhausted',
      quotaWindow: '5 hour',
      resetReported: '2026-09-21 18:55:29',
    });
    expect(served.reason?.detail).toBe(
      'The provider plan quota was exhausted (5 hour window). The provider reported the limit resets at 2026-09-21 18:55:29 (provider-reported time, no timezone given) — wait for the reset or check the provider plan, then continue explicitly. Station did not retry, switch models or providers, or spend on a fallback.',
    );
    expect(JSON.stringify(statusBody)).not.toContain('Usage limit');

    const eventsRes = await app.request(
      `/api/orchestration/delegations/${encodeURIComponent(taskId)}/events`,
    );
    expect(eventsRes.status).toBe(200);
    const eventsBody = (await eventsRes.json()) as {
      success: boolean;
      data: {
        events: Array<Record<string, unknown>>;
        eventCount: number;
      };
    };
    expect(eventsBody.success).toBe(true);
    const servedQuota = eventsBody.data.events.find(
      (event) => event.method === 'runtime.error',
    );
    expect(servedQuota).toMatchObject({
      kind: 'runtime',
      severity: 'error',
      quotaWindow: '5 hour',
      resetReported: '2026-09-21 18:55:29',
    });
    // The failed turn id survives the persisted row through the serving
    // projection, and no raw provider text does.
    expect(String(servedQuota?.turnId ?? servedQuota?.itemId ?? '')).toContain(
      String(failedTurnId),
    );
    expect(JSON.stringify(eventsBody)).not.toContain('Usage limit');
    expect(eventsBody.data.eventCount).toBeGreaterThanOrEqual(3);

    const server = createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const request = new Request(`http://127.0.0.1${req.url}`, {
          method: req.method,
          headers: { 'content-type': 'application/json' },
          body: ['GET', 'HEAD'].includes(req.method ?? 'GET')
            ? undefined
            : Buffer.concat(chunks).toString('utf8'),
        });
        const response = await app.request(request);
        const text = await response.text();
        res
          .writeHead(response.status, {
            'content-type': 'application/json',
          })
          .end(text);
      })().catch(() => {
        res.writeHead(500).end('{}');
      });
    });
    httpServers.push(server);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // The REAL SDK carrier over REAL HTTP: the fetch stub now FORWARDS
    // loop-back requests to the real server (the SDK client's own fetch)
    // while still serving the server-side observe functions' environment
    // resolution — both share global fetch.
    const realFetch = bridgeFetch;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith(`${apiBase}/`)) {
        return realFetch(input as Parameters<typeof fetch>[0], init);
      }
      const json = (data: unknown) =>
        new Response(JSON.stringify(data), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      if (url.endsWith('/.well-known/station/v1')) {
        return json({ environmentId: 'environment-current' });
      }
      throw new Error(`Unexpected request in quota connected test: ${url}`);
    });

    const viaSdk = await observeDelegatedTaskClient(apiBase, taskId);
    expect(viaSdk.status).toBe('failed');
    expect(viaSdk.reason).toMatchObject({
      code: 'provider-plan-quota-exhausted',
      quotaWindow: '5 hour',
      resetReported: '2026-09-21 18:55:29',
    });
    expect(viaSdk.reason?.detail).toContain('wait for the reset');
    expect(JSON.stringify(viaSdk)).not.toContain('Usage limit');

    const page = await observeDelegatedTaskEventsClient(apiBase, taskId);
    const sdkQuota = page.events.find(
      (event) => event.method === 'runtime.error',
    );
    expect(sdkQuota).toMatchObject({
      kind: 'runtime',
      quotaWindow: '5 hour',
      resetReported: '2026-09-21 18:55:29',
    });
    expect(sdkQuota?.text).toContain('2026-09-21 18:55:29');
    expect(sdkQuota?.text).not.toContain('Usage limit');
  });

  test('an unrelated adapter error keeps the generic reason (control)', async () => {
    const handle = await delegateTask(
      {
        prompt: 'control run',
        target: {
          environment: { kind: 'current' },
          agent: agentId('opencode-agent'),
        },
      },
      service,
    );
    await waitFor(
      () =>
        eventStore
          .listEvents(handle.taskId)
          .map((event) => event.payload.method),
      (methods) => methods.includes('session.configured'),
    );
    stubs[0].failPrompt(new RequestError(-32603, 'agent crashed badly'));
    const persisted = await waitFor(
      () =>
        eventStore
          .listEvents(handle.taskId)
          .map((row) => row.payload as unknown as CanonicalRuntimeEvent)
          .find((event) => event.method === 'runtime.error'),
      Boolean,
    );
    if (!persisted) throw new Error('generic terminal row not persisted');
    expect(persisted.code).not.toBe('provider-plan-quota-exhausted');

    const app = createOrchestrationRoutes({} as never, {
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      getUserId: () => 'brian',
      observeDelegatedTask: (input: { taskId: string }) =>
        observeDelegatedTask(input, service),
      observeDelegatedTaskEvents: (input: { taskId: string }) =>
        observeDelegatedTaskEvents(input, service),
    });
    const res = await app.request(
      `/delegations/${encodeURIComponent(handle.taskId)}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { status: string; reason?: { code?: string; detail?: string } };
    };
    expect(body.data.status).toBe('failed');
    expect(body.data.reason?.code).not.toBe('provider-plan-quota-exhausted');
  });
});
