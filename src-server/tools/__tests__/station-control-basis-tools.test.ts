import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { StationControlToolRegistry } from '../station-control-mcp-server.js';

process.env.STATION_API_BASE = 'http://basis-control.test';

type BasisInput =
  | { scope: 'answer'; sessionId: string; turnId: string }
  | { scope: 'task-answer'; taskId: string; answerReferenceId: string };
type BasisResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
};

const projection = {
  version: 'surface.basis-projection/v1',
  answer: {
    owner: { authority: '@kontourai/thread' },
    state: 'available',
    observedAt: '2026-08-25T00:00:00.000Z',
    value: {
      ref: {
        authority: '@kontourai/thread',
        schemaVersion: '1.2.0',
        kind: 'assistant-message',
        standing: 'observed',
        threadId: 'session-a',
        messageId: 'message-a',
      },
      fact: 'answer-observed',
      observedAt: '2026-08-25T00:00:00.000Z',
    },
  },
  standing: 'execution-only',
  unresolvedReason: null,
  assessment: {
    owner: { authority: '@kontourai/surface' },
    state: 'not-captured',
    observedAt: '2026-08-25T00:00:00.000Z',
  },
  regions: {
    inputs: [],
    execution: [],
    process: [],
    outcomes: [],
    support: [],
    sources: [],
    live: [],
  },
  relationships: [],
  gaps: [],
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function registered() {
  const resource = vi.fn();
  const appTool = vi.fn();
  const { registerBasisTools } = await import(
    '../station-control-basis-tools.js'
  );
  registerBasisTools({
    resource,
    appTool,
  } as unknown as StationControlToolRegistry);
  const callback = appTool.mock.calls[0]?.[4] as (
    input: BasisInput,
  ) => Promise<BasisResult>;
  return { appTool, callback, resource };
}

describe('station-control Basis MCP App', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => vi.stubGlobal('fetch', fetchMock));
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  test('registers bounded resources and isolates the narrow whole-task App tool', async () => {
    const { appTool, resource } = await registered();
    expect(resource).toHaveBeenCalledTimes(2);
    const [name, uri, content] = resource.mock.calls[0] as [
      string,
      string,
      { mimeType: string; text: string; _meta: unknown },
    ];
    expect(name).toBe('station-basis-v1');
    expect(uri).toBe('ui://station/basis/v1');
    expect(content.mimeType).toBe('text/html;profile=mcp-app');
    expect(Buffer.byteLength(content.text, 'utf8')).toBeLessThanOrEqual(
      500 * 1024,
    );
    expect(content._meta).toEqual({
      ui: { csp: { connectDomains: [], resourceDomains: [] } },
    });
    expect(content.text).toContain(
      "default-src 'none'; script-src 'unsafe-inline'",
    );
    const [taskName, taskUri, taskContent] = resource.mock.calls[1] as [
      string,
      string,
      { mimeType: string; text: string; _meta: unknown },
    ];
    expect(taskName).toBe('station-task-basis-v3');
    expect(taskUri).toBe('ui://station/basis/task/v3');
    expect(taskContent.mimeType).toBe('text/html;profile=mcp-app');
    expect(Buffer.byteLength(taskContent.text, 'utf8')).toBeLessThanOrEqual(
      480 * 1024,
    );
    expect(taskContent.text).not.toContain('surface-trust-panel');
    expect(appTool.mock.calls[0]?.slice(0, 4)).toMatchObject([
      'get_basis',
      expect.any(String),
      expect.anything(),
      {
        _meta: {
          ui: {
            resourceUri: 'ui://station/basis/v1',
            visibility: ['model'],
          },
        },
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
    ]);
    expect(appTool.mock.calls[1]?.slice(0, 4)).toMatchObject([
      'get_task_basis',
      expect.any(String),
      expect.anything(),
      {
        _meta: {
          ui: {
            resourceUri: 'ui://station/basis/task/v3',
            visibility: ['model', 'app'],
          },
        },
        annotations: { readOnlyHint: true, idempotentHint: false },
      },
    ]);
  });

  test('rejects malformed Unicode and identifiers over the shared UTF-8 bound', async () => {
    const { parseStationBasisToolInput } = await import(
      '../station-control-basis-tools.js'
    );
    expect(
      parseStationBasisToolInput({
        scope: 'answer',
        sessionId: '\ud800',
        turnId: 'turn-a',
      }),
    ).toBeNull();
    expect(
      parseStationBasisToolInput({
        scope: 'answer',
        sessionId: 'é'.repeat(513),
        turnId: 'turn-a',
      }),
    ).toBeNull();
  });

  test('returns the canonical authorized projection as structured content', async () => {
    fetchMock.mockResolvedValueOnce(json({ success: true, data: projection }));
    const { callback } = await registered();
    const result = await callback({
      scope: 'answer',
      sessionId: 'session-a',
      turnId: 'turn-a',
    });
    expect(result.structuredContent).toEqual(projection);
    expect(result.content[0]?.text).toContain('Unassessed');
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'http://basis-control.test/api/orchestration/sessions/session-a/turns/turn-a/basis',
    );
  });

  test('keeps selected Task scope exact and rejects a collection-shaped response', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        success: true,
        data: {
          version: 'station.task-basis-collection/v4',
          taskId: 'task-a',
          answers: [{ answerReferenceId: 'answer-a', projection }],
          unassociated: [],
          keptToolResults: [],
          keptGateEvaluations: [],
          gaps: [],
        },
      }),
    );
    const { callback } = await registered();
    const result = await callback({
      scope: 'task-answer',
      taskId: 'task-a',
      answerReferenceId: 'answer-a',
    });
    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0]?.text).toContain('Cannot be read');
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'http://basis-control.test/api/tasks/task-a/basis?answerReferenceId=answer-a',
    );
  });

  test.each([403, 503])(
    'returns a valid generic unavailable result without leaking a %i response',
    async (status) => {
      fetchMock.mockResolvedValueOnce(
        json(
          {
            success: false,
            error: 'tenant-secret/session-secret/turn-secret',
          },
          status,
        ),
      );
      const { callback } = await registered();
      const result = await callback({
        scope: 'answer',
        sessionId: 'session-secret',
        turnId: 'turn-secret',
      });
      expect(result.structuredContent).toBeUndefined();
      expect(JSON.stringify(result)).not.toMatch(
        /tenant-secret|session-secret|turn-secret/u,
      );
      expect(result.isError).toBe(false);
    },
  );
});
