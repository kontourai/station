import { describe, expect, test, vi } from 'vitest';

const mcpUiResolveTotal = { add: vi.fn() };
const mcpUiRenderPermissionChecks = { add: vi.fn() };

vi.mock('../../../telemetry/metrics.js', () => ({
  mcpUiResolveTotal,
  mcpUiRenderPermissionChecks,
}));

const { resolveMCPToolUIRef } = await import('../mcp-ui-resolver.js');
const { MCPService } = await import('../../../services/plugins/mcp-service.js');

function service(overrides: Record<string, unknown> = {}) {
  return {
    listIntegrations: vi.fn().mockResolvedValue([{ id: 'server-a' }]),
    getConnectionStatus: vi.fn().mockReturnValue({ connected: true }),
    getMCPToolCatalog: vi.fn().mockResolvedValue([
      {
        name: 'server-a_render',
        originalName: 'render',
        serverId: 'server-a',
        _meta: { ui: { resourceUri: 'ui://server-a/render.html' } },
      },
    ]),
    ...overrides,
  };
}

describe('resolveMCPToolUIRef', () => {
  test('rejects malformed refs', async () => {
    const result = await resolveMCPToolUIRef(service(), 'server-a_render');

    expect(result.status).toBe('invalid_ref');
    expect(mcpUiResolveTotal.add).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ outcome: 'invalid_ref' }),
    );
  });

  test('reports missing server', async () => {
    const result = await resolveMCPToolUIRef(
      service({ listIntegrations: vi.fn().mockResolvedValue([]) }),
      'server-a/render',
    );

    expect(result.status).toBe('missing_server');
    expect(result.serverId).toBe('server-a');
  });

  test('reports render_revoked when the server render is revoked', async () => {
    const result = await resolveMCPToolUIRef(
      service(),
      'server-a/render',
      'default',
      {
        isRenderRevoked: (serverId) => serverId === 'server-a',
      },
    );

    expect(result.status).toBe('render_revoked');
    expect(result.serverId).toBe('server-a');
    expect(mcpUiRenderPermissionChecks.add).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ server: 'server-a', revoked: 'true' }),
    );
  });

  test('resolves normally when render is not revoked', async () => {
    const result = await resolveMCPToolUIRef(
      service(),
      'server-a/render',
      'default',
      {
        isRenderRevoked: () => false,
      },
    );

    expect(result.status).toBe('success');
    expect(mcpUiRenderPermissionChecks.add).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ server: 'server-a', revoked: 'false' }),
    );
  });

  test('reports missing tool', async () => {
    const result = await resolveMCPToolUIRef(
      service({ getMCPToolCatalog: vi.fn().mockResolvedValue([]) }),
      'server-a/render',
    );

    expect(result.status).toBe('missing_tool');
  });

  test('reports missing resource when tool metadata has no UI resource', async () => {
    const result = await resolveMCPToolUIRef(
      service({
        getMCPToolCatalog: vi.fn().mockResolvedValue([
          {
            name: 'server-a_render',
            originalName: 'render',
            serverId: 'server-a',
          },
        ]),
      }),
      'server-a/render',
    );

    expect(result.status).toBe('missing_resource');
  });

  test('resolves UI resource metadata from MCP _meta', async () => {
    const result = await resolveMCPToolUIRef(service(), 'server-a/render');

    expect(result).toEqual({
      status: 'success',
      ref: 'server-a/render',
      serverId: 'server-a',
      toolName: 'render',
      resourceUri: 'ui://server-a/render.html',
    });
    expect(mcpUiResolveTotal.add).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        outcome: 'success',
        has_server_ref: 'true',
        has_tool_ref: 'true',
        reason: 'resolved',
      }),
    );
    const telemetryAttrs = mcpUiResolveTotal.add.mock.calls.at(-1)?.[1];
    expect(telemetryAttrs).not.toHaveProperty('server_id');
    expect(telemetryAttrs).not.toHaveProperty('tool_name');
  });

  test('ignores CSP and permissions misplaced on tool metadata', async () => {
    const svc = service({
      getMCPToolCatalog: vi.fn().mockResolvedValue([
        {
          name: 'server-a_render',
          originalName: 'render',
          serverId: 'server-a',
          _meta: {
            ui: {
              resourceUri: 'ui://server-a/render.html',
              csp: {
                connectDomains: ['https://api.example.com', 'not-a-url', 42],
                resourceDomains: ['https://cdn.example.com'],
              },
              permissions: { clipboardWrite: {}, bogus: true },
            },
          },
        },
      ]),
    });
    const result = await resolveMCPToolUIRef(svc, 'server-a/render');
    expect(result.status).toBe('success');
    expect(result).not.toHaveProperty('csp');
    expect(result).not.toHaveProperty('permissions');
  });

  test('omits csp/permissions when the tool declares none', async () => {
    const result = await resolveMCPToolUIRef(service(), 'server-a/render');
    expect(result).not.toHaveProperty('csp');
    expect(result).not.toHaveProperty('permissions');
  });

  test('resolves UI metadata through production MCPService catalog contract', async () => {
    const tools = new Map([
      [
        'default',
        [
          {
            name: 'server-a_render',
            _meta: { ui: { resourceUri: 'ui://server-a/render.html' } },
          },
        ],
      ],
    ]);
    const mapping = new Map([
      [
        'server-a_render',
        {
          original: 'render',
          normalized: 'server-a_render',
          server: 'server-a',
          tool: 'render',
        },
      ],
    ]);
    const productionService = new MCPService(
      {
        listIntegrations: vi.fn().mockResolvedValue([{ id: 'server-a' }]),
      } as any,
      new Map(),
      new Map([['server-a', { connected: true }]]),
      new Map(),
      tools,
      mapping,
      { warn: vi.fn() },
    );

    const result = await resolveMCPToolUIRef(
      productionService,
      'server-a/render',
    );

    expect(result).toMatchObject({
      status: 'success',
      resourceUri: 'ui://server-a/render.html',
    });
  });

  test('does not fall back when a disabled server authoritatively has no UI tools', async () => {
    const fallback = vi.fn().mockReturnValue([
      {
        serverId: 'server-a',
        originalName: 'render',
        _meta: { ui: { resourceUri: 'ui://stale' } },
      },
    ]);
    const result = await resolveMCPToolUIRef(
      service({
        getMCPUIToolCatalog: vi
          .fn()
          .mockResolvedValue({ available: true, tools: [] }),
        getMCPToolCatalog: fallback,
      }),
      'server-a/render',
    );
    expect(result.status).toBe('missing_tool');
    expect(fallback).not.toHaveBeenCalled();
  });

  test('does not fall back when all server tools are authoritatively disabled', async () => {
    const fallback = vi.fn().mockReturnValue([
      {
        serverId: 'server-a',
        originalName: 'render',
        _meta: { ui: { resourceUri: 'ui://stale' } },
      },
    ]);
    const result = await resolveMCPToolUIRef(
      service({
        getMCPUIToolCatalog: vi
          .fn()
          .mockResolvedValue({ available: true, tools: [] }),
        listTools: fallback,
      }),
      'server-a/render',
    );
    expect(result.status).toBe('missing_tool');
    expect(fallback).not.toHaveBeenCalled();
  });

  test('falls back when the server-scoped catalog is genuinely unavailable', async () => {
    const fallback = vi.fn().mockReturnValue([
      {
        serverId: 'server-a',
        originalName: 'render',
        _meta: { ui: { resourceUri: 'ui://fallback' } },
      },
    ]);
    const result = await resolveMCPToolUIRef(
      service({
        getMCPUIToolCatalog: vi.fn().mockResolvedValue({ available: false }),
        getMCPToolCatalog: fallback,
      }),
      'server-a/render',
    );
    expect(result).toMatchObject({
      status: 'success',
      resourceUri: 'ui://fallback',
    });
    expect(fallback).toHaveBeenCalledOnce();
  });

  // Contract-verified against the real Kontour Survey MCP server
  // (kontourai/survey src/mcp/review-mcp.ts, PR #87). Survey emits the SEP-1865
  // declared resource under the FLAT canonical `_meta["ui/resourceUri"]` key
  // (what @modelcontextprotocol/ext-apps `registerAppTool` emits) AND the
  // nested `_meta.ui.resourceUri` convenience key. The resolver must read both.
  describe('Survey review-card contract (SEP-1865 canonical key)', () => {
    const SURVEY_URI = 'ui://survey/review-card/queue';
    function surveyService(meta: Record<string, unknown>) {
      return service({
        listIntegrations: vi.fn().mockResolvedValue([{ id: 'survey' }]),
        getMCPToolCatalog: vi.fn().mockResolvedValue([
          {
            name: 'survey_review_card',
            originalName: 'review_card',
            serverId: 'survey',
            _meta: meta,
          },
        ]),
      });
    }

    test('resolves from the flat canonical _meta["ui/resourceUri"] alone (regression: previously missing_resource)', async () => {
      const result = await resolveMCPToolUIRef(
        surveyService({ 'ui/resourceUri': SURVEY_URI }),
        'survey/review_card',
      );
      expect(result.status).toBe('success');
      expect(result.resourceUri).toBe(SURVEY_URI);
    });

    test('resolves when Survey emits both the flat and nested keys', async () => {
      const result = await resolveMCPToolUIRef(
        surveyService({
          'ui/resourceUri': SURVEY_URI,
          ui: { resourceUri: SURVEY_URI, visibility: ['model', 'app'] },
        }),
        'survey/review_card',
      );
      expect(result.status).toBe('success');
      expect(result.resourceUri).toBe(SURVEY_URI);
    });

    test('prefers nested extension metadata over the flat legacy pointer', async () => {
      const nested = 'ui://survey/review-card/nested';
      const result = await resolveMCPToolUIRef(
        surveyService({
          'ui/resourceUri': 'ui://survey/review-card/legacy',
          ui: { resourceUri: nested },
        }),
        'survey/review_card',
      );
      expect(result.status).toBe('success');
      expect(result.resourceUri).toBe(nested);
    });

    test('still resolves from the nested _meta.ui.resourceUri convenience key', async () => {
      const result = await resolveMCPToolUIRef(
        surveyService({ ui: { resourceUri: SURVEY_URI } }),
        'survey/review_card',
      );
      expect(result.status).toBe('success');
      expect(result.resourceUri).toBe(SURVEY_URI);
    });
  });
});
