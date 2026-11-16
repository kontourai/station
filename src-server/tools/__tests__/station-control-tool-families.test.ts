/**
 * Every tool Station's built-in registry serves has exactly one stated
 * family (`station-control-tool-families.ts`), and that family is what the
 * listing and `list_tool_families` / `load_tool_family` use.
 */
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { afterEach, expect, test } from 'vitest';
import { createCodexBoundToolServer } from '../../runtime/mcp/station-control-in-process.js';
import { createStationBrowserMcpServer } from '../station-browser-mcp-server.js';
import { registerBrowserTools } from '../station-control-browser-tools.js';
import {
  STATION_CONTROL_DISCOVERY_TOOL_NAMES,
  StationControlDisclosure,
} from '../station-control-disclosure.js';
import {
  createSelectedStationControlMcpServer,
  StationControlToolRegistry,
} from '../station-control-mcp-server.js';
import { withStationControlCallerContext } from '../station-control-shared.js';
import { STATION_TOOL_FAMILY_MEMBERS } from '../station-control-tool-families.js';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
});

/** Every name each registration path registers, read from the registry. */
function registeredNames(): Map<string, string[]> {
  const byPath = new Map<string, string[]>();
  const record = (path: string) => {
    const names: string[] = [];
    byPath.set(path, names);
    return (name: string) => names.push(name);
  };
  createSelectedStationControlMcpServer(undefined, record('station-control'));
  createSelectedStationControlMcpServer(
    undefined,
    record('station-knowledge'),
    'station-knowledge',
  );
  // station-browser and Codex's bound channel register these.
  registerBrowserTools(
    new StationControlToolRegistry(
      new McpServer({ name: 'families-test', version: '1' }),
      record('station-browser'),
    ),
  );
  return byPath;
}

async function connect(server: McpServer) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'families-test', version: '1' });
  await client.connect(clientTransport);
  closes.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

const familyOf = (name: string) =>
  Object.entries(STATION_TOOL_FAMILY_MEMBERS)
    .filter(([, members]) => (members as readonly string[]).includes(name))
    .map(([family]) => family);

test('every registered tool has exactly one family, and every family entry is a registered tool', () => {
  const registered = new Set([...registeredNames().values()].flat());
  expect(registered.size).toBeGreaterThan(150);
  const unclassified = [...registered].filter(
    (name) => familyOf(name).length !== 1,
  );
  expect(
    unclassified,
    'Add each tool to exactly one family in station-control-tool-families.ts',
  ).toEqual([]);
  const stale = Object.values(STATION_TOOL_FAMILY_MEMBERS)
    .flat()
    .filter((name) => !registered.has(name));
  expect(stale, 'No server registers these family entries').toEqual([]);
  // The discovery tools are the index itself, never a family's member.
  for (const name of Object.values(STATION_CONTROL_DISCOVERY_TOOL_NAMES))
    expect(familyOf(name), name).toEqual([]);
});

test('the listing names each tool’s stated family, on every registration path', async () => {
  const listed = [
    ...(
      await (await connect(createSelectedStationControlMcpServer())).listTools()
    ).tools,
    ...(
      await (
        await connect(
          createSelectedStationControlMcpServer(
            undefined,
            undefined,
            'station-knowledge',
          ),
        )
      ).listTools()
    ).tools,
    ...(await (await connect(createStationBrowserMcpServer())).listTools())
      .tools,
  ];
  for (const tool of listed)
    expect([tool._meta?.['ai.kontour/tool-group']], tool.name).toEqual(
      familyOf(tool.name),
    );
  const group = (name: string) =>
    listed.find((tool) => tool.name === name)?._meta?.['ai.kontour/tool-group'];
  // Names a pattern misread: "preview" holds "review"; devices had none.
  expect(group('html_preview')).toBe('Station');
  expect(group('preview_schedule')).toBe('Scheduling');
  expect(group('device_open')).toBe('Devices');
  expect(group('device_capture_to_task')).toBe('Devices');
  expect(group('browser_capture_to_task')).toBe('Browser');
  expect(group('get_task_brief')).toBe('Tasks');

  // Codex's bound channel lists the same families for its tools.
  const bound = await createCodexBoundToolServer({
    sessionId: 'families-test',
    includeBrowser: true,
    includeDevices: true,
    isCurrent: () => true,
    dispatch: async () => {
      throw new Error('listing only');
    },
  });
  closes.push(bound.close);
  for (const tool of bound.tools as {
    name: string;
    _meta?: Record<string, unknown>;
  }[])
    expect([tool._meta?.['ai.kontour/tool-group']], tool.name).toEqual(
      familyOf(tool.name),
    );
});

test('list_tool_families counts the stated families and load_tool_family discloses exactly one', async () => {
  const client = await connect(
    createSelectedStationControlMcpServer(
      undefined,
      undefined,
      'station-control',
      'bound',
      new StationControlDisclosure(() => true),
    ),
  );
  const asCaller = <T>(operation: () => T) =>
    withStationControlCallerContext(
      {
        token: 'families-fixture',
        resolve: () => ({ sessionId: 'session', assurance: 'bound' }),
      },
      operation,
    );
  const listedFamilies = await asCaller(() =>
    client.callTool({ name: 'list_tool_families', arguments: {} }),
  );
  const { families } = JSON.parse(
    (listedFamilies.content as { text: string }[])[0]!.text,
  ) as { families: { name: string; toolCount: number }[] };
  expect(families.find((family) => family.name === 'Devices')).toMatchObject({
    toolCount: STATION_TOOL_FAMILY_MEMBERS.Devices.length,
  });
  await asCaller(() =>
    client.callTool({
      name: 'load_tool_family',
      arguments: { family: 'Devices' },
    }),
  );
  expect(
    (await client.listTools()).tools
      .map((tool) => tool.name)
      .filter(
        (name) =>
          !name.endsWith('_tool_families') && !name.endsWith('_tool_family'),
      )
      .sort(),
  ).toEqual([...STATION_TOOL_FAMILY_MEMBERS.Devices].sort());
});
