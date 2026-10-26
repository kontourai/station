import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseHostedTenantRegistry } from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import ts from 'typescript-api';
import { describe, expect, test, vi } from 'vitest';
import { readStreamUntil } from '../../__test-utils__/sse-helpers.js';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { createPushRoutes } from '../../routes/operations/push-routes.js';
import { createOrchestrationRoutes } from '../../routes/orchestration/orchestration.js';
import { HOSTED_TENANT_REGISTRY_FILE_ENV } from '../../runtime/bootstrap/hosted-tenant-mode.js';
import { resolveRuntimeWebPushEnabled } from '../../runtime/routes/runtime-route-support.js';
import { configureRuntimePublicRoutes } from '../../runtime/routes/runtime-routes.js';
import { EnvironmentSecurityService } from '../../services/ssh/environment-security-service.js';
import {
  resolveStationCapabilityFlags,
  STATION_CAPABILITY_FLAGS,
} from '../station-capability-flags.js';

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
 * Every handshake flag a client gates on (packages/sdk or src-ui), plus every
 * flag a deployment mode withdraws, with a probe that asks the real route whether it serves that
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
  // Not gated by a client today, but withdrawn in hosted mode, so pinned too.
  // GET /vapid-public-key answers under resolveRuntimeWebPushEnabled. That
  // configureRuntimeSupportServices composes webPushEnabled from it is pinned
  // in runtime-route-support-notification-providers.test.ts.
  webPushNotifications: async ({ hosted }) => {
    const routes = createPushRoutes({
      enabled: resolveRuntimeWebPushEnabled(
        hosted
          ? { [HOSTED_TENANT_REGISTRY_FILE_ENV]: '/hosted/tenants.json' }
          : {},
      ),
      getVapidPublicKey: () => 'vapid-public-key',
      identifyDevice: () => null,
      credentialAliasId: () => undefined,
      setPushSubscription: vi.fn(),
      clearPushSubscription: vi.fn(),
    });
    return (await routes.request('/vapid-public-key')).status === 200;
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
    webPushNotifications: { personal: true, hosted: false },
  };

  test('every flag a deployment withdraws has a row', () => {
    const hostedFlags = resolveStationCapabilityFlags({ hosted: true });
    const withdrawn = Object.keys(STATION_CAPABILITY_FLAGS).filter(
      (flag) => !Object.hasOwn(hostedFlags, flag),
    );
    expect(withdrawn).toEqual(
      expect.arrayContaining([
        'sessionInventoryInputRead',
        'webPushNotifications',
      ]),
    );
    expect(
      withdrawn.filter((flag) => !Object.hasOwn(CONSUMED_FLAGS, flag)),
      'A flag withdrawn in hosted mode needs a row in CONSUMED_FLAGS probing its route.',
    ).toEqual([]);
  });

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

const FLAG_NAMES = new Set(Object.keys(STATION_CAPABILITY_FLAGS));

type Gate = {
  file: string;
  /** The gated flag, or `null` when this scan cannot tell which flag. */
  flag: string | null;
  form: 'call' | 'alias' | 'direct-read';
};

/** `x.capabilities` / `x?.capabilities`, or a bare `capabilities` binding. */
function isCapabilitiesObject(node: ts.Expression): boolean {
  const inner = ts.isNonNullExpression(node) ? node.expression : node;
  if (ts.isIdentifier(inner)) return inner.text === 'capabilities';
  return (
    ts.isPropertyAccessExpression(inner) && inner.name.text === 'capabilities'
  );
}

/**
 * Every client gate on a handshake flag in the given files, found
 * syntactically:
 * - a `hasCapability(...)` call, including through a renamed import
 *   (`import { hasCapability as gate }`) or a member call
 *   (`sdk.hasCapability(...)`);
 * - any other use of `hasCapability` as a value (`const has = hasCapability`,
 *   passing it as an argument, re-exporting it renamed), reported with
 *   `flag: null` because the scan cannot follow the alias;
 * - a direct read of a registry flag on a `capabilities` object
 *   (`h?.capabilities?.webPushNotifications`, `capabilities['x']`, or
 *   destructuring a flag from `.capabilities`).
 * A hasCapability flag argument that is not a string literal is `flag: null`.
 * Not caught: a capabilities read through a dynamic key, or through a
 * variable that is not itself named `capabilities`.
 */
