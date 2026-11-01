import { McpServer } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { afterEach, expect, test, vi } from 'vitest';
import { z as z4 } from 'zod';
import { z as z3 } from 'zod/v3';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { createSelectedStationControlMcpServer } from '../../../tools/station-control-mcp-server.js';
import { configureRuntimeRoutes } from '../runtime-routes.js';

type Schema = z3.ZodTypeAny | z4.ZodType;
const capture = vi.hoisted(() => ({
  validators: new WeakMap<object, unknown>(),
  preparedKeys: [] as unknown[],
}));
vi.mock(
  '../../../routes/schemas/schema-validation.js',
  async (importOriginal) => {
    const real =
      await importOriginal<
        typeof import('../../../routes/schemas/schema-validation.js')
      >();
    return {
      ...real,
      validate: (...args: Parameters<typeof real.validate>) => {
        const middleware = real.validate(...args);
        capture.validators.set(middleware, args[0]);
        return middleware;
      },
    };
  },
);
vi.mock('../../../routes/chat/chat-request-preparation.js', () => ({
  prepareChatRequest: async ({
    options,
  }: {
    options: { clientTurnId?: unknown };
  }) => {
    capture.preparedKeys.push(options.clientTurnId);
    throw new Error('Inventory stopped after observing the pre-effect key.');
  },
}));
vi.mock('../runtime-route-support.js', () => {
  const inert = new Proxy({}, { get: () => () => undefined });
  return {
    configureRuntimeSupportServices: () => ({
      schedulerService: inert,
      notificationService: inert,
      attentionProjection: inert,
      webPushService: inert,
      webPushEnabled: false,
    }),
    createRuntimeSystemRouteDeps: () => inert,
  };
});

const makeTempDir = trackTempDirs();
afterEach(() => vi.restoreAllMocks());

function inert(): unknown {
  const value: unknown = new Proxy(() => undefined, {
    get: (_target, key) => (key === 'then' ? undefined : value),
    apply: () => value,
  });
  return value;
}

function runtime(app: Hono, home: string) {
  const context = new Proxy(
    {
      app,
      port: 4329,
      host: '127.0.0.1',
      appConfig: {},
      projectMembership: undefined,
      projectSharedTasks: undefined,
      deploymentAuthentication: undefined,
      localAccounts: undefined,
      applicationSessions: undefined,
      configLoader: {
        getProjectHomeDir: () => home,
        loadAppConfig: () => ({}),
        getLaunchabilityRevision: () => 0,
      },
      providerService: { getLaunchabilityRevision: () => 0 },
      getAgentConfigurationRevision: () => 0,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      eventBus: new EventBus(),
      activeAgents: new Map(),
      agentMetadataMap: new Map(),
      agentFixedTokens: new Map(),
      agentTools: new Map(),
      agentStats: new Map(),
      agentStatus: new Map(),
      memoryAdapters: new Map(),
      metricsLog: [],
      monitoringEvents: [],
      orchestrationEventStore: new Proxy(
        {
          sessionTurnBoundaryAuthority: () => ({
            reconcile: () => ({ kind: 'available', interrupted: [] }),
          }),
        },
        {
          get: (target, key) =>
            key in target ? Reflect.get(target, key) : inert(),
        },
      ),
      taskGraphService: { listTasks: () => [] },
      projectService: { listProjects: () => [] },
      environmentSecurityService: {
        devicePairing: { environmentId: () => 'inventory-station' },
      },
    },
    {
      get: (target, key) =>
        key in target ? Reflect.get(target, key) : inert(),
    },
  );
  Reflect.set(context, 'buildRuntimeContext', () => context);
  return context as unknown as Parameters<typeof configureRuntimeRoutes>[0];
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected registered JSON schema object.');
  return value as Record<string, unknown>;
}

function jsonObjects(
  value: unknown,
  root: Record<string, unknown>,
  seen = new Set<unknown>(),
): Record<string, unknown>[] {
  const node = record(value);
  if (seen.has(node)) return [];
  seen = new Set(seen).add(node);
  if (typeof node.$ref === 'string') {
    if (!node.$ref.startsWith('#/'))
      throw new Error('Nonlocal registered schema reference.');
    const referenced = node.$ref
      .slice(2)
      .split('/')
      .reduce<unknown>(
        (parent, segment) =>
          record(parent)[segment.replace(/~1/g, '/').replace(/~0/g, '~')],
        root,
      );
    return jsonObjects(referenced, root, seen);
  }
  const variants = node.anyOf ?? node.oneOf;
  if (Array.isArray(variants))
    return variants.flatMap((option) => jsonObjects(option, root, seen));
  return [node];
}

function toolNeedsKey(value: unknown, name: string): boolean {
  if (value instanceof z3.ZodType || value instanceof z4.ZodType)
    return objects(value)
      .filter((shape) => turnInput(shape, name))
      .some((shape) => !requiresKey(shape));
  const raw = record(value);
  const standard = raw['~standard'];
  if (standard) {
    const json = record(record(standard).jsonSchema);
    if (typeof json.input !== 'function')
      throw new Error('Registered schema has no JSON input contract.');
    const root = record(
      Reflect.apply(json.input, json, [{ target: 'draft-2020-12' }]),
    );
    return jsonObjects(root, root).some((node) => {
      const fields = node.properties ? record(node.properties) : {};
      if (
        fields.cron ||
        fields.schedule ||
        fields.tools ||
        fields.structureModel
      )
        return false;
      const target = [
        'target',
        'agent',
        'threadId',
        'sessionId',
        'conversationId',
        'taskId',
      ].some((key) => fields[key] !== undefined);
      const text = [
        'message',
        'prompt',
        'input',
        ...(fields.sessionId ? ['text'] : []),
      ].some((key) => fields[key] !== undefined);
      if (!target || !text) return false;
      const required = Array.isArray(node.required) ? node.required : [];
      return ![
        'clientTurnId',
        'clientInputId',
        'requestKey',
        'operationId',
        'idempotencyKey',
        'invocationId',
      ].some((key) => required.includes(key));
    });
  }
  const shape: Record<string, z4.ZodType> = {};
  for (const [key, field] of Object.entries(raw)) {
    if (!(field instanceof z4.ZodType))
      throw new Error(`Unsupported registered field ${key}`);
    shape[key] = field;
  }
  return toolNeedsKey(z4.object(shape), name);
}

