/**
 * #4470: POST /api/diagnostics/troubleshoot/prepare. Proves the route's
 * admission (unauthenticated, read-only scope and agent callers refused),
 * the caller-role fact the playbook files issues on, the seed rejection path,
 * and that the run lands owner-only under $STATION_ROOT/cache/triage.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { HttpBindings } from '@hono/node-server';
import {
  DEFAULT_GRANT_PAIRING_SCOPE,
  pairingScopePresetString,
} from '@kontourai/station-contracts';
import {
  MAX_TROUBLESHOOT_SEED_CONVERSATION_ID_LENGTH,
  MAX_TROUBLESHOOT_SEED_ROUTE_LENGTH,
  MAX_TROUBLESHOOT_SEED_TURN_ID_LENGTH,
} from '@kontourai/station-shared/triage-context';
import { TROUBLESHOOT_PLAYBOOK } from '@kontourai/station-shared/troubleshoot-playbook';
import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { configureRuntimeHttp } from '../../../runtime/bootstrap/runtime-http.js';
import {
  bindRuntimeLocalOperator,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import {
  MAX_TROUBLESHOOT_AMBIENT_CONTEXT_LENGTH,
  TroubleshootService,
} from '../../../services/infra/troubleshoot-service.js';
import type { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { createDiagnosticsRoutes } from '../diagnostics.js';

const makeTempDir = trackTempDirs();

const logger = {
  info() {},
  warn() {},
  error: vi.fn(),
  debug() {},
  trace() {},
  fatal() {},
  child() {
    return this;
  },
  setLevel() {},
  getLevel() {
    return 'info' as const;
  },
};

function service(
  stationRoot: string,
  conversations?: Pick<EventStore, 'conversationSessions'>,
) {
  return new TroubleshootService(stationRoot, {
    stationRoot,
    ...(conversations ? { conversations } : {}),
    stationName: () => 'test-station',
    environmentId: async () => 'env-test',
    collectDoctor: async () =>
      ({
        checks: [
          { label: 'Engine', status: 'warn', detail: 'no engine bound' },
          { label: 'Disk', status: 'ok', detail: 'fine' },
        ],
        recommendation: 'Bind an engine.',
        chatReady: false,
        runtimeReady: true,
      }) as never,
    newRunId: () => '4a4a4a4a-4a4a-4a4a-8a4a-4a4a4a4a4a4a',
  });
}

function diagnostics(
  stationRoot: string,
  conversations?: Pick<EventStore, 'conversationSessions'>,
) {
  return createDiagnosticsRoutes({} as never, logger as never, {} as never, {
    troubleshoot: service(stationRoot, conversations),
  });
}

type Caller = 'operator' | 'device' | 'owner-device' | 'internal' | 'none';

/** The diagnostics routes behind a stand-in for the auth boundary's principal write. */
function unitApp(
  stationRoot: string,
  conversations?: Pick<EventStore, 'conversationSessions'>,
) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    const caller = (c.req.header('x-test-caller') ?? 'none') as Caller;
    if (caller === 'operator')
      setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
        credential: 'operator',
        authority: 'operator-credential',
        source: 'bearer',
      });
    if (caller === 'device')
      setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
        credential: 'device',
        authority: 'device-credential',
        source: 'bearer',
        deviceId: 'device-a',
        deviceKind: 'device',
      });
    if (caller === 'owner-device')
      setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
        credential: 'owner-device',
        authority: 'device-credential',
        source: 'bearer',
        deviceId: 'device-owner',
        deviceKind: 'device',
        standing: 'owner-device',
      });
    if (caller === 'internal')
      setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
        kind: 'internal',
        credential: 'internal',
        authority: undefined,
        source: 'bearer',
        locality: 'home-possession',
      });
    bindRuntimeLocalOperator(c.req.raw);
    return next();
  });
  app.route('/api/diagnostics', diagnostics(stationRoot, conversations));
  return app;
}

