import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  callTool,
  fetchAgents,
  fetchConversationMessages,
  fetchConversations,
  invoke,
  invokeAgent,
  invokeWithRunReceipt,
  NativeInvocationIndeterminateError,
} from '../api-agent-runtime';
import { _setApiBase } from '../api-core';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('api-agent-runtime response decoding', () => {
  beforeEach(() => {
    _setApiBase('https://station.example.test');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('returns the tool response from a valid success envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          jsonResponse({ success: true, response: { value: 42 } }),
        ),
    );

    await expect(callTool('station', 'lookup')).resolves.toEqual({ value: 42 });
  });

  test('keeps malformed direct-invoke envelopes non-retryable after request submission', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(null))
      .mockResolvedValueOnce(
        jsonResponse({ success: 'yes', response: 'not contract-shaped' }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(callTool('station', 'lookup')).rejects.toThrow(
      'Tool call failed',
    );
    await expect(invoke({ prompt: 'hello' })).rejects.toMatchObject({
      name: 'NativeInvocationIndeterminateError',
      retryable: false,
    });
  });

  test('keeps a version-skew-safe invoke receipt optional on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          jsonResponse({ success: true, response: 'older Station response' }),
        ),
    );

    await expect(invoke({ prompt: 'hello' })).resolves.toBe(
      'older Station response',
    );
  });

  test('adds native run correlation without changing invoke raw-response compatibility', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          jsonResponse({
            success: true,
            response: 'raw response',
            runId: 'invoke:primary',
            relatedRunIds: ['invoke:structure'],
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            success: true,
            response: 'raw response',
            runId: 'invoke:primary',
            relatedRunIds: ['invoke:structure'],
          }),
        ),
    );

    await expect(invoke({ prompt: 'hello' })).resolves.toBe('raw response');
    await expect(invokeWithRunReceipt({ prompt: 'hello' })).resolves.toEqual({
      response: 'raw response',
      runId: 'invoke:primary',
      relatedRunIds: ['invoke:structure'],
    });
  });

  test('classifies a possible native invocation as non-retryable and preserves its run identity', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: false,
            code: 'native_invocation_indeterminate',
            outcome: 'indeterminate',
            runId: 'invoke:run-1',
            error:
              'The provider invocation may have started. Observe the run before retrying.',
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    await expect(invokeAgent('station', 'hello')).rejects.toMatchObject({
      name: 'NativeInvocationIndeterminateError',
      code: 'native_invocation_indeterminate',
      outcome: 'indeterminate',
      retryable: false,
      runId: 'invoke:run-1',
    } satisfies Partial<NativeInvocationIndeterminateError>);
  });

  test('preserves completed primary and indeterminate structured run identities', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: false,
            code: 'native_invocation_partial',
            outcome: 'indeterminate',
            runId: 'invoke:primary',
            relatedRunIds: ['invoke:structure'],
            structureOutcome: 'indeterminate',
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    await expect(
      invokeWithRunReceipt({ prompt: 'hello' }),
    ).rejects.toMatchObject({
      name: 'NativeInvocationIndeterminateError',
      code: 'native_invocation_partial',
      retryable: false,
      runId: 'invoke:primary',
      relatedRunIds: ['invoke:structure'],
      structureOutcome: 'indeterminate',
    });
  });

  test('keeps malformed indeterminate evidence non-retryable during server version skew', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: false,
            code: 'native_invocation_indeterminate',
            outcome: 'indeterminate',
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    await expect(invoke({ prompt: 'hello' })).rejects.toMatchObject({
      name: 'NativeInvocationIndeterminateError',
      retryable: false,
      runId: undefined,
    });
  });

  test.each([
    ['invokeAgent', () => invokeAgent('station', 'hello')],
    ['invokeWithRunReceipt', () => invokeWithRunReceipt({ prompt: 'hello' })],
  ])(
    'keeps a complete definite 409 envelope ordinary for %s',
    async (_operation, invokeDirectly) => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            jsonResponse(
              { success: false, error: 'The configuration conflicts.' },
              409,
            ),
          ),
      );

      const error = await invokeDirectly().catch((cause) => cause);
      expect(error).toBeInstanceOf(Error);
      expect(error).toHaveProperty('message', 'The configuration conflicts.');
      expect(error).not.toBeInstanceOf(NativeInvocationIndeterminateError);
    },
  );

  test.each([
    ['empty', ''],
    ['malformed JSON', '{'],
    ['malformed envelope', JSON.stringify({})],
  ])(
    'keeps an ambiguous %s 409 non-retryable for both invoke APIs',
    async (_shape, body) => {
      for (const invokeDirectly of [
        () => invokeAgent('station', 'hello'),
        () => invokeWithRunReceipt({ prompt: 'hello' }),
      ]) {
        vi.stubGlobal(
          'fetch',
          vi.fn<typeof fetch>().mockResolvedValue(
            new Response(body, {
              status: 409,
              headers: { 'Content-Type': 'application/json' },
            }),
          ),
        );

        await expect(invokeDirectly()).rejects.toMatchObject({
          name: 'NativeInvocationIndeterminateError',
          retryable: false,
          runId: undefined,
        } satisfies Partial<NativeInvocationIndeterminateError>);
      }
    },
  );

  test.each([
    ['code only', { code: 'native_invocation_indeterminate' }],
    ['outcome only', { outcome: 'indeterminate' }],
    ['run ID only', { runId: 'invoke:possibly-started' }],
    ['related IDs only', { relatedRunIds: ['invoke:possibly-started'] }],
    ['structure outcome only', { structureOutcome: 'indeterminate' }],
  ])(
    'keeps a partial %s uncertainty marker non-retryable for both invoke APIs',
    async (_shape, marker) => {
      for (const invokeDirectly of [
        () => invokeAgent('station', 'hello'),
        () => invokeWithRunReceipt({ prompt: 'hello' }),
      ]) {
        vi.stubGlobal(
          'fetch',
          vi.fn<typeof fetch>().mockResolvedValue(
            jsonResponse(
              {
                success: false,
                error: 'The provider invocation may have started.',
                ...marker,
              },
              409,
            ),
          ),
        );

        await expect(invokeDirectly()).rejects.toMatchObject({
          name: 'NativeInvocationIndeterminateError',
          retryable: false,
          runId: undefined,
        } satisfies Partial<NativeInvocationIndeterminateError>);
      }
    },
  );

  test('treats response loss after submitting a direct invoke as possible effect without inventing a run id', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockRejectedValue(new TypeError('connection reset')),
    );

    await expect(invoke({ prompt: 'hello' })).rejects.toMatchObject({
      name: 'NativeInvocationIndeterminateError',
      retryable: false,
      runId: undefined,
    });
  });

  test.each([400, 401, 404, 503])(
    'keeps a received definite HTTP %i invokeAgent response as an ordinary error',
    async (status) => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn<typeof fetch>()
          .mockImplementation(() =>
            Promise.resolve(
              jsonResponse(
                { success: false, error: `definite ${status}` },
                status,
              ),
            ),
          ),
      );

      const error = await invokeAgent('station', 'hello').catch(
        (cause) => cause,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error).toHaveProperty('message', `definite ${status}`);
      expect(error).not.toBeInstanceOf(NativeInvocationIndeterminateError);
    },
  );

  test.each([400, 401, 404, 503])(
    'keeps a received definite HTTP %i invoke receipt response as an ordinary error',
    async (status) => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn<typeof fetch>()
          .mockImplementation(() =>
            Promise.resolve(
              jsonResponse(
                { success: false, error: `definite ${status}` },
                status,
              ),
            ),
          ),
      );

      const error = await invokeWithRunReceipt({ prompt: 'hello' }).catch(
        (cause) => cause,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error).toHaveProperty('message', `definite ${status}`);
      expect(error).not.toBeInstanceOf(NativeInvocationIndeterminateError);
    },
  );

  test.each([400, 401, 404, 503])(
    'keeps empty and non-JSON definite HTTP %i responses ordinary for both invoke APIs',
    async (status) => {
      for (const body of ['', 'upstream unavailable']) {
        const invokeDirectly =
          body.length === 0
            ? () => invokeAgent('station', 'hello')
            : () => invokeWithRunReceipt({ prompt: 'hello' });
        vi.stubGlobal(
          'fetch',
          vi.fn<typeof fetch>().mockResolvedValue(
            new Response(body, {
              status,
              statusText: 'Service Unavailable',
            }),
          ),
        );

        const error = await invokeDirectly().catch((cause) => cause);
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(NativeInvocationIndeterminateError);
      }
    },
  );

  test.each([
    ['invokeAgent', () => invokeAgent('station', 'hello')],
    ['invokeWithRunReceipt', () => invokeWithRunReceipt({ prompt: 'hello' })],
  ])(
    'does not treat a misleading non-409 uncertainty envelope as possible effect for %s',
    async (_operation, invokeDirectly) => {
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>().mockResolvedValue(
          jsonResponse(
            {
              code: 'native_invocation_indeterminate',
              outcome: 'indeterminate',
              error: 'misleading upstream body',
            },
            503,
          ),
        ),
      );

      const error = await invokeDirectly().catch((cause) => cause);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(NativeInvocationIndeterminateError);
    },
  );

  test.each([
    ['invokeAgent', () => invokeAgent('station', 'hello')],
    ['invokeWithRunReceipt', () => invokeWithRunReceipt({ prompt: 'hello' })],
  ])(
    'treats a %s JSON response read failure after submission as possible effect',
    async (_operation, invokeDirectly) => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response('{', { status: 200 })),
      );

      await expect(invokeDirectly()).rejects.toBeInstanceOf(
        NativeInvocationIndeterminateError,
      );
    },
  );

  test.each([
    ['invokeAgent', () => invokeAgent('station', 'hello')],
    ['invokeWithRunReceipt', () => invokeWithRunReceipt({ prompt: 'hello' })],
  ])(
    'treats a %s malformed success envelope after submission as possible effect',
    async (_operation, invokeDirectly) => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(jsonResponse({}))
          .mockResolvedValueOnce(jsonResponse([])),
      );

      await expect(invokeDirectly()).rejects.toBeInstanceOf(
        NativeInvocationIndeterminateError,
      );
      await expect(invokeDirectly()).rejects.toBeInstanceOf(
        NativeInvocationIndeterminateError,
      );
    },
  );

  test.each([
    ['invokeAgent', () => invokeAgent('station', 'hello')],
    ['invokeWithRunReceipt', () => invokeWithRunReceipt({ prompt: 'hello' })],
  ])(
    'treats a %s fetch response loss after submission as possible effect',
    async (_operation, invokeDirectly) => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn<typeof fetch>()
          .mockRejectedValue(new TypeError('connection reset')),
      );

      await expect(invokeDirectly()).rejects.toBeInstanceOf(
        NativeInvocationIndeterminateError,
      );
    },
  );

  test.each([
    ['agents', () => fetchAgents()],
    ['conversations', () => fetchConversations()],
    ['messages', () => fetchConversationMessages('conversation-1')],
  ])('rejects a non-array %s response', async (resource, request) => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ data: [] })),
    );

    await expect(request()).rejects.toThrow(
      `Failed to fetch ${resource}: invalid response`,
    );
  });
});
