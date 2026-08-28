import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { withStationControlCallerBinding } from '../station-control-shared.js';

process.env.STATION_API_BASE = 'http://inventory-control.test';

const groupIds = [
  'inputs',
  'sources',
  'execution',
  'decisions',
  'outputs',
  'verification-delivery',
  'live-now',
  'kept',
  'attention',
  'resources',
];
const envelope = {
  version: 'station.session-inventory-mcp/v1',
  kind: 'projection',
  projection: {
    version: 'station.session-inventory/v1',
    scope: { kind: 'whole-session', sessionId: 'session-a' },
    groups: groupIds.map((id) => ({
      id,
      owner: { owner: 'fixture', id: 'v1' },
      state: 'empty',
      count: { kind: 'exact', value: 0 },
      items: [],
      gaps: [],
    })),
  },
};
const capability = {
  occurrenceId: 'occurrence_'.padEnd(32, 'a'),
  continuations: [
    { groupId: 'inputs', continuationToken: 'continuation_'.padEnd(32, 'b') },
  ],
};

function json(value: unknown) {
  return new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
  });
}
async function registered() {
  const resource = vi.fn();
  const appTool = vi.fn();
  const { registerSessionInventoryTools } = await import(
    '../station-control-session-inventory-tools.js'
  );
  registerSessionInventoryTools({ resource, appTool } as never);
  return {
    resource,
    appTool,
    callback: appTool.mock.calls[0]?.[4] as (input: unknown) => Promise<any>,
  };
}

describe('station-control Session inventory MCP App', () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => vi.stubGlobal('fetch', fetchMock));
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  test('registers the bare tool name, canonical resource, private annotations, and model/app visibility', async () => {
    const { resource, appTool } = await registered();
    expect(resource).toHaveBeenCalledWith(
      'station-session-inventory-v1',
      'ui://station/basis/session-inventory/v1',
      expect.objectContaining({ mimeType: 'text/html;profile=mcp-app' }),
    );
    expect(appTool.mock.calls[0]?.slice(0, 4)).toMatchObject([
      'get_session_inventory',
      expect.any(String),
      expect.anything(),
      {
        _meta: {
          ui: {
            resourceUri: 'ui://station/basis/session-inventory/v1',
            visibility: ['model', 'app'],
          },
        },
        annotations: {
          readOnlyHint: true,
          idempotentHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
    ]);
  });

  test('posts exact open and page contract bodies, and returns only the opaque capability metadata', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        success: true,
        data: envelope,
        meta: { 'station.session-inventory-app/v1': capability },
      }),
    );
    const { callback } = await registered();
    const open = await callback({
      operation: 'open',
      scope: { kind: 'whole-session', sessionId: 'session-a' },
    });
    expect(open.structuredContent).toEqual(envelope);
    expect(open._meta).toEqual({
      'station.session-inventory-app/v1': capability,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'http://inventory-control.test/api/orchestration/sessions/session-a/inventory/app-read',
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      operation: 'open',
      scope: { kind: 'whole-session', sessionId: 'session-a' },
    });

    fetchMock.mockResolvedValueOnce(
      json({
        success: true,
        data: envelope,
        meta: { 'station.session-inventory-app/v1': capability },
      }),
    );
    await callback({
      operation: 'page',
      scope: { kind: 'kept-in-task', taskId: 'task-a', sessionId: 'session-a' },
      occurrenceId: capability.occurrenceId,
      groupId: 'inputs',
      continuationToken: capability.continuations[0]!.continuationToken,
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'http://inventory-control.test/api/tasks/task-a/sessions/session-a/inventory/app-read',
    );
    expect(
      JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)),
    ).toMatchObject({
      operation: 'page',
      occurrenceId: capability.occurrenceId,
      groupId: 'inputs',
    });
  });

  test('rejects invalid input and privately revokes when the caller epoch changes', async () => {
    const { callback } = await registered();
    const invalid = await callback({ operation: 'open', scope: {} });
    expect(invalid.isError).toBe(false);
    expect(invalid).not.toHaveProperty('structuredContent');
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock
      .mockResolvedValueOnce(
        json({
          success: true,
          data: envelope,
          meta: { 'station.session-inventory-app/v1': capability },
        }),
      )
      .mockResolvedValueOnce(json({ success: true }));
    const result = await withStationControlCallerBinding(
      'caller_'.padEnd(32, 'a'),
      () =>
        callback({
          operation: 'open',
          scope: { kind: 'whole-session', sessionId: 'session-a' },
        }),
      () => false,
    );
    expect(result.structuredContent).toBeUndefined();
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'DELETE' });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      occurrenceId: capability.occurrenceId,
    });
  });

  test('refuses malformed or oversized continuation metadata before it can consume the 128 KiB result budget', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        success: true,
        data: envelope,
        meta: {
          'station.session-inventory-app/v1': {
            ...capability,
            continuations: Array.from(
              { length: 11 },
              () => capability.continuations[0],
            ),
          },
        },
      }),
    );
    const { callback } = await registered();
    const result = await callback({
      operation: 'open',
      scope: { kind: 'whole-session', sessionId: 'session-a' },
    });
    expect(result).not.toHaveProperty('structuredContent');
    expect(result.content[0]?.text).toContain('unavailable');
  });
});
