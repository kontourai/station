/**
 * #2377 slice D hardening: a dispatch route handler runs in the server scope
 * (`runAsStationServer`) so its request-prep hops pass the authority guard as
 * Station's own code. The engine session and turn it starts must NOT inherit
 * that scope: an in-process, agent-driven `api()` call made during the turn
 * (outside the station-control tool wrapper) must reach the guard without the
 * server-self attestation.
 *
 * Real pieces: the runtime auth boundary, the authority guard, the
 * station-control `api()` every tool uses, and the OrchestrationService
 * start/send seams. The engine is a scripted adapter that calls `api()` from
 * inside its own session start and turn, both synchronously and from a later
 * task (the engine's own async lifetime).
 */

import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import type {
  ProviderSendTurnInput,
  ProviderSessionStartInput,
} from '@kontourai/station-contracts/provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { Hono } from 'hono';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import {
  continuityRegistry,
  TerminalHandoffAdapter,
} from '../../__test-utils__/scripted-continuity-adapter.js';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { configureRuntimeHttp } from '../../runtime/bootstrap/runtime-http.js';
import { resolveStationControlCallerForRequest } from '../../runtime/mcp/station-control-caller.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../services/identity/principal-resolver.js';
import { EventBus } from '../../services/orchestration/event-bus.js';
import { EventStore } from '../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../services/orchestration/orchestration-service.js';
import { createSessionAgentResolver } from '../../services/orchestration/session-agent-resolution.js';
import {
  __resetStationControlStdioEntryForTests,
  api,
  setRuntimeControlApiBase,
} from '../../tools/station-control-shared.js';
import type { Logger } from '../../utils/logger.js';
import { createStationControlAuthorityGuard } from '../station-control-authority-guard.js';
import {
  __resetStationServerSelfAttestationForTests,
  runAsStationServer,
} from '../station-server-scope.js';

type Outcome = { success?: boolean; code?: string };
const OWNER = 'account-a';
const makeTempDir = trackTempDirs();
let server: ReturnType<typeof serve>;

/** A write no table entry admits caller-less: only server code passes. */
const probe = () =>
  api('/config/app', {
    method: 'PUT',
    body: JSON.stringify({ theme: 'dark' }),
  }) as Promise<Outcome>;

/** The engine calls `api()` itself, now and from a later task. */
class ProbingAdapter extends TerminalHandoffAdapter {
  readonly probes: Promise<Outcome>[] = [];
  private later(): void {
    this.probes.push(
      new Promise<Outcome>((done) => {
        setTimeout(() => void probe().then(done), 5);
      }),
    );
  }
  override async startSession(input: ProviderSessionStartInput) {
    this.probes.push(probe());
    this.later();
    return super.startSession(input);
  }
  override async sendTurn(input: ProviderSendTurnInput) {
    this.probes.push(probe());
    this.later();
    return super.sendTurn(input);
  }
}

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
        resolveStationControlCallerForRequest(request),
      isOperatorPrincipal: (id) => id === LOCAL_OPERATOR_PRINCIPAL_ID,
    }),
  );
  app.put('/config/app', (c) => c.json({ success: true }));
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
  __resetStationServerSelfAttestationForTests();
});

test('a session and turn started from a server-scoped route do not inherit the scope; the route hops keep it', async () => {
  const home = makeTempDir('station-engine-scope-');
  const store = new EventStore(join(home, 'events.sqlite'));
  const engine = new ProbingAdapter('claude');
  const service = new OrchestrationService({
    eventStore: store,
    eventBus: new EventBus(),
    adapterRegistry: continuityRegistry([engine]),
    logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    resolveSessionAgent: createSessionAgentResolver({
      loadAgentSpec: async (slug) => ({
        name: slug,
        prompt: `Instructions for ${slug}`,
        skills: [],
        tools: { mcpServers: [] },
      }),
      resolveToolServer: async () => null,
      resolveSkillDir: async () => null,
    }),
  } as never);
  try {
    // What a wrapped dispatch route does: request-prep hops, then the
    // engine start and turn, then more hops — all inside the server scope.
    const hops = await runAsStationServer(async () => {
      const before = await probe();
      await service.dispatch(
        {
          type: 'startSession',
          input: {
            threadId: 'engine-scope',
            provider: 'claude',
            cwd: home,
            metadata: { agentSlug: 'claude' },
          },
        },
        { userId: OWNER },
        {
          conversationIdentity: {
            conversationId: 'engine-scope',
            environmentId: 'local-environment',
          },
        },
      );
      // The owner record a real start stamps from the authenticated caller.
      store.appendEvent({
        eventId: 'owner',
        provider: 'claude',
        threadId: 'engine-scope',
        createdAt: new Date().toISOString(),
        method: 'session.configured',
        sessionId: 'engine-scope',
        metadata: { userId: OWNER, agentSlug: 'claude' },
      } as CanonicalRuntimeEvent);
      await service.dispatch(
        {
          type: 'sendTurn',
          input: { threadId: 'engine-scope', input: 'work' },
        },
        { userId: OWNER },
      );
      const after = await probe();
      return { before, after };
    });
    // The control: the route's own hops pass as server code.
    expect(hops.before).toEqual({ success: true });
    expect(hops.after).toEqual({ success: true });
    // Two at start, two in the turn, each now and later.
    expect(engine.probes).toHaveLength(4);
    for (const outcome of await Promise.all(engine.probes))
      expect(outcome).toMatchObject({
        success: false,
        code: 'station_control_caller_required',
      });
  } finally {
    // Never let a pending probe outlive the test's API base.
    await Promise.allSettled(engine.probes);
    await service.shutdown();
    store.close();
  }
});
