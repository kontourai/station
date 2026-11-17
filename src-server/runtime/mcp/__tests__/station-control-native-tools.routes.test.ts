/**
 * #2377 slice D (decision 4): Station's own engine calls station-control as
 * its session, in-process, with a `bound` caller whose principal is the
 * session's recorded owner — the same delivery in-process Claude has.
 *
 * Real pieces end to end: the StationAgentAdapter session lifecycle, the
 * OrchestrationService ownership record and the production caller-record
 * composition (`stationControlCallerRecordSources`), the per-session
 * in-process server serving the real station-control registrations, the
 * tools' own `api()` loopback, the runtime auth boundary, the authority
 * guard and the policy table. Nothing stamps a caller header by hand.
 */

import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { StationAgentAdapter } from '../../../providers/adapters/station-agent-adapter.js';
import { createStationControlAuthorityGuard } from '../../../security/station-control-authority-guard.js';
import { stationControlRequestAuthority } from '../../../security/station-control-request-authority.js';
import { __resetStationServerSelfAttestationForTests } from '../../../security/station-server-scope.js';
import { ApprovalRegistry } from '../../../services/approvals/approval-registry.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import {
  __resetStationControlStdioEntryForTests,
  setRuntimeControlApiBase,
} from '../../../tools/station-control-shared.js';
import type { Logger } from '../../../utils/logger.js';
import { configureRuntimeHttp } from '../../bootstrap/runtime-http.js';
import { runWithAuthorizedTurnCorrelation } from '../../conversation/authorized-turn-correlation.js';
import {
  createStationControlCallerRecordResolver,
  resolveStationControlCallerForRequest,
  type StationControlCallerRecordResolver,
  stationControlCallerRecordSources,
} from '../station-control-caller.js';
import { __resetStationControlMcpTokensForTests } from '../station-control-mcp-token.js';
import {
  __resetNativeStationControlForTests,
  callNativeStationControlTool,
} from '../station-control-native-tools.js';

const makeTempDir = trackTempDirs();
const OTHER = 'human:test:account-b';
let server: ReturnType<typeof serve>;
let resolveRecord: StationControlCallerRecordResolver | undefined;
const seen: Array<{
  path: string;
  authority: ReturnType<typeof stationControlRequestAuthority>;
}> = [];

beforeAll(async () => {
  __resetStationServerSelfAttestationForTests();
  __resetStationControlStdioEntryForTests();
  const app = new Hono();
  configureRuntimeHttp({
    app: app as never,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger,
    eventBus: { emit: vi.fn() } as unknown as EventBus,
    security: {
      verifyCredential: () => false,
      resolveGrantedScope: () => undefined,
      now: () => Date.now(),
      maxFailures: 100,
      windowMs: 60_000,
      audit: () => {},
      allowedOrigins: [],
    },
  } as Parameters<typeof configureRuntimeHttp>[0]);
  app.use(
    '*',
    createStationControlAuthorityGuard({
      resolveCaller: (request) =>
        resolveStationControlCallerForRequest(request, (id) =>
          resolveRecord?.(id),
        ),
      isOperatorPrincipal: (id) => id === LOCAL_OPERATOR_PRINCIPAL_ID,
    }),
  );
  const record = (c: any) => {
    seen.push({
      path: c.req.path,
      authority: stationControlRequestAuthority(c.req.raw),
    });
    return c.json({ success: true, data: [] });
  };
  // `list_agents` (a read anyone verified may make) and `update_config`
  // (a Station-wide mutation only a bound operator caller may make).
  app.get('/agents', record);
  app.put('/config/app', record);
  let resolvePort!: (value: number) => void;
  const listening = new Promise<number>((done) => {
    resolvePort = done;
  });
  server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (info) =>
    resolvePort((info as AddressInfo).port),
  );
  setRuntimeControlApiBase(await listening);
});

afterAll(async () => {
  setRuntimeControlApiBase(undefined);
  await new Promise<void>((done) => server.close(() => done()));
  await __resetNativeStationControlForTests();
  __resetStationControlMcpTokensForTests();
  __resetStationServerSelfAttestationForTests();
});

function parsed(result: unknown): { success?: boolean; code?: string } {
  const text = (result as { content?: { text?: string }[] }).content?.[0]?.text;
  return JSON.parse(text ?? '{}');
}

function asTurn<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
  return runWithAuthorizedTurnCorrelation(
    {
      accountId: 'account',
      sessionId,
      turnId: `${sessionId}:turn`,
      correlationId: `${sessionId}:correlation`,
    },
    work,
  );
}