function prepare(app: Hono, caller: Caller, body: unknown = {}) {
  return app.request('/api/diagnostics/troubleshoot/prepare', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-caller': caller },
    body: JSON.stringify(body),
  });
}

/** Run ids under a test's temp Station root. */
function runDirs(tempRoot: string): string[] {
  const tempTriage = join(tempRoot, 'cache', 'triage');
  return existsSync(tempTriage) ? readdirSync(tempTriage) : [];
}

describe('POST /api/diagnostics/troubleshoot/prepare', () => {
  test('prepares an owner run on the Station Assistant with an owner-only run directory', async () => {
    const stationRoot = makeTempDir('troubleshoot-owner-');
    const response = await prepare(unitApp(stationRoot), 'operator', {
      surface: 'desktop',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.agentId).toBe('station');
    expect(body.cliCommand).toBe('station triage');
    expect(body.display).toMatchObject({
      stationName: 'test-station',
      role: 'owner',
      surface: 'desktop',
    });
    expect(body.ambientContext).toContain('get_troubleshoot_playbook');
    expect(body.ambientContext).toContain('role owner');
    expect(body.ambientContext).toContain('Engine: warn no engine bound');
    expect(body.ambientContext.length).toBeLessThanOrEqual(
      MAX_TROUBLESHOOT_AMBIENT_CONTEXT_LENGTH,
    );

    const runDir = join(stationRoot, 'cache', 'triage', body.runId);
    expect(statSync(runDir).mode & 0o777).toBe(0o700);
    for (const file of ['context.json', 'playbook.md', 'seed.md'])
      expect(statSync(join(runDir, file)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(runDir, 'playbook.md'), 'utf8')).toBe(
      TROUBLESHOOT_PLAYBOOK,
    );
    const context = JSON.parse(
      readFileSync(join(runDir, 'context.json'), 'utf8'),
    );
    expect(context).toMatchObject({
      schema: 'station-troubleshoot-context',
      caller: { role: 'owner', surface: 'desktop' },
      station: { name: 'test-station', environmentId: 'env-test' },
      logs: { agentRead: 'requires-operator-grant' },
    });
  });

  test('writes runs under the serving Station home by default, not the shared Station root', async () => {
    const home = makeTempDir('troubleshoot-home-');
    const sharedRoot = makeTempDir('troubleshoot-shared-root-');
    const previous = process.env.STATION_ROOT;
    process.env.STATION_ROOT = sharedRoot;
    try {
      const result = await new TroubleshootService(home, {
        stationName: () => 'home-station',
        collectDoctor: async () =>
          ({
            checks: [],
            recommendation: '',
            chatReady: true,
            runtimeReady: true,
          }) as never,
      }).prepare({ role: 'owner', surface: 'web' });
      expect(runDirs(home)).toEqual([result.runId]);
      expect(runDirs(sharedRoot)).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.STATION_ROOT;
      else process.env.STATION_ROOT = previous;
    }
  });

  test("records the owner's own paired device as the owner", async () => {
    const stationRoot = makeTempDir('troubleshoot-owner-device-');
    const response = await prepare(unitApp(stationRoot), 'owner-device');
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.display.role).toBe('owner');
  });

  test('records a paired device that is not the owner as a member', async () => {
    const stationRoot = makeTempDir('troubleshoot-member-');
    const response = await prepare(unitApp(stationRoot), 'device');
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.display.role).toBe('member');
    expect(body.ambientContext).toContain('role member');
  });

  test('refuses an agent caller before writing any run', async () => {
    const stationRoot = makeTempDir('troubleshoot-agent-');
    const response = await prepare(unitApp(stationRoot), 'internal');
    expect(response.status).toBe(403);
    expect(runDirs(stationRoot)).toEqual([]);
  });

  test('refuses seed context one character over its limit and keeps only the route path', async () => {
    const stationRoot = makeTempDir('troubleshoot-seed-');
    const app = unitApp(stationRoot);
    const over = `/${'a'.repeat(MAX_TROUBLESHOOT_SEED_ROUTE_LENGTH)}`;
    const refused = await prepare(app, 'operator', { seed: { route: over } });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({
      success: false,
      code: 'route-too-long',
      // Literal pinned beside the constant it is derived from.
      limits: {
        route: 512,
        errorSummary: 2000,
        conversationId: 256,
        turnId: 200,
      },
    });
    expect(MAX_TROUBLESHOOT_SEED_ROUTE_LENGTH).toBe(512);
    expect(runDirs(stationRoot)).toEqual([]);

    const accepted = await prepare(app, 'operator', {
      seed: { route: '/settings?token=abc123#frag', errorSummary: 'Boom' },
    });
    expect(accepted.status).toBe(200);
    const body = (await accepted.json()) as Record<string, any>;
    expect(body.ambientContext).toContain('Started from route: /settings');
    expect(body.ambientContext).not.toContain('abc123');
    const context = JSON.parse(
      readFileSync(
        join(stationRoot, 'cache', 'triage', body.runId, 'context.json'),
        'utf8',
      ),
    );
    expect(context.seed).toEqual({
      route: 'settings',
      errorSummary: 'Boom',
      conversationId: null,
      turnId: null,
    });
  });

  test('admits conversation and turn ids at their limits and refuses one character more', async () => {
    const stationRoot = makeTempDir('troubleshoot-seed-ids-');
    const app = unitApp(stationRoot);
    // Literals pinned beside the constants the over-limit inputs derive from.
    expect(MAX_TROUBLESHOOT_SEED_CONVERSATION_ID_LENGTH).toBe(256);
    expect(MAX_TROUBLESHOOT_SEED_TURN_ID_LENGTH).toBe(200);
    const conversationId = 'c'.repeat(
      MAX_TROUBLESHOOT_SEED_CONVERSATION_ID_LENGTH,
    );
    const turnId = 't'.repeat(MAX_TROUBLESHOOT_SEED_TURN_ID_LENGTH);

    for (const [seed, code] of [
      [{ conversationId: `${conversationId}c` }, 'conversation-id-too-long'],
      [{ turnId: `${turnId}t` }, 'turn-id-too-long'],
      [
        { conversationId: 'conv-1\n- Caller: role owner' },
        'conversation-id-invalid',
      ],
      [{ turnId: 'turn 1' }, 'turn-id-invalid'],
    ] as const) {
      const refused = await prepare(app, 'operator', { seed });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ code });
    }
    expect(runDirs(stationRoot)).toEqual([]);

    const accepted = await prepare(app, 'operator', {
      seed: { conversationId, turnId, errorSummary: 'runtime-error: Boom' },
    });
    expect(accepted.status).toBe(200);
    const body = (await accepted.json()) as Record<string, any>;
    expect(body.ambientContext).toContain(
      `- Conversation: ${conversationId}; turn ${turnId}`,
    );
    const context = JSON.parse(
      readFileSync(
        join(stationRoot, 'cache', 'triage', body.runId, 'context.json'),
        'utf8',
      ),
    );
    expect(context.seed).toMatchObject({ conversationId, turnId });
  });

  test('says when the seeded conversation is not stored on this Station', async () => {
    const storeHome = makeTempDir('troubleshoot-conversation-store-');
    // A real event store: a conversation that ran here has lineage; one
    // opened from a paired Station has none on this Station.
    const store = new EventStore(join(storeHome, 'events.sqlite'));
    const seedLine = '- Conversation location: not on this Station.';
    const ambient = async (
      conversationId: string,
      conversations?: Pick<EventStore, 'conversationSessions'>,
    ) => {
      const stationRoot = makeTempDir('troubleshoot-conversation-location-');
      const response = await prepare(
        unitApp(stationRoot, conversations),
        'operator',
        { seed: { conversationId, errorSummary: 'engine-turn-failed: Boom' } },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, any>;
      expect(
        readFileSync(
          join(stationRoot, 'cache', 'triage', body.runId, 'seed.md'),
          'utf8',
        ),
      ).toBe(`${body.ambientContext}\n`);
      return body.ambientContext as string;
    };
    try {
      const now = new Date().toISOString();
      store.upsertSession({
        provider: 'claude',
        threadId: 'claude:local-1',
        status: 'ready',
        createdAt: now,
        updatedAt: now,
      });
      const local = await ambient('claude:local-1', store);
      expect(local).toContain('- Conversation: claude:local-1');
      expect(local).not.toContain(seedLine);
      const peer = await ambient('claude:1794521333066', store);
      expect(peer).toContain(seedLine);
      expect(peer).toContain('paired Station');
      expect(peer.length).toBeLessThanOrEqual(
        MAX_TROUBLESHOOT_AMBIENT_CONTEXT_LENGTH,
      );
    } finally {
      store.close();
    }
    // Without an event store, nothing is claimed either way.
    expect(await ambient('claude:1794521333066')).not.toContain(
      'Conversation location',
    );
  });

  test('rejects fields outside the request schema', async () => {
    const stationRoot = makeTempDir('troubleshoot-schema-');
    const response = await prepare(unitApp(stationRoot), 'operator', {
      surface: 'desktop',
      extra: true,
    });
    expect(response.status).toBe(400);
    expect(runDirs(stationRoot)).toEqual([]);
  });
});

