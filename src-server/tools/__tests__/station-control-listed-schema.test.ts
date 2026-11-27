/**
 * What station-control's `tools/list` puts in front of a model
 * (`listedForModels`): no `$schema` dialect URL, none of the arguments only
 * Station's runtime writes, and none of the keywords that tell a model
 * nothing, while calls are still validated by the tool's own schema. Over a
 * real MCP connection.
 */
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, expect, test, vi } from 'vitest';
import { keyedTurnToolArguments } from '../../__test-utils__/turn-admission-fixture.js';
import { verifyDelegationContextAttestation } from '../../runtime/agents/delegation-attestation.js';
import { wrapDelegationAwareTools } from '../../runtime/mcp/mcp-manager.js';
import { createStationBrowserMcpServer } from '../station-browser-mcp-server.js';
import { StationControlDisclosure } from '../station-control-disclosure.js';
import { STATION_INJECTED_TOOL_ARGUMENTS } from '../station-control-listed-schema.js';
import { createSelectedStationControlMcpServer } from '../station-control-mcp-server.js';
import { withStationControlCallerContext } from '../station-control-shared.js';

const API_BASE = 'http://listed-schema-test.local';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function connect(
  profile: 'station-control' | 'station-knowledge' | 'station-browser',
  disclosure?: StationControlDisclosure,
  assurance: 'bound' | 'delegated-custody' = 'bound',
) {
  const server =
    profile === 'station-browser'
      ? createStationBrowserMcpServer()
      : createSelectedStationControlMcpServer(
          undefined,
          undefined,
          profile,
          assurance,
          disclosure,
        );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'listed-schema-test', version: '1' });
  await client.connect(clientTransport);
  closes.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

test('no listed input schema carries the $schema dialect URL, on any registration path', async () => {
  const listed = [
    ...(await (await connect('station-control')).listTools()).tools,
    ...(await (await connect('station-knowledge')).listTools()).tools,
    // station-browser registers through the same registry.
    ...(await (await connect('station-browser')).listTools()).tools,
    // The progressive-disclosure index tools register on their own path.
    ...(
      await (
        await connect(
          'station-control',
          new StationControlDisclosure(() => true),
        )
      ).listTools()
    ).tools,
  ];
  const names = new Set(listed.map((tool) => tool.name));
  // One tool from each path: `tool`, `toolWithSchema`, `appTool`, discovery.
  for (const name of [
    'read_conversation',
    'list_project_activity',
    'get_session_inventory',
    'list_tool_families',
    'search_knowledge',
    'browser_open',
  ]) {
    expect(names, name).toContain(name);
  }
  for (const tool of listed) {
    expect(tool.inputSchema, tool.name).not.toHaveProperty('$schema');
    expect(tool.inputSchema.type, tool.name).toBe('object');
  }
});

/** Every property name a schema declares, at any depth. */
function propertyNames(node: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(node)) for (const item of node) propertyNames(item, found);
  else if (node && typeof node === 'object') {
    const properties = (node as { properties?: unknown }).properties;
    if (properties && typeof properties === 'object')
      for (const name of Object.keys(properties)) found.add(name);
    for (const value of Object.values(node)) propertyNames(value, found);
  }
  return found;
}

/** Every node of a schema that has `key`, by tool. */
function nodesWith(key: string, node: unknown, found: unknown[] = []) {
  if (Array.isArray(node)) for (const item of node) nodesWith(key, item, found);
  else if (node && typeof node === 'object') {
    if (key in node) found.push(node);
    for (const value of Object.values(node)) nodesWith(key, value, found);
  }
  return found;
}

test('the delegated tool catalog has no top-level schema combinators Kiro rejects', async () => {
  const client = await connect(
    'station-control',
    undefined,
    'delegated-custody',
  );
  const { tools } = await client.listTools();
  expect(tools.map((tool) => tool.name)).toEqual(
    expect.arrayContaining(['get_basis', 'get_session_inventory']),
  );
  const incompatible = tools.filter((tool) =>
    ['anyOf', 'allOf', 'oneOf'].some((key) => key in tool.inputSchema),
  );
  expect(incompatible.map((tool) => tool.name)).toEqual([]);
});

test('no listing offers an argument only Station’s runtime writes, though the tools still declare them', async () => {
  const listed = [
    ...(await (await connect('station-control')).listTools()).tools,
    ...(await (await connect('station-knowledge')).listTools()).tools,
    ...(await (await connect('station-browser')).listTools()).tools,
  ];
  // What Codex and ACP list: the delegated-custody subset.
  const delegated = (
    await (
      await connect('station-control', undefined, 'delegated-custody')
    ).listTools()
  ).tools;
  expect(delegated.map((tool) => tool.name)).toContain('delegate_task');
  for (const tool of [...listed, ...delegated]) {
    const names = [...propertyNames(tool.inputSchema)];
    // A leading underscore marks an argument the runtime writes; a new one
    // belongs in STATION_INJECTED_TOOL_ARGUMENTS, or needs another name.
    expect(
      names.filter((name) => name.startsWith('_')),
      tool.name,
    ).toEqual([]);
  }
  // The tools the runtime writes them into (`wrapDelegationAwareTools`) are
  // listed, and still validate them: see the delivery test below.
  const byName = new Map(listed.map((tool) => [tool.name, tool]));
  for (const name of [
    'send_message',
    'delegate_task',
    'list_delegated_tasks',
    'get_task',
    'get_task_events',
    'continue_task',
    'respond_to_task_request',
    'interrupt_task',
    'update_skill',
    'propose_plugin_install',
    'update_plugin',
    'remove_plugin',
  ])
    expect(byName.has(name), name).toBe(true);
  expect([...STATION_INJECTED_TOOL_ARGUMENTS].sort()).toEqual([
    '_delegation',
    '_delegationAttestation',
    '_sourceContext',
    '_userId',
  ]);
});

