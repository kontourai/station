/**
 * #1796: who the full-access refusal says asked, from the request's own
 * verified principal. The route tests (`approval-full-access-authority`,
 * `task-dispatch-full-access`) drive the device and Agent cases through the
 * real boundary; these pin the edges.
 */
import { describe, expect, test } from 'vitest';
import {
  bindFullAccessRefusalIdentity,
  fullAccessRefusalBody,
} from '../full-access-refusal.js';
import { setRuntimeAuthenticatedRequestPrincipal } from '../runtime-request-security.js';

function request(
  principal?: Parameters<typeof setRuntimeAuthenticatedRequestPrincipal>[1],
) {
  const req = new Request('http://station.test/api/orchestration/commands', {
    method: 'POST',
  });
  if (principal) setRuntimeAuthenticatedRequestPrincipal(req, principal);
  return req;
}

describe('fullAccessRefusalBody', () => {
  test('a device is named from the pairing records, with a short id and no credential', () => {
    const req = request({
      kind: 'credential',
      credential: 'device-secret-must-not-appear',
      authority: 'device-credential',
      deviceId: '0123456789abcdef',
      source: 'bearer',
    });
    bindFullAccessRefusalIdentity(req, {
      environmentId: () => 'env-1',
      deviceName: (id) =>
        id === '0123456789abcdef' ? 'Laptop CLI' : undefined,
    });
    const body = fullAccessRefusalBody(req);
    expect(body.details).toEqual({
      requested: 'never',
      requester: {
        kind: 'device',
        deviceId: '01234567',
        deviceName: 'Laptop CLI',
      },
      station: { environmentId: 'env-1' },
      grant: {
        by: 'operator',
        scope: 'approval:full-access',
        uiSteps: [
          "Open the Station desktop app on the Station's host.",
          'Select the Station name (top right), then Paired devices.',
          'Select the device by its name, then Change access.',
          'Turn on Allow full access, then Apply.',
        ],
        cli: 'station environment access scope 01234567 --add approval:full-access',
      },
    });
    expect(body.error).toBe(
      "Full access was not applied. Only this Station's operator can allow full access, for this device (id 01234567). On the Station's host, the operator can run: station environment access scope 01234567 --add approval:full-access",
    );
    expect(JSON.stringify(body)).not.toContain('device-secret');
    expect(JSON.stringify(body)).not.toContain('0123456789abcdef');
  });

  test('without the pairing records it still refuses, naming "this device"', () => {
    const body = fullAccessRefusalBody(
      request({
        kind: 'credential',
        credential: 'c',
        authority: 'device-credential',
        deviceId: 'fedcba9876543210',
        source: 'bearer',
      }),
    );
    expect(body.details.requester).toEqual({
      kind: 'device',
      deviceId: 'fedcba98',
      deviceName: 'this device',
    });
    expect(body.details.station).toEqual({});
  });

  test('a person with no device credential gets the UI path and no command', () => {
    const body = fullAccessRefusalBody(
      request({
        kind: 'credential',
        credential: 'account-session',
        authority: undefined,
        source: 'session',
      }),
    );
    expect(body.details.requester).toEqual({ kind: 'person' });
    expect(body.details.grant).toEqual({
      by: 'operator',
      scope: 'approval:full-access',
      uiSteps: [
        "Open the Station desktop app on the Station's host.",
        'Select the Station name (top right), then Paired devices.',
        'Select the device by its name, then Change access.',
        'Turn on Allow full access, then Apply.',
      ],
    });
    expect(body.error).toContain('for the device you are using');
  });

  test('an Agent has no grant path', () => {
    const body = fullAccessRefusalBody(
      request({
        kind: 'internal',
        credential: 'internal',
        authority: undefined,
        source: 'bearer',
      }),
    );
    expect(body.details).toMatchObject({
      requester: { kind: 'agent' },
      grant: null,
    });
    expect(body.error).toContain('An agent can never put itself');
  });
});