function objects(schema: Schema): Record<string, Schema>[] {
  if (schema instanceof z3.ZodObject || schema instanceof z4.ZodObject)
    return [schema.shape];
  if (schema instanceof z3.ZodEffects) return objects(schema.innerType());
  if (
    schema instanceof z3.ZodUnion ||
    schema instanceof z3.ZodDiscriminatedUnion ||
    schema instanceof z4.ZodUnion
  )
    return schema.options.flatMap((option: Schema) => objects(option));
  if (schema instanceof z3.ZodDefault) return objects(schema.removeDefault());
  if (
    schema instanceof z3.ZodOptional ||
    schema instanceof z3.ZodNullable ||
    schema instanceof z4.ZodOptional ||
    schema instanceof z4.ZodNullable ||
    schema instanceof z4.ZodDefault
  )
    return objects(schema.unwrap());
  return [];
}

function turnInput(shape: Record<string, Schema>, path: string): boolean {
  // Scheduling authors a future job; its eventual delivery owns a different key.
  if (shape.cron || shape.schedule || shape.tools || shape.structureModel)
    return false;
  const target =
    [
      'target',
      'agent',
      'threadId',
      'sessionId',
      'conversationId',
      'taskId',
    ].some((name) => shape[name] !== undefined) ||
    /:(?:threadId|sessionId|conversationId|taskId)/.test(path) ||
    (shape.input !== undefined && shape.options !== undefined);
  if (!target) return false;
  return [
    'message',
    'prompt',
    'input',
    ...(shape.sessionId ? ['text'] : []),
  ].some((name) => {
    const field = shape[name];
    return (
      field?.safeParse('registry input').success &&
      (!field.safeParse(undefined).success || shape.target !== undefined)
    );
  });
}

function requiresKey(shape: Record<string, Schema>): boolean {
  return [
    'clientTurnId',
    'clientInputId',
    'requestKey',
    'operationId',
    'idempotencyKey',
    'invocationId',
  ].some((name) => {
    const field = shape[name];
    if (!field) return false;
    const absent = field.safeParse(undefined);
    return (
      !absent.success ||
      (typeof absent.data === 'string' && absent.data.length > 0)
    );
  });
}

test('the composed HTTP and MCP registries admit no turn-input schema without a key boundary', async () => {
  const app = new Hono();
  const configured = configureRuntimeRoutes(
    runtime(app, makeTempDir('send-registry-')),
  );
  await configured.kitLifecycleReady;
  const routes = app.routes.filter((route) => route.method === 'POST');
  expect(routes.length).toBeGreaterThan(100);
  const inspected = new Set<string>();
  const missing: string[] = [];
  for (const route of routes) {
    const schema = capture.validators.get(route.handler) as Schema | undefined;
    if (!schema) continue;
    for (const shape of objects(schema).filter((shape) =>
      turnInput(shape, route.path),
    )) {
      inspected.add(route.path);
      if (requiresKey(shape)) continue;
      const before = capture.preparedKeys.length;
      const probe = new Hono();
      for (const registered of routes.filter(
        (candidate) => candidate.path === route.path,
      ))
        probe.post(registered.path, registered.handler);
      const response = await probe.request(
        route.path.replace(/:[A-Za-z0-9_]+/g, 'station'),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            input: 'registry input',
            message: 'registry input',
            prompt: 'registry input',
            target: { environment: { kind: 'current' }, agent: 'station' },
            conversationId: 'registry-conversation',
            threadId: 'registry-thread',
            delegation: {
              mode: 'isolated-child',
              depth: 1,
              maxDepth: 2,
              parentAgentSlug: 'registry-parent',
              rootAgentSlug: 'registry-root',
            },
          }),
        },
      );
      const body = await response.clone().json();
      if (
        response.status === 400 &&
        body &&
        typeof body === 'object' &&
        'code' in body &&
        body.code === 'client_turn_key_required'
      )
        continue;
      const generated = response.headers.get('X-Station-Client-Turn-Id');
      if (
        !generated ||
        capture.preparedKeys.length !== before + 1 ||
        capture.preparedKeys[before] !== generated
      )
        missing.push(`POST ${route.path}`);
    }
  }
  expect(inspected.size).toBeGreaterThan(6);
  const tools: Array<{ name: string; schema: unknown }> = [];
  const register = McpServer.prototype.registerTool;
  vi.spyOn(McpServer.prototype, 'registerTool').mockImplementation(function (
    this: McpServer,
    name,
    config,
    callback,
  ) {
    if (config.inputSchema) tools.push({ name, schema: config.inputSchema });
    return Reflect.apply(register, this, [name, config, callback]);
  });
  const server = createSelectedStationControlMcpServer();
  try {
    expect(tools.length).toBeGreaterThan(100);
    for (const tool of tools)
      if (toolNeedsKey(tool.schema, tool.name))
        missing.push(`MCP ${tool.name}`);
  } finally {
    await server.close();
  }
  expect(missing).toEqual([]);
});
