// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const reactQueryMocks = vi.hoisted(() => ({
  invalidateQueries: vi.fn(),
  useMutation: vi.fn((options) => options),
  useQuery: vi.fn(),
}));

// station#3172 — pass through every REAL export via `importOriginal()` and
// override only what this file's hooks actually exercise. A plain-object
// factory that lists just `hashKey`/`useMutation`/`useQuery`/`useQueryClient`
// is missing `keepPreviousData`, which `query-core.ts`'s `useApiQuery` also
// imports from this module. That's silent today only because
// `useApiQuery` reads it behind `config?.keepPreviousData ? keepPreviousData
// : undefined` — none of the hooks this file exercises pass
// `keepPreviousData: true`, so the ternary's true branch, and the missing
// binding, is never reached. Vitest's own mock-module proxy throws
// (`[vitest] No "keepPreviousData" export is defined on the
// "@tanstack/react-query" mock...`) the moment code DOES read a name the
// factory omitted — which would surface as a confusing import error in
// whatever test first sets that flag, not as "your mock is incomplete".
// `importOriginal()` closes the whole class, not just this one binding.
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    hashKey: (key: unknown) => JSON.stringify(key),
    useMutation: reactQueryMocks.useMutation,
    useQuery: reactQueryMocks.useQuery,
    useQueryClient: vi.fn(() => ({
      invalidateQueries: reactQueryMocks.invalidateQueries,
      getQueryDefaults: vi.fn(() => undefined),
    })),
  };
});

vi.mock('../api', () => ({
  _getApiBase: vi.fn().mockResolvedValue('http://example.test'),
}));

import { useApiQuery } from '../query-core';
import {
  useAgentConnectionsQuery,
  useModelConnectionsQuery,
  useModelPickerCatalogQuery,
} from '../query-domains/workspaceConnections';
import {
  credentialRecoveryQueryKey,
  useApplyCredentialProfileMutation,
  useImportCredentialProfileSnapshotMutation,
  useSetCredentialProfileEnrollmentMutation,
  useSetCredentialRecoveryAutomaticPolicyMutation,
  useUpsertCredentialProfileMutation,
} from '../query-domains/workspaceCredentialRecovery';

function success(data: unknown) {
  vi.mocked(fetch).mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, data }),
  } as Response);
}

function lastMutationOptions<TVariables>(): {
  mutationFn: (variables: TVariables) => Promise<unknown>;
  onSuccess: (data: unknown, variables: TVariables) => void;
} {
  const call = reactQueryMocks.useMutation.mock.lastCall;
  if (!call) throw new Error('Expected useMutation to be called.');
  return call[0] as {
    mutationFn: (variables: TVariables) => Promise<unknown>;
    onSuccess: (data: unknown, variables: TVariables) => void;
  };
}

