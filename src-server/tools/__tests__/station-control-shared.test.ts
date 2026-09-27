import { tenantId } from '@kontourai/station-contracts/tenancy';
import { StationHttpError } from '@kontourai/station-sdk/client';
import { describe, expect, test } from 'vitest';
import {
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
} from '../../utils/internal-api-token.js';
import {
  controlRequestOptions,
  INTERNAL_CONTROL_CALLER_BINDING_HEADER,
  LocalStationRefusal,
  readRelayingLocalRefusal,
  resolveControlApiBase,
  STATION_CONTROL_ORIGIN_HEADER,
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
      // Station #90 lane D: announced here deliberately. Marks the request as a
      // station-control agent tool call (`isAgentOriginatedRequest`); it
      // can only restrict. No caller credential: this test process is not a
      // stdio child with one installed, nor inside an HTTP MCP request.
      [STATION_CONTROL_ORIGIN_HEADER]: 'agent-tool',
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
});

/**
 * #2708: the one place a delegation read decides whether a refusal's code is
 * this Station's. Both the Agent and the Project read go through it; only a
 * `current` target keeps the code, and only as a cause.
 */
describe('readRelayingLocalRefusal', () => {
  const refusal = () =>
    new StationHttpError(403, 'Delegation depth exceeded.', {
      code: 'delegation_depth_exceeded',
    });
  const failed = (kind: string, error: unknown) =>
    readRelayingLocalRefusal({ kind }, async () => {
      throw error;
    }).catch((caught: unknown) => caught as Error);

  test('this Station’s coded refusal rides as a cause, never as code', async () => {
    const error = await failed('current', refusal());

    expect(error).not.toBeInstanceOf(StationHttpError);
    expect((error as { code?: unknown }).code).toBeUndefined();
    expect(error.message).toBe('Delegation depth exceeded.');
    expect(error.cause).toBeInstanceOf(LocalStationRefusal);
    expect(error.cause).toMatchObject({
      refusalCode: 'delegation_depth_exceeded',
    });
  });

  test.each(['peer', 'ssh'])(
    'a %s Station’s coded refusal keeps its words and loses its code',
    async (kind) => {
      const error = await failed(kind, refusal());

      expect((error as { code?: unknown }).code).toBeUndefined();
      expect(error.message).toBe('Delegation depth exceeded.');
      expect(error.cause).toBeUndefined();
    },
  );

  test('a refusal without a code carries no cause', async () => {
    const error = await failed('current', new StationHttpError(404, 'gone'));

    expect(error.message).toBe('gone');
    expect(error.cause).toBeUndefined();
  });

  test('a failure that is not a refusal passes through unchanged', async () => {
    const transport = new TypeError('fetch failed');

    expect(await failed('current', transport)).toBe(transport);
  });

  test('an answer passes through', async () => {
    await expect(
      readRelayingLocalRefusal({ kind: 'peer' }, async () => 42),
    ).resolves.toBe(42);
  });
});