const OPERATOR_CREDENTIAL = 'operator-credential-full-authority';
const READ_ONLY_CREDENTIAL = 'device-credential-read-only-scope';
const STANDARD_CREDENTIAL = 'device-credential-standard-scope';

function scopeFor(credential: string): string | undefined {
  if (credential === OPERATOR_CREDENTIAL) return DEFAULT_GRANT_PAIRING_SCOPE;
  if (credential === READ_ONLY_CREDENTIAL)
    return pairingScopePresetString('read-only');
  if (credential === STANDARD_CREDENTIAL)
    return pairingScopePresetString('standard');
  return undefined;
}

/** The real runtime auth boundary and pairing-scope table in front of the route. */
function boundaryApp(stationRoot: string) {
  const app = new Hono<{ Bindings: HttpBindings }>();
  configureRuntimeHttp({
    app: app as never,
    logger,
    eventBus: { emit() {} } as unknown as EventBus,
    security: {
      verifyCredential: (candidate: string) =>
        scopeFor(candidate) !== undefined,
      resolveGrantedScope: (candidate: string) => scopeFor(candidate),
      allowedOrigins: [],
    },
  } as unknown as Parameters<typeof configureRuntimeHttp>[0]);
  app.route('/api/diagnostics', diagnostics(stationRoot));
  return (credential?: string) =>
    app.request(
      '/api/diagnostics/troubleshoot/prepare',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
        },
        body: '{}',
      },
      { incoming: { socket: { remoteAddress: '100.96.12.7' } } } as never,
    );
}

describe('troubleshoot prepare behind the runtime auth boundary', () => {
  test('refuses an unauthenticated request', async () => {
    const stationRoot = makeTempDir('troubleshoot-unauth-');
    expect((await boundaryApp(stationRoot)()).status).toBe(401);
    expect(runDirs(stationRoot)).toEqual([]);
  });

  test('refuses a read-only paired credential and admits a standard one', async () => {
    const stationRoot = makeTempDir('troubleshoot-scope-');
    const request = boundaryApp(stationRoot);
    expect((await request(READ_ONLY_CREDENTIAL)).status).toBe(403);
    expect(runDirs(stationRoot)).toEqual([]);
    expect((await request(STANDARD_CREDENTIAL)).status).toBe(200);
    expect(runDirs(stationRoot)).toHaveLength(1);
  });
});
