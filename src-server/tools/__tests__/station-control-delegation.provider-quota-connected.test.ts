import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type Client,
  type ContentBlock,
  type PromptResponse,
  RequestError,
} from '@agentclientprotocol/sdk';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import type { SessionLifecycleState } from '@kontourai/station-contracts/session-lifecycle';
import {
  observeDelegatedTask,
  observeDelegatedTaskEvents,
} from '@kontourai/station-sdk/client';
import { afterEach, describe, expect, test } from 'vitest';
import { AcpAdapter } from '../../providers/adapters/acp-adapter.js';
import type {
  ACPProcess,
  ACPProcessOptions,
} from '../../services/acp/acp-process.js';
import {
  normalizeCanonicalRuntimeEventLifecycle,
  projectSessionLifecycle,
  turnIdentityAnchorForEvents,
} from '../../services/orchestration/session-lifecycle-service.js';
import {
  projectDelegatedTaskEvent,
  snapshotFor,
} from '../station-control-delegation.js';

/**
 * #2265 connected projection test: one genuine SDK `RequestError` carrying
 * the synthetic quota shape flows through the REAL terminal seam
 * (`AcpAdapter.bindPromptSettlement`), the canonical write-time normalize +
 * read fold (`normalizeCanonicalRuntimeEventLifecycle`,
 * `projectSessionLifecycle`), the serving delegate projections
 * (`snapshotFor`, `projectDelegatedTaskEvent`), and the REAL SDK carrier
 * (`observeDelegatedTask`, `observeDelegatedTaskEvents` over HTTP). It
 * fails if any joint drops the quota `details`, the failed `turnId`, or
 * the reason — the unit suites on either side hand-build those fixtures
 * and cannot see wiring drops.
 *
 * The stub process below covers ONLY the start → prompt → reject path via
 * the same constructor-level `processFactory` seam the full
 * `FakeAcpProcess` in `acp-adapter.test.ts` uses; no lifecycle logic is
 * reimplemented — every fold and projection called here is canonical.
 *
 * Honest gaps (NOT covered here, labelled not claimed): EventStore
 * persistence (the fold runs on the adapter's in-memory events, not rows
 * read back from `append`/`list`), target resolution and read-authority
 * routing inside `loadDelegatedTask`, and the CLI's human-output rendering
 * (pinned by `packages/cli/src/__tests__/delegate.test.ts` against a
 * field-identical reason — this test asserts those exact field values on
 * the served object).
 */

const QUOTA_MESSAGE =
  'quota: Usage limit reached for 5 hour. Your limit will reset at 2026-09-21 18:55:29';

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