function gatedFlagsIn(files: readonly string[]): Gate[] {
  const found: Gate[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('hasCapability') && !text.includes('capabilities'))
      continue;
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const at = relative(REPO_ROOT, file);
    const gateNames = new Set(['hasCapability']);
    for (const statement of source.statements) {
      const bindings = ts.isImportDeclaration(statement)
        ? statement.importClause?.namedBindings
        : undefined;
      if (bindings && ts.isNamedImports(bindings))
        for (const element of bindings.elements)
          if ((element.propertyName ?? element.name).text === 'hasCapability')
            gateNames.add(element.name.text);
    }
    const literalFlag = (node: ts.Node | undefined) =>
      node && ts.isStringLiteralLike(node) ? node.text : null;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (
          (ts.isIdentifier(callee) && gateNames.has(callee.text)) ||
          (ts.isPropertyAccessExpression(callee) &&
            callee.name.text === 'hasCapability')
        ) {
          found.push({
            file: at,
            flag: literalFlag(node.arguments[1]),
            form: 'call',
          });
          // Arguments may hold further gates; the callee itself is accounted.
          for (const argument of node.arguments) visit(argument);
          if (ts.isPropertyAccessExpression(callee)) visit(callee.expression);
          return;
        }
      }
      if (ts.isIdentifier(node) && gateNames.has(node.text)) {
        const parent = node.parent;
        // A name in a declaration position (an unrelated interface or class
        // member, object key, parameter or local) is not a use of the gate.
        const namesADeclaration =
          (ts.isFunctionDeclaration(parent) ||
            ts.isMethodSignature(parent) ||
            ts.isMethodDeclaration(parent) ||
            ts.isPropertySignature(parent) ||
            ts.isPropertyDeclaration(parent) ||
            ts.isPropertyAssignment(parent) ||
            ts.isGetAccessorDeclaration(parent) ||
            ts.isSetAccessorDeclaration(parent) ||
            ts.isParameter(parent) ||
            ts.isVariableDeclaration(parent) ||
            ts.isBindingElement(parent)) &&
          parent.name === node;
        const declaresOrImports =
          ts.isImportSpecifier(parent) ||
          namesADeclaration ||
          // `x.hasCapability` is judged by the member-access branch below.
          (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
          (ts.isExportSpecifier(parent) &&
            !parent.propertyName &&
            parent.name.text === 'hasCapability') ||
          // A type position (`typeof hasCapability`) gates nothing.
          ts.isTypeQueryNode(parent);
        if (!declaresOrImports)
          found.push({ file: at, flag: null, form: 'alias' });
      }
      if (
        ts.isPropertyAccessExpression(node) &&
        node.name.text === 'hasCapability' &&
        !(ts.isCallExpression(node.parent) && node.parent.expression === node)
      )
        found.push({ file: at, flag: null, form: 'alias' });
      if (
        ts.isPropertyAccessExpression(node) &&
        FLAG_NAMES.has(node.name.text) &&
        isCapabilitiesObject(node.expression)
      )
        found.push({ file: at, flag: node.name.text, form: 'direct-read' });
      if (
        ts.isElementAccessExpression(node) &&
        isCapabilitiesObject(node.expression)
      ) {
        // Only a literal key is attributable. A dynamic key is not reported:
        // engine, voice and native-shell objects also expose `capabilities`
        // maps read by variable, and hasCapability itself reads `[name]`.
        const key = literalFlag(node.argumentExpression);
        if (key !== null && FLAG_NAMES.has(key))
          found.push({ file: at, flag: key, form: 'direct-read' });
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.initializer &&
        isCapabilitiesObject(node.initializer)
      )
        for (const element of node.name.elements) {
          const key = element.propertyName ?? element.name;
          const name =
            ts.isIdentifier(key) || ts.isStringLiteralLike(key)
              ? key.text
              : null;
          if (name !== null && FLAG_NAMES.has(name))
            found.push({ file: at, flag: name, form: 'direct-read' });
        }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

describe('every flag a client gates on has a row above', () => {
  test('gates in packages/sdk and src-ui name only tabled flags', () => {
    const gates = gatedFlagsIn(
      CLIENT_ROOTS.flatMap((root) => clientSourceFiles(join(REPO_ROOT, root))),
    );
    // Proves the scan reaches the real gates rather than passing on nothing.
    expect(gates.map((gate) => gate.flag)).toContain(
      'sessionInventoryInputRead',
    );
    const untabled = gates.filter(
      (gate) => gate.flag === null || !Object.hasOwn(CONSUMED_FLAGS, gate.flag),
    );
    expect(
      untabled,
      'A client gates on a handshake flag that has no row in CONSUMED_FLAGS. ' +
        "Add a row (and an EXPECTED entry) that probes the flag's route in " +
        'personal and hosted mode. A flag of null means the gate is aliased, ' +
        'or names its flag dynamically: call hasCapability(handshake, ' +
        "'<flag>') directly with a literal. A member call such as " +
        "engine.hasCapability('mic') is reported too, since this syntactic " +
        'scan cannot tell an unrelated method of the same name from the SDK ' +
        'gate: rename that method.',
    ).toEqual([]);
  });

  test('the scan follows every gate form and ignores comments, strings and unrelated capabilities', () => {
    const dir = makeTempDir('station-capability-scan-');
    const file = join(dir, 'client.ts');
    writeFileSync(
      file,
      [
        "import * as sdk from './capability.js';",
        "import { hasCapability, hasCapability as gate } from './capability.js';",
        "export { hasCapability } from './capability.js';",
        "// hasCapability(handshake, 'commentFlag')",
        'const text = "hasCapability(handshake, \'stringFlag\')";',
        "hasCapability(handshake, 'sshEnvironments');",
        'hasCapability(handshake, dynamicName);',
        "sdk.hasCapability(handshake, 'scopedPairing');",
        "gate(handshake, 'fleetInference');",
        'const has = hasCapability;',
        'type Gate = typeof hasCapability;',
        'const ok = handshake?.capabilities?.webPushNotifications === true;',
        "const viaKey = handshake.capabilities['executionPreparation'];",
        'const { delegatedInputAnswers } = handshake.capabilities;',
        'const unrelated = compatibility.capabilities.clientProtocolHeader;',
        'interface VoiceEngine { hasCapability(name: string): boolean }',
        'class Engine { hasCapability(name: string) { return !!name; } }',
        'const literal = { hasCapability: () => true };',
        "engine.hasCapability('mic');",
        'const ref = engine.hasCapability;',
      ].join('\n'),
    );
    expect(
      gatedFlagsIn([file]).map(({ flag, form }) => `${form}:${flag}`),
    ).toEqual([
      'call:sshEnvironments',
      'call:null',
      'call:scopedPairing',
      'call:fleetInference',
      'alias:null',
      'direct-read:webPushNotifications',
      'direct-read:executionPreparation',
      'direct-read:delegatedInputAnswers',
      // Declarations named hasCapability above report nothing; an unrelated
      // member call and member reference still fail loudly (see message).
      'call:null',
      'alias:null',
    ]);
  });
});