test('listed schemas carry no keyword that tells a model nothing, and every $ref still resolves', async () => {
  const listed = [
    ...(await (await connect('station-control')).listTools()).tools,
    ...(await (await connect('station-knowledge')).listTools()).tools,
    ...(await (await connect('station-browser')).listTools()).tools,
  ];
  for (const tool of listed) {
    const schema = tool.inputSchema;
    for (const node of nodesWith('maximum', schema))
      expect(node, tool.name).not.toMatchObject({
        type: 'integer',
        maximum: Number.MAX_SAFE_INTEGER,
      });
    for (const node of nodesWith('minimum', schema))
      expect(node, tool.name).not.toMatchObject({
        type: 'integer',
        minimum: Number.MIN_SAFE_INTEGER,
      });
    for (const node of nodesWith('propertyNames', schema))
      expect(
        (node as { propertyNames: unknown }).propertyNames,
        tool.name,
      ).not.toEqual({ type: 'string' });
    for (const node of nodesWith('additionalProperties', schema))
      expect(
        (node as { additionalProperties: unknown }).additionalProperties,
        tool.name,
      ).not.toEqual({});
    // zod points a reused schema at its first use; a listing that removed
    // that use would leave the model a dangling pointer.
    for (const node of nodesWith('$ref', schema)) {
      const ref = (node as { $ref: string }).$ref;
      expect(ref.startsWith('#/'), `${tool.name} ${ref}`).toBe(true);
      let target: unknown = schema;
      for (const part of ref.slice(2).split('/'))
        target = (target as Record<string, unknown> | undefined)?.[part];
      expect(target, `${tool.name} ${ref}`).toBeTypeOf('object');
    }
  }
  // Meaningful bounds stay: `limit` is 1..100, and a closed object says so.
  const events = listed.find((tool) => tool.name === 'get_task_events')!;
  expect(events.inputSchema.properties?.limit).toMatchObject({
    type: 'integer',
    minimum: 1,
    maximum: 100,
  });
  expect(
    nodesWith('additionalProperties', listed).some(
      (node) =>
        (node as { additionalProperties: unknown }).additionalProperties ===
        false,
    ),
  ).toBe(true);
});

test('Station’s runtime still delivers the unlisted arguments through the tool’s own validation', async () => {
  vi.stubEnv('STATION_API_BASE', API_BASE);
  const posted: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === `${API_BASE}/.well-known/station/v1`)
        return Response.json({ environmentId: 'environment-current' });
      posted.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
      return Response.json({ success: false, error: 'stub' }, { status: 503 });
    }),
  );
  const client = await connect('station-control');
  const { tools } = await client.listTools();
  const listedSend = tools.find((tool) => tool.name === 'send_message')!;
  // The model's view: no `_delegation`, `_delegationAttestation`, `_userId`.
  expect(Object.keys(listedSend.inputSchema.properties ?? {})).not.toContain(
    '_delegation',
  );
  // Station's own engine wraps the listed tool; its executor is the real
  // MCP call, so the server validates what the wrapper wrote.
  const [wrapped] = wrapDelegationAwareTools(
    [
      {
        name: 'station-control_send_message',
        description: listedSend.description,
        parameters: listedSend.inputSchema,
        execute: (args: Record<string, unknown>) =>
          withStationControlCallerContext(
            {
              token: 'listed-schema-fixture',
              resolve: () => ({ sessionId: 'session', assurance: 'bound' }),
            },
            () => client.callTool({ name: 'send_message', arguments: args }),
          ),
      } as never,
    ],
    {
      agentSlug: 'planner',
      toolId: 'station-control',
      spec: { name: 'Planner', prompt: 'Plan' },
    },
  );
  await wrapped!.execute!(
    keyedTurnToolArguments('send_message', {
      agent: 'writer',
      message: 'Draft the plan',
    }),
    { conversationId: 'conversation-parent', userId: 'user-1' } as never,
  );
  const forward = posted.find((entry) =>
    entry.url.startsWith(`${API_BASE}/api/orchestration/chat`),
  );
  expect(
    forward,
    JSON.stringify(posted.map((entry) => entry.url)),
  ).toBeDefined();
  const body = forward!.body as {
    delegation?: Parameters<typeof verifyDelegationContextAttestation>[0];
    delegationAttestation?: string;
    userId?: string;
  };
  // #2377 slice D: the runtime stamps no delegation context (the route
  // derives it from the verified caller), so the send is an ordinary one.
  expect(forward!.url).toBe(`${API_BASE}/api/orchestration/chat`);
  expect(body.delegation).toBeUndefined();
  expect(body.delegationAttestation).toBeUndefined();
  expect(body.userId).toBe('user-1');
});

test('calls are still validated by the tool’s own schema', async () => {
  const client = await connect('station-control');
  for (const [name, args] of [
    // `tool` path: limit is at least 1.
    ['read_conversation', { conversationId: 'c', limit: 0 }],
    // `toolWithSchema` path: the schema is strict.
    ['list_project_activity', { unknownField: true }],
  ] as const) {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, name).toBe(true);
    expect(JSON.stringify(result.content), name).toMatch(/invalid|validation/i);
  }
});
