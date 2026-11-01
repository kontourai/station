import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, expect, test } from 'vitest';
import { StationControlDisclosure } from '../station-control-disclosure.js';
import { createSelectedStationControlMcpServer } from '../station-control-mcp-server.js';
import { withStationControlCallerContext } from '../station-control-shared.js';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
});

async function connection(
  disclosure?: StationControlDisclosure,
  assurance: 'bound' | 'bearer-exposed' = 'bound',
  onChanged?: (names: string[]) => void,
) {
  const server = createSelectedStationControlMcpServer(
    ['list_agents', 'create_agent'],
    undefined,
    'station-control',
    assurance,
    disclosure,
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: 'disclosure-test', version: '1' },
    onChanged
      ? {
          listChanged: {
            tools: {
              debounceMs: 0,
              onChanged: (error, tools) => {
                if (!error && tools) onChanged(tools.map((tool) => tool.name));
              },
            },
          },
        }
      : undefined,
  );
  await client.connect(clientTransport);
  closes.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

function asCaller<T>(operation: () => T) {
  return withStationControlCallerContext(
    {
      token: 'fixture-incarnation',
      resolve: () => ({ sessionId: 'session', assurance: 'bound' }),
    },
    operation,
  );
}

test('a real MCP connection lists only the index until loading a family; loading preserves call-time role refusal', async () => {
  let delivered: string[] = [];
  const client = await connection(
    new StationControlDisclosure(() => true),
    'bound',
    (names) => {
      delivered = names;
    },
  );
  expect(
    (await client.listTools()).tools.map((tool) => tool.name).sort(),
  ).toEqual(['list_tool_families', 'load_tool_family']);
  await asCaller(() =>
    client.callTool({
      name: 'load_tool_family',
      arguments: { family: 'Agents' },
    }),
  );
  expect(
    (await client.listTools()).tools.map((tool) => tool.name).sort(),
  ).toEqual([
    'create_agent',
    'list_agents',
    'list_tool_families',
    'load_tool_family',
  ]);
  await expect.poll(() => delivered).toContain('create_agent');
  const result = await asCaller(() =>
    client.callTool({
      name: 'create_agent',
      arguments: { name: 'Unowned', slug: 'unowned' },
    }),
  );
  expect(JSON.stringify(result)).toContain('station_control_role_required');
});

test('loaded families stay within the authored allowlist and assurance, and another incarnation starts unloaded', async () => {
  const first = await connection(
    new StationControlDisclosure(() => true),
    'bearer-exposed',
  );
  const second = await connection(
    new StationControlDisclosure(() => true),
    'bearer-exposed',
  );
  await asCaller(() =>
    first.callTool({
      name: 'load_tool_family',
      arguments: { family: 'Agents' },
    }),
  );
  expect((await first.listTools()).tools.map((tool) => tool.name)).toEqual([
    'list_agents',
    'list_tool_families',
    'load_tool_family',
  ]);
  expect((await second.listTools()).tools.map((tool) => tool.name)).toEqual([
    'list_tool_families',
    'load_tool_family',
  ]);
  const unknown = await asCaller(() =>
    first.callTool({
      name: 'load_tool_family',
      arguments: { family: 'Projects' },
    }),
  );
  expect(JSON.stringify(unknown)).toContain('tool_family_unavailable');
});

test('revocation refuses both index and previously loaded tools; static fallback keeps its filtered tools', async () => {
  let current = true;
  const client = await connection(new StationControlDisclosure(() => current));
  await asCaller(() =>
    client.callTool({
      name: 'load_tool_family',
      arguments: { family: 'Agents' },
    }),
  );
  current = false;
  for (const name of ['list_tool_families', 'list_agents']) {
    const result = await asCaller(() =>
      client.callTool({ name, arguments: {} }),
    );
    expect(JSON.stringify(result)).toContain('station_control_caller_required');
  }
  const staticClient = await connection(undefined, 'bearer-exposed');
  expect(
    (await staticClient.listTools()).tools.map((tool) => tool.name),
  ).toEqual(['list_agents']);
});