describe('credential recovery SDK workspace-connections domain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('keeps credential recovery cache keys scoped to one agent connection', () => {
    expect(credentialRecoveryQueryKey('codex')).toEqual([
      'connections',
      'agent',
      'codex',
      'credential-recovery',
    ]);
  });

  it('sends exact profile, enrollment, and default-off policy payloads', async () => {
    success({ profiles: [{ ref: 'profile-a' }], group: {}, policy: {} });
    useUpsertCredentialProfileMutation();
    const upsert = lastMutationOptions<{
      id: string;
      ref: string;
      label?: string;
    }>();
    await upsert.mutationFn({
      id: 'codex runtime',
      ref: 'profile / a',
      label: 'Account A',
    });
    expect(fetch).toHaveBeenLastCalledWith(
      'http://example.test/api/connections/agent/codex%20runtime/credential-recovery/profiles',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ ref: 'profile / a', label: 'Account A' }),
      }),
    );

    success({ profiles: [], group: {}, policy: {} });
    useSetCredentialProfileEnrollmentMutation();
    const enrollment = lastMutationOptions<{
      id: string;
      ref: string;
      enrolled: boolean;
    }>();
    await enrollment.mutationFn({
      id: 'codex',
      ref: 'profile-a',
      enrolled: true,
    });
    expect(fetch).toHaveBeenLastCalledWith(
      'http://example.test/api/connections/agent/codex/credential-recovery/profiles/profile-a/enrollment',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ enrolled: true }),
      }),
    );

    success({ profiles: [], group: {}, policy: { automatic: false } });
    useSetCredentialRecoveryAutomaticPolicyMutation();
    const policy = lastMutationOptions<{
      id: string;
      automatic: boolean;
    }>();
    await policy.mutationFn({ id: 'codex', automatic: false });
    expect(fetch).toHaveBeenLastCalledWith(
      'http://example.test/api/connections/agent/codex/credential-recovery/policy',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ automatic: false }),
      }),
    );
  });

  it('keeps candidate imports opt-in and returns only the route report', async () => {
    success({
      outcome: 'completed',
      copied: ['config.toml'],
      skipped: [{ path: 'auth.json', reason: 'credentials-excluded' }],
      provenanceUpdated: true,
    });
    useImportCredentialProfileSnapshotMutation();
    const mutation = lastMutationOptions<{
      id: string;
      ref: string;
      includeCredentials?: boolean;
    }>();
    const result = await mutation.mutationFn({
      id: 'codex',
      ref: 'profile-a',
    });

    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/connections/agent/codex/credential-recovery/profiles/profile-a/import',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ includeCredentials: false }),
      }),
    );
    expect(JSON.stringify(result)).not.toContain('profileDir');
  });

  it('applies only with explicit confirmation and invalidates the consistent connection keys', async () => {
    success({
      capability: 'restart_resume',
      activeProfileRef: 'profile-a',
      outcome: 'rolled_back',
    });
    useApplyCredentialProfileMutation();
    const mutation = lastMutationOptions<{
      id: string;
      ref: string;
      confirmed: true;
      timeoutMs?: number;
    }>();
    const variables = {
      id: 'codex',
      ref: 'profile-a',
      confirmed: true as const,
      timeoutMs: 20_000,
    };
    const data = await mutation.mutationFn(variables);
    mutation.onSuccess(data, variables);

    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/connections/agent/codex/credential-recovery/profiles/profile-a/apply',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ confirmed: true, timeoutMs: 20_000 }),
      }),
    );
    expect(reactQueryMocks.invalidateQueries).toHaveBeenNthCalledWith(1, {
      queryKey: ['connections'],
    });
    expect(reactQueryMocks.invalidateQueries).toHaveBeenNthCalledWith(2, {
      queryKey: ['connections', 'runtimes'],
    });
    expect(reactQueryMocks.invalidateQueries).toHaveBeenNthCalledWith(3, {
      queryKey: ['connections', 'codex'],
    });
    expect(reactQueryMocks.invalidateQueries).toHaveBeenNthCalledWith(4, {
      queryKey: credentialRecoveryQueryKey('codex'),
    });
  });
});

