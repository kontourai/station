import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseHostedTenantRegistry } from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import ts from 'typescript-api';
import { describe, expect, test, vi } from 'vitest';
import { readStreamUntil } from '../../__test-utils__/sse-helpers.js';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { createOrchestrationRoutes } from '../../routes/orchestration/orchestration.js';
import { HOSTED_TENANT_REGISTRY_FILE_ENV } from '../../runtime/bootstrap/hosted-tenant-mode.js';
import { configureRuntimePublicRoutes } from '../../runtime/routes/runtime-routes.js';
import { EnvironmentSecurityService } from '../../services/ssh/environment-security-service.js';

const makeTempDir = trackTempDirs();
const REPO_ROOT = resolve(__dirname, '../../..');

const REGISTRY = {
  schemaVersion: 1,
  tenants: [{ id: 'alpha', authority: 'alpha.example.test' }],
};

type Deployment = { hosted: boolean };

/** The real orchestration routes for one deployment mode, over a stub owner. */
function orchestrationRoutes(
  { hosted }: Deployment,
  service: Record<string, unknown>,
) {
  return createOrchestrationRoutes(
    service as never,
    {
      eventBus: { subscribe: () => () => {} },
      logger: { debug: vi.fn() },
      getUserId: () => 'owner',
      isRequestPrincipalCurrent: () => true,
      ...(hosted
        ? { hostedTenantRegistry: parseHostedTenantRegistry(REGISTRY) }
        : {}),
    } as never,
  );
}

/**
 * Every handshake flag a client gates on (`hasCapability` in packages/sdk or
 * src-ui), with a probe that asks the real route whether it serves that
 * feature in a deployment mode, given an owner that would grant the request.
 * The coverage test below fails when a client gates on a flag missing here.
 */
const CONSUMED_FLAGS: Record<
  string,
  (deployment: Deployment) => Promise<boolean>
> = {
  // GET /sessions/:threadId/event-window answers a bounded window.
  sessionEventWindow: async (deployment) => {
    const routes = orchestrationRoutes(deployment, {
      readSessionEventWindow: vi.fn(async () => ({ events: [], turns: [] })),
    });
    const response = await routes.request(
      '/sessions/session-a/event-window?turnLimit=1',
    );
    return response.status === 200;
  },
  // GET /sessions/:threadId/inputs/:eventId answers the exact authored input.
  sessionInventoryInputRead: async (deployment) => {
    const routes = orchestrationRoutes(deployment, {
      canUserReadSession: () => true,
      sessionQueries: {
        readUserInput: vi.fn(async () => ({
          status: 'found',
          sessionId: 'session-a',
          eventId: 'input-a',
          turnId: 'turn-a',
          input: { prompt: 'Protected input', attachments: [] },
        })),
      },
    });
    const response = await routes.request(
      '/sessions/session-a/inputs/input-a?turnId=turn-a',
    );
    return response.status === 200;
  },
  // GET /events honours Last-Event-ID: a cursor inside the gap replays the
  // missed event instead of sending a fresh snapshot.
  eventStreamResume: async (deployment) => {
    const missed = {
      globalSequence: 2,
      payload: {
        eventId: 'evt-2',
        provider: 'claude',
        threadId: 'thread-1',
        createdAt: '2026-03-28T00:00:02.000Z',
        method: 'content.text-delta',
        itemId: 'item-1',
        delta: 'missed',
      },
    };
    const routes = orchestrationRoutes(deployment, {
      canUserReadSession: () => true,
      listSessionReadModel: vi.fn(async () => []),
      readEventStreamHead: () => 2,
      readEventStreamReplayPlan: () => ({ count: 1, fitsBudget: true }),
      readEventStreamReplay: () => [missed],
      replayTurnProvenanceSidecar: () => ({}),
      retainSessionDeletionReader: () => () => {},
      conversationStreamBinding: () => undefined,
    });
    const response = await routes.request('/events', {
      headers: { 'Last-Event-ID': '1' },
    });
    if (response.status !== 200 || !response.body) return false;
    const payload = await readStreamUntil(response.body, (text) =>
      text.includes('orchestration:caughtUp'),
    );
    const caughtUp = payload.indexOf('orchestration:caughtUp');
    const history = payload.slice(0, caughtUp);
    return (
      caughtUp >= 0 &&
      history.includes('"eventId":"evt-2"') &&
      !history.includes('orchestration:snapshot')
    );
  },
};

