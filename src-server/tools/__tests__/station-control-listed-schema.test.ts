/**
 * What station-control's `tools/list` puts in front of a model: input schemas
 * without the `$schema` dialect URL (`listedWithoutDialect`), while calls are
 * still validated by the tool's own schema. Over a real MCP connection.
 */
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, expect, test } from 'vitest';
import { createStationBrowserMcpServer } from '../station-browser-mcp-server.js';
import { StationControlDisclosure } from '../station-control-disclosure.js';
import { createSelectedStationControlMcpServer } from '../station-control-mcp-server.js';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
});

async function connect(
  profile: 'station-control' | 'station-knowledge' | 'station-browser',
  disclosure?: StationControlDisclosure,
) {
  const server =
    profile === 'station-browser'
      ? createStationBrowserMcpServer()
      : createSelectedStationControlMcpServer(
          undefined,
          undefined,
          profile,
          'bound',
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
