import { describe, expect, test } from 'vitest';
import {
  outwardTransportError,
  outwardTransportFailure,
  sanitizedTransportError,
} from '../outward-error.js';

describe('outward transport errors', () => {
  test('uses a stable channel message without coercing external error text', () => {
    expect(outwardTransportError('sse')).toBe('The response stream failed.');
    expect(outwardTransportError('runtimeHttp')).toBe(
      'The request could not be completed.',
    );
    expect(outwardTransportError('terminalWebSocket')).toBe(
      'The terminal request failed.',
    );
    expect(outwardTransportError('voiceWebSocket')).toBe(
      'The voice session could not start.',
    );
  });

  test('keeps only sanitized detail for internal MCP/provider logging', () => {
    const detail = sanitizedTransportError(
      new Error(
        'provider stderr https://provider.example.test/private?token=secret /Users/operator/private-key',
      ),
    );

    expect(JSON.stringify(detail)).not.toContain('provider.example');
    expect(JSON.stringify(detail)).not.toContain('token=secret');
    expect(JSON.stringify(detail)).not.toContain('/Users/operator');
  });

  test('does not coerce an unknown thrown value into a durable diagnostic', () => {
    expect(sanitizedTransportError({ secret: 'must-not-coerce' })).toEqual({
      type: 'NonErrorThrow',
      message: 'A non-Error value was thrown.',
    });
  });

  test('creates a safe correlation envelope without accepting caller-provided detail', () => {
    const failure = outwardTransportFailure('terminalWebSocket');
    expect(failure).toEqual({
      correlationId: expect.any(String),
      message: 'The terminal request failed.',
    });
    expect(failure.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});
