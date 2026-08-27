/**
 * station#1398 security review, M-2 — the serve-receipt write FAILURE path.
 *
 * Its own file because proving loudness needs the route module's module-scope
 * logger mocked before import, and the sibling suite deliberately exercises
 * the real one.
 *
 * This test exists because the fix shipped without it and a fault injection
 * found that out: reverting the `logger.error` + failure counter to a silent
 * `catch {}` left every serve-receipt assertion green. An unrecorded
 * completion that nothing reports is the "no artifact" posture this feature
 * differentiates against, so the loudness is the behaviour, not decoration
 * around it.
 */

import { describe, expect, test, vi } from 'vitest';

const loggerError = vi.fn();
vi.mock('../../../utils/logger.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../utils/logger.js')
  >('../../../utils/logger.js');
  return {
    ...actual,
    createLogger: () => ({
      error: loggerError,
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    }),
  };
});

const failureCounter = vi.fn();
vi.mock('../../../telemetry/metrics.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../telemetry/metrics.js')
  >('../../../telemetry/metrics.js');
  return {
    ...actual,
    fleetServeReceiptFailures: { add: failureCounter },
  };
});

const { createFleetInferenceRoutes } = await import('../fleet-inference.js');
type FleetInferenceService =
  import('../../../services/inference/fleet-inference-service.js').FleetInferenceService;

function service(): FleetInferenceService {
  return {
    readManifest: vi.fn(),
    complete: vi.fn().mockResolvedValue({
      kind: 'completed',
      response: {
        schemaVersion: 'station.fleet-inference-completion/v1',
        delivery: 'buffered',
        model: {
          id: 'ollama:llama3.3',
          connectionId: 'ollama',
          providerModel: 'llama3.3:70b',
          displayName: 'Llama 3.3 70B',
        },
        servedAt: '2026-08-01T10:00:02.000Z',
        content: 'an answer',
        stop: 'provider',
        finishReason: 'stop',
        usage: null,
        elapsedMs: 5,
      },
    }),
  } as unknown as FleetInferenceService;
}

async function completeWithFailingSink() {
  loggerError.mockClear();
  failureCounter.mockClear();
  const app = createFleetInferenceRoutes(service(), {
    append: async () => {
      throw new Error('EROFS: read-only file system');
    },
  });
  return app.request('/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'ollama:llama3.3',
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
}

describe('an unwritten serve receipt is loud, never silent', () => {
  test('logs an error naming what went unrecorded', async () => {
    await completeWithFailingSink();
    expect(loggerError).toHaveBeenCalledTimes(1);
    const [message] = loggerError.mock.calls[0]!;
    expect(message).toContain('NOT recorded');
    // Names the model, so an operator can tell which completion is missing.
    expect(message).toContain('ollama:llama3.3');
  });

  test('increments a FAILURE counter, not the success one', async () => {
    await completeWithFailingSink();
    expect(failureCounter).toHaveBeenCalledWith(1, { outcome: 'served' });
  });

  test('still returns the completion — the turn already happened', async () => {
    // Turning a receipt-write failure into a 500 would hand the peer a retry
    // that costs this machine a second generation.
    const response = await completeWithFailingSink();
    expect(response.status).toBe(200);
  });
});
