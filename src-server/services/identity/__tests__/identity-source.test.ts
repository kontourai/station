import { describe, expect, test } from 'vitest';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_INGRESS_IDENTITY_HEADER,
} from '../../../utils/internal-api-token.js';
import {
  type IdentityRequestContext,
  TailscaleServeIdentitySource,
} from '../identity-source.js';

const LOOPBACK_ENVIRONMENT = {
  incoming: { socket: { remoteAddress: '127.0.0.1' } },
};

function encodeIdentity(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function context(
  headers: Record<string, string | undefined>,
  environment: unknown = LOOPBACK_ENVIRONMENT,
): IdentityRequestContext {
  return {
    environment,
    header: (name) => headers[name],
  };
}

describe('TailscaleServeIdentitySource', () => {
  const source = new TailscaleServeIdentitySource();

  test('advertises the tailscale-serve provider', () => {
    expect(source.provider).toBe('tailscale-serve');
  });

  test('maps a verified ingress identity to a VerifiedIdentity (login -> subject)', () => {
    const identity = source.identify(
      context({
        [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
        [INTERNAL_INGRESS_IDENTITY_HEADER]: encodeIdentity({
          provider: 'tailscale-serve',
          login: 'brian@example.test',
          displayName: 'Brian',
        }),
      }),
    );
    expect(identity).toEqual({
      provider: 'tailscale-serve',
      subject: 'brian@example.test',
      displayName: 'Brian',
    });
  });

  test('omits displayName when the ingress identity carries none', () => {
    const identity = source.identify(
      context({
        [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
        [INTERNAL_INGRESS_IDENTITY_HEADER]: encodeIdentity({
          provider: 'tailscale-serve',
          login: 'brian@example.test',
        }),
      }),
    );
    expect(identity).toEqual({
      provider: 'tailscale-serve',
      subject: 'brian@example.test',
    });
    expect(identity).not.toHaveProperty('displayName');
  });

  test('returns null when the identity header is missing', () => {
    expect(
      source.identify(
        context({ [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken() }),
      ),
    ).toBeNull();
  });

  test('returns null when the internal token is absent (unattested)', () => {
    expect(
      source.identify(
        context({
          [INTERNAL_INGRESS_IDENTITY_HEADER]: encodeIdentity({
            provider: 'tailscale-serve',
            login: 'attacker@example.test',
          }),
        }),
      ),
    ).toBeNull();
  });

  test('returns null when the internal token is wrong', () => {
    expect(
      source.identify(
        context({
          [INTERNAL_API_TOKEN_HEADER]: 'not-the-real-token',
          [INTERNAL_INGRESS_IDENTITY_HEADER]: encodeIdentity({
            provider: 'tailscale-serve',
            login: 'attacker@example.test',
          }),
        }),
      ),
    ).toBeNull();
  });

  test('returns null when the request is not from a loopback environment', () => {
    expect(
      source.identify(
        context(
          {
            [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
            [INTERNAL_INGRESS_IDENTITY_HEADER]: encodeIdentity({
              provider: 'tailscale-serve',
              login: 'brian@example.test',
            }),
          },
          { incoming: { socket: { remoteAddress: '100.96.12.7' } } },
        ),
      ),
    ).toBeNull();
  });

  test('returns null for a wrong provider in the payload', () => {
    expect(
      source.identify(
        context({
          [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
          [INTERNAL_INGRESS_IDENTITY_HEADER]: encodeIdentity({
            provider: 'kontour-account',
            login: 'brian@example.test',
          }),
        }),
      ),
    ).toBeNull();
  });

  test('returns null for a non-base64url identity header', () => {
    expect(
      source.identify(
        context({
          [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
          [INTERNAL_INGRESS_IDENTITY_HEADER]: 'not valid base64url!!',
        }),
      ),
    ).toBeNull();
  });
});