describe('model picker persistence projection', () => {
  it('serializes an exact credential-free allowlist and drops unexpected nested fields', async () => {
    const responses = [
      {
        success: true,
        data: [
          {
            id: 'codex',
            kind: 'agent',
            type: 'codex',
            name: 'Codex',
            enabled: true,
            capabilities: ['agent-runtime'],
            status: 'ready',
            prerequisites: [],
            config: { engineId: 'codex', secret: 'drop-me' },
            setup: {
              state: 'ready',
              detected: true,
              configured: true,
              token: 'drop-me',
            },
            runtimeCatalog: {
              source: 'live',
              fetchedAt: '2026-08-14T00:00:00.000Z',
              reason: null,
              models: [
                {
                  id: 'x',
                  name: 'X',
                  originalId: 'x',
                  capabilities: { supportsEffort: true, token: 'drop-me' },
                },
              ],
              builtInModels: [],
              token: 'drop-me',
            },
          },
        ],
      },
      { success: true, data: [] },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => ({
        json: async () => responses.shift(),
      })),
    );
    reactQueryMocks.useQuery.mockImplementation((options) => options);
    const { result: queryResult } = renderHook(() =>
      useModelPickerCatalogQuery(),
    );
    const query = queryResult.current as unknown as {
      queryFn: (context: { signal: AbortSignal }) => Promise<unknown>;
    };

    const result = await query.queryFn({
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      agentConnections: [
        {
          id: 'codex',
          kind: 'agent',
          type: 'codex',
          name: 'Codex',
          enabled: true,
          capabilities: ['agent-runtime'],
          status: 'ready',
          prerequisites: [],
          config: { engineId: 'codex' },
          setup: { state: 'ready', detected: true, configured: true },
          runtimeCatalog: {
            source: 'live',
            fetchedAt: '2026-08-14T00:00:00.000Z',
            reason: null,
            models: [
              {
                id: 'x',
                name: 'X',
                originalId: 'x',
                capabilities: { supportsEffort: true },
              },
            ],
            builtInModels: [],
          },
        },
      ],
      modelConnections: [],
      excluded: { agents: 0, models: 0 },
    });
    expect(JSON.stringify(result)).not.toContain('drop-me');
    expect(JSON.stringify(result)).not.toContain('token');
  });

  /**
   * station#3390. `connection.setup.state` was read without a guard, so ONE
   * record missing `setup` threw out of the map and BOTH lists came back empty
   * for the whole app — the composer fell back to raw model ids and the picker
   * rendered disabled, silently. The claim here is totality: the healthy
   * record survives its malformed neighbour, and the loss is counted rather
   * than absorbed.
   */
  it('excludes only the malformed record and counts it', async () => {
    const healthy = {
      id: 'codex',
      kind: 'agent',
      type: 'codex',
      name: 'Codex',
      enabled: true,
      capabilities: ['agent-runtime'],
      status: 'ready',
      prerequisites: [],
      config: { engineId: 'codex' },
      setup: { state: 'ready', detected: true, configured: true },
    };
    const responses = [
      // Second record omits `setup`, which `AgentConnectionView` requires —
      // the exact shape 15 of 17 e2e fixtures were shipping.
      {
        success: true,
        data: [healthy, { ...healthy, id: 'claude', setup: undefined }],
      },
      {
        success: true,
        // `capabilities.filter` and `config` are read unguarded too, so the
        // isolation has to cover more than the field that was reported.
        data: [
          {
            id: 'ollama',
            kind: 'model',
            type: 'ollama',
            name: 'Ollama',
            enabled: true,
            capabilities: ['llm'],
            status: 'ready',
            prerequisites: [],
            config: {},
          },
          { id: 'broken', kind: 'model', type: 'x', name: 'X', enabled: true },
        ],
      },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => ({
        json: async () => responses.shift(),
      })),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    reactQueryMocks.useQuery.mockImplementation((options) => options);
    const { result: queryResult } = renderHook(() =>
      useModelPickerCatalogQuery(),
    );
    const query = queryResult.current as unknown as {
      queryFn: (context: { signal: AbortSignal }) => Promise<unknown>;
    };

    const result = (await query.queryFn({
      signal: new AbortController().signal,
    })) as {
      agentConnections: { id: string }[];
      modelConnections: { id: string }[];
      excluded: { agents: number; models: number };
    };

    expect(result.agentConnections.map((c) => c.id)).toEqual(['codex']);
    expect(result.modelConnections.map((c) => c.id)).toEqual(['ollama']);
    expect(result.excluded).toEqual({ agents: 1, models: 1 });
    // Counted AND said out loud — the defect was that nothing anywhere
    // reported it. One line per fetch, not one per record.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('excluded 1 engine and 1 model');
    warn.mockRestore();
  });

  it('throws on a non-array payload rather than reporting a silent zero', async () => {
    const responses = [
      { success: true, data: null },
      { success: true, data: undefined },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => ({
        json: async () => responses.shift(),
      })),
    );
    reactQueryMocks.useQuery.mockImplementation((options) => options);
    const { result: queryResult } = renderHook(() =>
      useModelPickerCatalogQuery(),
    );
    const query = queryResult.current as unknown as {
      queryFn: (context: { signal: AbortSignal }) => Promise<unknown>;
    };

    // station#3390 review B-1: swallowing this would report `excluded: 0` —
    // "nothing was dropped" — about a response that dropped everything, and
    // would do it with no warn and no error state. Per-record isolation is for
    // RECORDS; a broken envelope must stay loud.
    await expect(
      query.queryFn({ signal: new AbortController().signal }),
    ).rejects.toThrow(/came back as null, not a list/);
  });
});