async function advertisedFlags({ hosted }: Deployment) {
  const homeDir = makeTempDir('station-consumed-capability-');
  const registryPath = join(homeDir, 'tenants.json');
  writeFileSync(registryPath, JSON.stringify(REGISTRY));
  const security = new EnvironmentSecurityService({
    homeDir,
    environment: hosted
      ? { [HOSTED_TENANT_REGISTRY_FILE_ENV]: registryPath }
      : {},
  });
  const app = new Hono();
  configureRuntimePublicRoutes(app as never, security);
  const handshake = (await (
    await app.request('/.well-known/station/v1')
  ).json()) as { capabilities?: Record<string, boolean> };
  return handshake.capabilities ?? {};
}

/**
 * #4177: an advertised flag must say whether this deployment's route serves
 * the feature. Each row compares the real handshake (EnvironmentSecurityService
 * behind the public route) with the real route, built from the same mode.
 */
describe('consumed capability flags match what their routes serve', () => {
  // Pinned beside the derived comparison so a change flipping both sides
  // together (withdrawing a flag everywhere, or serving hosted reads without
  // a tenant reader) still reds.
  const EXPECTED: Record<string, Record<'personal' | 'hosted', boolean>> = {
    sessionEventWindow: { personal: true, hosted: true },
    sessionInventoryInputRead: { personal: true, hosted: false },
    eventStreamResume: { personal: true, hosted: true },
  };

  test('every table row has a pinned expectation', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(
      Object.keys(CONSUMED_FLAGS).sort(),
    );
  });

  for (const [flag, probe] of Object.entries(CONSUMED_FLAGS)) {
    test.each([
      { mode: 'personal' as const, hosted: false },
      { mode: 'hosted' as const, hosted: true },
    ])(`${flag}: $mode deployment`, async ({ mode, hosted }) => {
      const flags = await advertisedFlags({ hosted });
      const advertised = flags[flag] === true;
      const served = await probe({ hosted });

      expect({ flag, mode, served }).toEqual({
        flag,
        mode,
        served: EXPECTED[flag]![mode],
      });
      expect({ flag, mode, advertised }).toEqual({
        flag,
        mode,
        advertised: served,
      });
      // A withdrawn flag is an absent key, the contract's "unsupported".
      expect(Object.hasOwn(flags, flag)).toBe(advertised);
    });
  }
});

const CLIENT_ROOTS = ['packages/sdk/src', 'src-ui/src'];

function clientSourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      files.push(...clientSourceFiles(path));
    } else if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !/\.(test|spec)\.tsx?$/.test(entry.name) &&
      !entry.name.endsWith('.d.ts')
    ) {
      files.push(path);
    }
  }
  return files;
}

/**
 * Every `hasCapability(handshake, '<flag>')` call in the given files. A call
 * whose flag argument is not a string literal is reported as `null`, since
 * this check cannot tell which flag it gates on.
 */
function gatedFlagsIn(files: readonly string[]) {
  const found: Array<{ file: string; flag: string | null }> = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('hasCapability')) continue;
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'hasCapability'
      ) {
        const argument = node.arguments[1];
        found.push({
          file: relative(REPO_ROOT, file),
          flag:
            argument && ts.isStringLiteralLike(argument) ? argument.text : null,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

describe('every flag a client gates on has a row above', () => {
  test('hasCapability calls in packages/sdk and src-ui name only tabled flags', () => {
    const calls = gatedFlagsIn(
      CLIENT_ROOTS.flatMap((root) => clientSourceFiles(join(REPO_ROOT, root))),
    );
    // Proves the scan reaches the real gates rather than passing on nothing.
    expect(calls.map((call) => call.flag)).toContain(
      'sessionInventoryInputRead',
    );
    const untabled = calls.filter(
      (call) => call.flag === null || !Object.hasOwn(CONSUMED_FLAGS, call.flag),
    );
    expect(untabled).toEqual([]);
  });

  test('the parser finds a gate in source text, and ignores comments and strings', () => {
    const dir = makeTempDir('station-capability-scan-');
    const file = join(dir, 'client.ts');
    writeFileSync(
      file,
      [
        "// hasCapability(handshake, 'commentFlag')",
        'const text = "hasCapability(handshake, \'stringFlag\')";',
        "hasCapability(handshake, 'newFlag');",
        'hasCapability(handshake, dynamicName);',
      ].join('\n'),
    );
    expect(gatedFlagsIn([file]).map((call) => call.flag)).toEqual([
      'newFlag',
      null,
    ]);
  });
});