async function nextEvent(
  iterator: AsyncIterator<CanonicalRuntimeEvent>,
  label: string,
): Promise<CanonicalRuntimeEvent> {
  const result = await Promise.race([
    iterator.next(),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Timed out waiting for ${label}`)),
        2000,
      ),
    ),
  ]);
  if (result.done || !result.value) {
    throw new Error(`Iterator closed while waiting for ${label}`);
  }
  return result.value;
}

let servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  servers = [];
});

describe('delegation provider-plan quota connected projection (#2265)', () => {
  test('a fake ACP quota rejection reaches the SDK as an actionable reason and event', async () => {
    const threadId = 'task:quota-connected';
    const stubs: QuotaStubProcess[] = [];
    const adapter = new AcpAdapter({
      getConnections: async () => [
        {
          id: 'kiro',
          name: 'Kiro',
          command: 'kiro-cli',
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
    try {
      const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
      await adapter.startSession({
        provider: 'acp',
        threadId,
        cwd: '/tmp/project',
        metadata: { connectionId: 'kiro' },
      });
      const sessionStarted = await nextEvent(iterator, 'session.started');
      const sessionConfigured = await nextEvent(iterator, 'session.configured');
      const turn = await adapter.sendTurn({
        threadId,
        input: 'do the thing',
      });
      const turnStarted = await nextEvent(iterator, 'turn.started');
      // The genuine SDK wrapper around the synthetic quota shape — the
      // same rejection the unit seam tests classify.
      stubs[0].failPrompt(new RequestError(-32603, QUOTA_MESSAGE));
      const terminal = await nextEvent(iterator, 'runtime.error');

      // The terminal seam names the failed turn and carries ONLY fixed
      // copy plus bounded details — the raw provider sentence is gone at
      // the source, so nothing downstream can leak it.
      expect(terminal).toMatchObject({
        method: 'runtime.error',
        turnId: turn.turnId,
        code: 'provider-plan-quota-exhausted',
        message:
          'The provider plan quota was exhausted; the engine refused the turn.',
        details: {
          quotaWindow: '5 hour',
          resetReported: '2026-09-21 18:55:29',
          resetPrecision: 'unqualified',
        },
      });
      expect(JSON.stringify(terminal)).not.toContain('Usage limit');

      // Canonical write-time normalize, threaded exactly as
      // `consumeAdapterEvents` does (previous state plus the stored-row
      // turn-identity anchor), then the read fold over the adapter's own
      // session record — the composition the persisted summary carries.
      const ordered = [
        sessionStarted,
        sessionConfigured,
        turnStarted,
        terminal,
      ];
      let previousState: SessionLifecycleState | undefined;
      const stored: CanonicalRuntimeEvent[] = [];
      const normalized: CanonicalRuntimeEvent[] = [];
      for (const event of ordered) {
        const anchor = turnIdentityAnchorForEvents(stored);
        const next = normalizeCanonicalRuntimeEventLifecycle(
          event,
          previousState,
          anchor,
        );
        previousState = next.sessionState ?? previousState;
        stored.push(next);
        normalized.push(next);
      }

      const [adapterSession] = await adapter.listSessions();
      const projection = projectSessionLifecycle({
        session: adapterSession,
        events: normalized,
      });
      expect(projection.lifecycleState).toBe('failed');
      // The fold's own notice carries the wait/check/reset guidance —
      // the UI surfaces render this with no raw text.
      expect(projection.terminalAttribution?.kind).toBe('runtime_error');
      expect(projection.terminalAttribution?.detail).toContain('5 hour');
      expect(projection.terminalAttribution?.detail).toContain(
        '2026-09-21 18:55:29',
      );

      // The serving composition: the persisted summary (adapter record +
      // fold outputs) plus the stored event rows, as `loadDelegatedTask`
      // hands them to the projections.
      const sessionRecord = {
        ...(adapterSession as unknown as Record<string, unknown>),
        lifecycleState: projection.lifecycleState,
        ...(projection.terminalAttribution
          ? {
              terminalAttribution: {
                ...(projection.terminalAttribution as unknown as Record<
                  string,
                  unknown
                >),
              },
            }
          : {}),
      };
      const eventRecords = normalized as unknown as Array<
        Record<string, unknown>
      >;
      const target = {
        apiBase: 'http://current.invalid',
        environmentId: 'environment-current',
        environmentName: 'Current environment',
        kind: 'current' as const,
      };
      const metadata = {
        taskId: threadId,
        conversationId: threadId,
        targetKind: 'agent',
        targetId: 'helper',
      };
      const snapshot = snapshotFor({
        target,
        detail: { session: sessionRecord, events: eventRecords },
        metadata,
      });
      expect(snapshot.status).toBe('failed');
      expect(snapshot.resumable).toBe(true);
      expect(snapshot.reason?.code).toBe('provider-plan-quota-exhausted');
      expect(snapshot.reason).toMatchObject({
        quotaWindow: '5 hour',
        resetReported: '2026-09-21 18:55:29',
      });
      // The exact field values the CLI suite pins rendering from — the
      // served reason and the CLI-tested fixture agree field for field.
      expect(snapshot.reason?.detail).toBe(
        'The provider plan quota was exhausted (5 hour window). The provider reported the limit resets at 2026-09-21 18:55:29 (provider-reported time, no timezone given) — wait for the reset or check the provider plan, then continue explicitly. Station did not retry, switch models or providers, or spend on a fallback.',
      );
      const projected = eventRecords.map((event, index) =>
        projectDelegatedTaskEvent(index + 1, event),
      );
      const quotaEvent = projected.find(
        (event) => event.method === 'runtime.error',
      );
      expect(quotaEvent).toMatchObject({
        kind: 'runtime',
        severity: 'error',
        quotaWindow: '5 hour',
        resetReported: '2026-09-21 18:55:29',
      });
      expect(quotaEvent?.text).toContain('2026-09-21 18:55:29');

      // Serve the REAL serving outputs over HTTP and read them back
      // through the REAL SDK carrier (fetch + envelope unwrap + identity
      // normalize) — a drop anywhere in that carrier fails here.
      const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const statusMatch = url.pathname.match(
          /^\/api\/orchestration\/delegations\/([^/]+)$/,
        );
        const eventsMatch = url.pathname.match(
          /^\/api\/orchestration\/delegations\/([^/]+)\/events$/,
        );
        const payload = (data: unknown) =>
          res
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify({ success: true, data }));
        if (req.method === 'GET' && statusMatch) {
          payload(snapshot);
          return;
        }
        if (req.method === 'GET' && eventsMatch) {
          payload({
            conversationId: snapshot.conversationId,
            taskId: snapshot.taskId,
            sessionId: snapshot.sessionId,
            currentSessionId: snapshot.currentSessionId,
            status: snapshot.status,
            environment: snapshot.environment,
            target: snapshot.target,
            eventCount: projected.length,
            events: projected,
            nextCursor: `station-task-events:v1:${projected.length}`,
            hasMore: false,
            canInterrupt: false,
            resumable: snapshot.resumable,
          });
          return;
        }
        res.writeHead(400).end('{}');
      });
      servers.push(server);
      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve());
      });
      const apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

      const served = await observeDelegatedTask(apiBase, threadId);
      expect(served.status).toBe('failed');
      expect(served.reason).toMatchObject({
        code: 'provider-plan-quota-exhausted',
        quotaWindow: '5 hour',
        resetReported: '2026-09-21 18:55:29',
      });
      expect(served.reason?.detail).toContain('wait for the reset');
      expect(JSON.stringify(served)).not.toContain('Usage limit');

      const page = await observeDelegatedTaskEvents(apiBase, threadId);
      const servedQuota = page.events.find(
        (event) => event.method === 'runtime.error',
      );
      expect(servedQuota).toMatchObject({
        kind: 'runtime',
        quotaWindow: '5 hour',
        resetReported: '2026-09-21 18:55:29',
      });
      expect(servedQuota?.text).toContain('2026-09-21 18:55:29');
      expect(servedQuota?.text).not.toContain('Usage limit');
    } finally {
      await adapter.stopAll();
    }
  });
});