describe('station#3748 — an inventory read that failed is not an empty inventory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reactQueryMocks.useQuery.mockImplementation((options) => options);
  });

  function queryFnOf(hook: () => unknown) {
    const { result } = renderHook(hook);
    return (
      result.current as unknown as {
        queryFn: (context: { signal: AbortSignal }) => Promise<unknown>;
      }
    ).queryFn;
  }

  function respondWith(...payloads: unknown[]) {
    const queue = [...payloads];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => ({
        ok: true,
        json: async () => queue.shift(),
      })),
    );
  }

  it('names the unreadable connections instead of resolving to []', async () => {
    respondWith({
      success: true,
      data: [],
      failures: [
        {
          connectionId: 'broken-1',
          name: 'Broken Connection',
          reason: 'capabilities.filter is not a function',
        },
      ],
    });

    // The whole defect: this used to resolve `[]`, which every consumer
    // renders as "you have no model connections" beside a disabled Create.
    await expect(
      queryFnOf(useModelConnectionsQuery)({
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(
      /A model connection could not be read — Broken Connection: capabilities\.filter is not a function/,
    );
  });

  it('applies the same rule to the engine inventory', async () => {
    respondWith({
      success: true,
      data: [],
      failures: [
        { connectionId: 'a', name: 'A', reason: 'boom' },
        { connectionId: 'b', name: 'B', reason: 'bang' },
      ],
    });

    await expect(
      queryFnOf(useAgentConnectionsQuery)({
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(
      /2 engine connections could not be read — A: boom; B: bang/,
    );
  });

  it('keeps the rows it could read when only some rows failed', async () => {
    respondWith({
      success: true,
      data: [
        {
          id: 'anthropic-1',
          kind: 'model',
          type: 'anthropic',
          name: 'Anthropic',
          enabled: true,
          capabilities: ['llm'],
          status: 'ready',
          prerequisites: [],
          config: {},
        },
      ],
      failures: [{ connectionId: 'broken-1', name: 'Broken', reason: 'boom' }],
    });

    // A partial inventory beats none: withholding four working connections
    // because a fifth is malformed is the all-or-nothing behaviour #3748
    // removed.
    await expect(
      queryFnOf(useModelConnectionsQuery)({
        signal: new AbortController().signal,
      }),
    ).resolves.toHaveLength(1);
  });

  it('a legacy response with no failures field still resolves to an empty list', async () => {
    respondWith({ success: true, data: [] });

    await expect(
      queryFnOf(useModelConnectionsQuery)({
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual([]);
  });
});

describe('station#3172 — the @tanstack/react-query mock passes through real exports', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a hook that sets keepPreviousData: true does not throw on a missing mock export', () => {
    // query-core.ts's `useApiQuery` reads the real `keepPreviousData`
    // binding from '@tanstack/react-query' only when this flag is true —
    // this is that read. Before station#3172's fix (a plain-object mock
    // factory missing `keepPreviousData`), this call threw via Vitest's own
    // mock-export proxy.
    expect(() =>
      renderHook(() =>
        useApiQuery(['station-3172-probe'], async () => 'data', {
          keepPreviousData: true,
        }),
      ),
    ).not.toThrow();
  });
});
