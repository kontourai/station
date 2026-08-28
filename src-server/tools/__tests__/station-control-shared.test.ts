import { agentId } from '@kontourai/station-contracts/agent-identity';
import { tenantId } from '@kontourai/station-contracts/tenancy';
import { describe, expect, test } from 'vitest';
import {
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
} from '../../utils/internal-api-token.js';
import {
  buildAnalyticsUsagePath,
  buildChatRequest,
  buildSentMessageResult,
  controlRequestOptions,
  INTERNAL_CONTROL_CALLER_BINDING_HEADER,
  resolveControlApiBase,
  setRuntimeControlApiBase,
  withStationControlExecutionContext,
} from '../station-control-shared.js';

describe('station-control shared helpers', () => {
  test('resolveControlApiBase prefers an explicit base URL', () => {
    expect(
      resolveControlApiBase({
        STATION_API_BASE: 'https://station.internal',
        STATION_PORT: '4111',
      }),
    ).toBe('https://station.internal');
  });

  test('resolveControlApiBase falls back to loopback plus port', () => {
    expect(resolveControlApiBase({ STATION_PORT: '4111' })).toBe(
      'http://127.0.0.1:4111',
    );
  });

  test('resolveControlApiBase follows the current server port', () => {
    expect(resolveControlApiBase({ PORT: '4336' })).toBe(
      'http://127.0.0.1:4336',
    );
  });

  test('resolveControlApiBase follows the runtime-bound port', () => {
    setRuntimeControlApiBase(4555);
    try {
      expect(resolveControlApiBase({})).toBe('http://127.0.0.1:4555');
      expect(
        resolveControlApiBase({ STATION_API_BASE: 'http://127.0.0.1:4666' }),
      ).toBe('http://127.0.0.1:4666');
    } finally {
      setRuntimeControlApiBase(undefined);
    }
  });

  test('attests station-control requests as a trusted local child', () => {
    expect(controlRequestOptions().headers).toEqual({
      [INTERNAL_API_TOKEN_HEADER]: expect.any(String),
      [INTERNAL_PROXY_CALLER_HEADER]: 'local',
      // The per-process stdio caller binding. Kept in this EXACT-set
      // assertion rather than loosened to objectContaining: this is an
      // attestation surface, and a header appearing on it unannounced is
      // exactly what should stop a build (archive#4292). Its value is a
      // random 32-byte binding, so only its presence is asserted.
      [INTERNAL_CONTROL_CALLER_BINDING_HEADER]: expect.any(String),
    });
  });

  test('isolates concurrent request tenants while preserving the immutable stdio child binding', async () => {
    process.env.STATION_INTERNAL_TENANT = 'stdio-child-tenant';
    try {
      const [alpha, bravo] = await Promise.all([
        withStationControlExecutionContext(
          { tenantId: tenantId('alpha'), source: 'request' },
          async () => {
            await Promise.resolve();
            return controlRequestOptions().headers;
          },
        ),
        withStationControlExecutionContext(
          { tenantId: tenantId('bravo'), source: 'request' },
          async () => {
            await Promise.resolve();
            return controlRequestOptions().headers;
          },
        ),
      ]);
      expect(
        (alpha as Record<string, string>)['x-station-internal-tenant'],
      ).toBe('alpha');
      expect(
        (bravo as Record<string, string>)['x-station-internal-tenant'],
      ).toBe('bravo');
      expect(
        (controlRequestOptions().headers as Record<string, string>)[
          'x-station-internal-tenant'
        ],
      ).toBe('stdio-child-tenant');
    } finally {
      delete process.env.STATION_INTERNAL_TENANT;
    }
  });

  test('buildAnalyticsUsagePath omits an empty query string', () => {
    expect(buildAnalyticsUsagePath()).toBe('/api/analytics/usage');
  });

  test('buildAnalyticsUsagePath includes both date filters', () => {
    expect(buildAnalyticsUsagePath('2026-04-01', '2026-04-11')).toBe(
      '/api/analytics/usage?from=2026-04-01&to=2026-04-11',
    );
  });

  test('buildChatRequest keeps the conversation options shape stable', () => {
    expect(buildChatRequest('hello', 'conv-123')).toEqual({
      input: 'hello',
      options: { conversationId: 'conv-123' },
    });
  });

  test('buildChatRequest carries hidden delegation metadata when present', () => {
    expect(
      buildChatRequest('hello', 'conv-123', {
        userId: 'user-1',
        delegation: {
          mode: 'isolated-child',
          depth: 1,
          maxDepth: 2,
          parentAgentSlug: agentId('planner'),
          parentConversationId: 'conv-parent',
          rootAgentSlug: agentId('planner'),
          rootConversationId: 'conv-parent',
        },
      }),
    ).toEqual({
      input: 'hello',
      options: {
        conversationId: 'conv-123',
        userId: 'user-1',
        delegation: {
          mode: 'isolated-child',
          depth: 1,
          maxDepth: 2,
          parentAgentSlug: 'planner',
          parentConversationId: 'conv-parent',
          rootAgentSlug: 'planner',
          rootConversationId: 'conv-parent',
        },
      },
    });
  });

  test('buildChatRequest carries model and project selection without changing the message', () => {
    expect(
      buildChatRequest('hello', 'conv-123', {
        model: 'gpt-5.6',
        projectSlug: 'station',
      }),
    ).toEqual({
      input: 'hello',
      options: {
        conversationId: 'conv-123',
        model: 'gpt-5.6',
      },
      projectSlug: 'station',
    });
  });

  test('buildSentMessageResult returns the MCP text payload shape', () => {
    expect(buildSentMessageResult('writer', 'conv-123')).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: true,
              conversationId: 'conv-123',
              agent: 'writer',
              message: 'Message sent (non-blocking)',
            },
            null,
            2,
          ),
        },
      ],
    });
  });
});