test("Station's engine calls station-control as its session's bound, owner-attributed caller", async () => {
  const home = makeTempDir('station-native-control-');
  const eventBus = new EventBus();
  const eventStore = new EventStore(join(home, 'events.sqlite'));
  const adapter = new StationAgentAdapter({
    apiBase: 'http://127.0.0.1:1',
    hasAgent: () => true,
    eventBus,
    approvalRegistry: new ApprovalRegistry(
      { info: vi.fn(), warn: vi.fn() },
      { eventBus },
    ),
    stationControlCallerRecords: () => resolveRecord,
    fetch: vi.fn<typeof fetch>(),
  });
  const service = new OrchestrationService({
    adapterRegistry: {
      register() {},
      get: (provider: string) =>
        provider === 'station-agent' ? adapter : undefined,
      list: () => [adapter],
    },
    eventBus,
    eventStore,
    logger: { debug: vi.fn(), warn: vi.fn() },
  } as never);
  // The production composition the runtime gives the adapter.
  resolveRecord = createStationControlCallerRecordResolver(
    stationControlCallerRecordSources({
      orchestrationService: service,
      eventStore,
      getProject: () => {
        throw new Error('no projects');
      },
      coordinatorEnabled: () => false,
    }),
  );
  const start = async (threadId: string, owner: string) => {
    await service.dispatch(
      {
        type: 'startSession',
        input: {
          threadId,
          provider: 'station-agent',
          cwd: home,
          // The owner the dispatch route stamps from the authenticated
          // caller (`metadata.userId`), the session's ownership record.
          metadata: { agentId: 'station', agentSlug: 'station', userId: owner },
        },
      },
      { userId: owner },
      {
        conversationIdentity: {
          conversationId: threadId,
          environmentId: 'local-environment',
        },
      },
    );
  };
  try {
    await start('operator-session', LOCAL_OPERATOR_PRINCIPAL_ID);
    await start('member-session', OTHER);
    // The control: the ownership record names each session's owner.
    await vi.waitFor(() => {
      expect(
        service.resolveSessionActingPrincipal('operator-session')?.id,
      ).toBe(LOCAL_OPERATOR_PRINCIPAL_ID);
      expect(service.resolveSessionActingPrincipal('member-session')?.id).toBe(
        OTHER,
      );
    });

    const read = await asTurn('operator-session', () =>
      callNativeStationControlTool('list_agents', {}),
    );
    expect(parsed(read)).toEqual({ success: true, data: [] });
    expect(seen.at(-1)).toMatchObject({
      path: '/agents',
      authority: {
        kind: 'caller',
        boundOperator: true,
        caller: {
          sessionId: 'operator-session',
          assurance: 'bound',
          principal: { id: LOCAL_OPERATOR_PRINCIPAL_ID },
        },
      },
    });
    // A bound operator caller may make a Station-wide mutation.
    const write = await asTurn('operator-session', () =>
      callNativeStationControlTool('update_config', {
        updates: { theme: 'dark' },
      }),
    );
    expect(parsed(write)).toEqual({ success: true, data: [] });
    expect(seen.at(-1)?.path).toBe('/config/app');

    // Another person's session reads as that person, and may not.
    const memberRead = await asTurn('member-session', () =>
      callNativeStationControlTool('list_agents', {}),
    );
    expect(parsed(memberRead)).toEqual({ success: true, data: [] });
    expect(seen.at(-1)).toMatchObject({
      authority: {
        kind: 'caller',
        boundOperator: false,
        caller: {
          sessionId: 'member-session',
          assurance: 'bound',
          principal: { id: OTHER },
        },
      },
    });
    const before = seen.length;
    const memberWrite = await asTurn('member-session', () =>
      callNativeStationControlTool('update_config', {
        updates: { theme: 'dark' },
      }),
    );
    expect(parsed(memberWrite)).toMatchObject({
      success: false,
      code: 'station_control_role_required',
    });

    // No authorized turn: a sessionless run acts for no one.
    expect(
      parsed(await callNativeStationControlTool('list_agents', {})),
    ).toMatchObject({
      success: false,
      code: 'station_control_caller_required',
    });
    // A stopped session's credential and server are gone.
    await adapter.stopSession('operator-session');
    expect(
      parsed(
        await asTurn('operator-session', () =>
          callNativeStationControlTool('list_agents', {}),
        ),
      ),
    ).toMatchObject({
      success: false,
      code: 'station_control_caller_required',
    });
    // None of the refused calls reached a route.
    expect(seen).toHaveLength(before);
  } finally {
    await service.shutdown();
    eventStore.close();
  }
});
