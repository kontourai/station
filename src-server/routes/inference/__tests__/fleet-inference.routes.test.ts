/**
 * station#1398 slice 2 — the `/api/inference/**` HTTP surface.
 *
 * Route-level concerns only: status mapping, body bounds applied before
 * parsing, and the manifest read. The refusal taxonomy itself is proven in
 * `services/inference/__tests__/fleet-inference-service.test.ts`; the
 * authorization that gates this family is proven in
 * `security/__tests__/pairing-route-scopes.test.ts` and
 * `runtime/__tests__/runtime-auth-boundary.test.ts` — deliberately not
 * re-derived here, because a handler that re-checks its own scope is how the
 * table and the route drift apart.
 */

import type { FleetContributionManifest } from '@kontourai/station-contracts/fleet-contribution';
import { FLEET_INFERENCE_LIMITS } from '@kontourai/station-contracts/fleet-inference';
import { describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import type { FleetInferenceService } from '../../../services/inference/fleet-inference-service.js';
import { createFleetInferenceRoutes } from '../fleet-inference.js';

const MANIFEST: FleetContributionManifest = {
  schemaVersion: 'station.fleet-contribution/v1',
  projectedAt: '2026-08-01T10:00:01.000Z',
  sourceObservedAt: '2026-08-01T10:00:00.000Z',
  participation: 'contributing',
  models: [
    {
      id: 'ollama-workstation:llama3.3',
      connectionId: 'ollama-workstation',
      providerModel: 'llama3.3:70b',
      model: { id: 'llama3.3', revision: null, quantization: null },
      aliases: [],
      displayName: 'Llama 3.3 70B',
      locality: 'local',
      availability: 'available',
      freshness: 'live',
      observedAt: '2026-08-01T10:00:00.000Z',
      effectiveContextTokens: 131_072,
      toolSurface: null,
      supportsVision: false,
    },
  ],
  diagnostics: [],
};

function mockService(overrides: Partial<FleetInferenceService> = {}) {
  return {
    readManifest: vi.fn().mockResolvedValue(MANIFEST),
    complete: vi.fn().mockResolvedValue({
      kind: 'completed',
      response: {
        schemaVersion: 'station.fleet-inference-completion/v1',
        delivery: 'buffered',
        model: {
          id: 'ollama-workstation:llama3.3',
          connectionId: 'ollama-workstation',
          providerModel: 'llama3.3:70b',
          displayName: 'Llama 3.3 70B',
        },
        servedAt: '2026-08-01T10:00:02.000Z',
        content: 'hello fleet',
        stop: 'provider',
        finishReason: 'stop',
        usage: { inputTokens: 11, outputTokens: 2 },
        elapsedMs: 42,
      },
    }),
    ...overrides,
  } as unknown as FleetInferenceService;
}

function post(
  app: ReturnType<typeof createFleetInferenceRoutes>,
  body: string,
) {
  return app.request('/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

describe('GET /api/inference/manifest', () => {
  test('serves the bounded contributed-subset manifest', async () => {
    const service = mockService();
    const response =
      await createFleetInferenceRoutes(service).request('/manifest');

    expect(response.status).toBe(200);
    const body = await json<{ manifest: FleetContributionManifest }>(response);
    expect(body.manifest.schemaVersion).toBe('station.fleet-contribution/v1');
    expect(body.manifest.participation).toBe('contributing');
    expect(body.manifest.models).toHaveLength(1);
    // The bounding pass is the route's, not the caller's, so it must actually
    // be the bounded read that is served.
    expect(service.readManifest).toHaveBeenCalledTimes(1);
  });

  test('carries no credentials, base URLs, or filesystem paths (§4.2)', async () => {
    const response = await createFleetInferenceRoutes(mockService()).request(
      '/manifest',
    );
    const serialized = JSON.stringify(await response.json());
    for (const forbidden of ['baseUrl', 'apiKey', 'credential', '/Users/']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test('an unreadable manifest answers unknown (503), never an empty list', async () => {
    const response = await createFleetInferenceRoutes(
      mockService({
        readManifest: vi.fn().mockRejectedValue(new Error('io')),
      } as Partial<FleetInferenceService>),
    ).request('/manifest');

    expect(response.status).toBe(503);
    const body = await json<{ refusal: { code: string } }>(response);
    expect(body.refusal.code).toBe('contribution-unavailable');
    expect(JSON.stringify(body)).not.toContain('"models"');
  });
});

describe('POST /api/inference/completions', () => {
  test('serves a completion envelope for an authorized, contributed model', async () => {
    const response = await post(
      createFleetInferenceRoutes(mockService()),
      JSON.stringify({
        model: 'ollama-workstation:llama3.3',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );

    expect(response.status).toBe(200);
    const body = await json<{ completion: { content: string } }>(response);
    expect(body.completion.content).toBe('hello fleet');
  });

  test('maps each refusal code to its declared status, and never to 404', async () => {
    const cases: Array<[string, number]> = [
      ['contribution-disabled', 403],
      ['model-not-contributed', 403],
      ['model-unavailable', 503],
      ['contribution-unavailable', 503],
      ['streaming-unsupported', 400],
      ['request-invalid', 400],
      ['request-too-large', 413],
      ['capacity-exhausted', 429],
      ['execution-failed', 502],
    ];
    for (const [code, status] of cases) {
      const response = await post(
        createFleetInferenceRoutes(
          mockService({
            complete: vi.fn().mockResolvedValue({
              kind: 'refused',
              refusal: {
                schemaVersion: 'station.fleet-inference-refusal/v1',
                code,
                message: 'refused',
                refusedAt: '2026-08-01T10:00:02.000Z',
              },
            }),
          } as Partial<FleetInferenceService>),
        ),
        JSON.stringify({ model: 'x', messages: [] }),
      );
      expect([code, response.status]).toEqual([code, status]);
      expect(response.status).not.toBe(404);
    }
  });

  test('an oversized body is refused before it is parsed', async () => {
    const service = mockService();
    // Deliberately not valid JSON: if the route parsed first, this would come
    // back as `request-invalid` instead of `request-too-large`, which is how
    // "bounded" would quietly mean "bounded after doing the expensive part".
    const response = await post(
      createFleetInferenceRoutes(service),
      'x'.repeat(FLEET_INFERENCE_LIMITS.maxRequestBytes + 1),
    );

    expect(response.status).toBe(413);
    const body = await json<{ refusal: { code: string } }>(response);
    expect(body.refusal.code).toBe('request-too-large');
    expect(service.complete).not.toHaveBeenCalled();
  });

  test('a malformed body is a named refusal, not a thrown 500', async () => {
    const response = await post(
      createFleetInferenceRoutes(mockService()),
      '{not json',
    );
    expect(response.status).toBe(400);
    const body = await json<{ refusal: { code: string } }>(response);
    expect(body.refusal.code).toBe('request-invalid');
  });
});

describe('POST /api/inference/completions: ingestion bounds and abort threading (review round 1)', () => {
  test('M-2: an oversized declared Content-Length is refused on the header alone', async () => {
    // The prior check ran only after `c.req.text()`, so a declared 2 GiB
    // body was fully buffered onto the heap before the 128 KiB refusal
    // fired — the limit bounded parsing, not ingestion.
    //
    // The probe: a TINY, perfectly valid body with an oversized declared
    // length. A post-read-only check measures the real bytes, finds them
    // well within budget, and serves the request; only a pre-read check on
    // the declared length refuses it. (A stream-consumption probe would
    // measure the test harness rather than the route — `app.request` builds
    // the Request eagerly.)
    const service = mockService();
    const response = await createFleetInferenceRoutes(service).request(
      '/completions',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(FLEET_INFERENCE_LIMITS.maxRequestBytes + 1),
        },
        body: JSON.stringify({
          model: 'ollama-workstation:llama3.3',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      },
    );

    expect(response.status).toBe(413);
    const parsed = await json<{ refusal: { code: string } }>(response);
    expect(parsed.refusal.code).toBe('request-too-large');
    expect(service.complete).not.toHaveBeenCalled();
  });

  test('M-2: a caller that LIES about Content-Length is stopped MID-STREAM, not buffered in full', async () => {
    // The residual this route shipped with in review round 1, now closed by
    // `readRequestText`. The probe is the lying-header case specifically: a
    // body far over the cap, with a small honest-looking declared length, so
    // the pre-read short-circuit cannot be what refuses it.
    //
    // Ingestion is proven bounded by counting what the reader actually
    // pulled: the stream offers far more than the cap in chunks, and the
    // route must cancel it after crossing the cap rather than draining it.
    const service = mockService();
    const chunk = new TextEncoder().encode('x'.repeat(16 * 1024));
    const offered = 64; // 1 MiB offered against a 128 KiB cap
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= offered) {
          controller.close();
          return;
        }
        pulled += 1;
        controller.enqueue(chunk);
      },
    });

    const response = await createFleetInferenceRoutes(service).request(
      '/completions',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // The lie: well under the cap, while the body is 8x over it.
          'content-length': '32',
        },
        body,
        // undici requires this for a stream body; the harness's lib now
        // carries it on RequestInit, so no expect-error is needed.
        duplex: 'half',
      },
    );

    expect(response.status).toBe(413);
    const parsed = await json<{ refusal: { code: string } }>(response);
    expect(parsed.refusal.code).toBe('request-too-large');
    expect(service.complete).not.toHaveBeenCalled();
    // The load-bearing assertion: cancelled after crossing the cap, not
    // drained. 128 KiB / 16 KiB = 8 chunks, plus at most one that carried it
    // over. If ingestion were unbounded this would be all 64.
    expect(pulled).toBeLessThanOrEqual(10);
    expect(pulled).toBeLessThan(offered);
  });

  test('M-2: an honest, within-limits Content-Length passes through untouched', async () => {
    const service = mockService();
    const response = await post(
      createFleetInferenceRoutes(service),
      JSON.stringify({
        model: 'ollama-workstation:llama3.3',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );

    expect(response.status).toBe(200);
    expect(service.complete).toHaveBeenCalledTimes(1);
  });

  test('M-1: the caller abort signal is threaded into the service', async () => {
    // Without this the route would leave the model generating tokens nobody
    // will read until the deadline expires, holding a concurrency slot.
    const service = mockService();
    await post(
      createFleetInferenceRoutes(service),
      JSON.stringify({
        model: 'ollama-workstation:llama3.3',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );

    expect(service.complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  test('the two liveness refusals map to their declared statuses', async () => {
    for (const [code, status] of [
      ['completion-timeout', 504],
      ['request-abandoned', 499],
    ] as const) {
      const response = await post(
        createFleetInferenceRoutes(
          mockService({
            complete: vi.fn().mockResolvedValue({
              kind: 'refused',
              refusal: {
                schemaVersion: 'station.fleet-inference-refusal/v1',
                code,
                message: 'refused',
                refusedAt: '2026-08-01T10:00:02.000Z',
              },
            }),
          } as Partial<FleetInferenceService>),
        ),
        JSON.stringify({ model: 'x', messages: [] }),
      );
      expect([code, response.status]).toEqual([code, status]);
    }
  });
});
