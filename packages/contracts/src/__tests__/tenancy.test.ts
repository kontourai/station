import { describe, expect, it } from 'vitest';
import type { SessionReadAuthority } from '../tenancy.js';
import {
  canonicalTenantAuthority,
  INTERNAL_SESSION_READ_SCOPE,
  isHostedSessionReadAuthority,
  isSessionReadAuthority,
  parseHostedTenantRegistry,
  resolveHostedTenant,
  sessionReadAuthorityFromRequest,
  tenantExecutionContextFromRequest,
  tenantExecutionContextFromSession,
} from '../tenancy.js';

const registry = {
  schemaVersion: 1,
  tenants: [
    { id: 'alpha_01', authority: 'Alpha.Example.test' },
    { id: 'bravo', authority: 'bravo.example.test:8443' },
  ],
};

describe('hosted tenant registry', () => {
  it('mints immutable request authority from trusted context and loaded configuration', () => {
    const parsed = parseHostedTenantRegistry(registry);
    const requestContext = Object.freeze({
      tenantId: resolveHostedTenant(parsed, 'alpha.example.test')!,
    });
    const authority = sessionReadAuthorityFromRequest(
      'current-user',
      requestContext,
      parsed,
    );

    expect(authority).toMatchObject({
      userId: 'current-user',
      mode: 'hosted',
      tenantExecutionContext: { tenantId: 'alpha_01', source: 'request' },
    });
    expect(Object.isFrozen(authority)).toBe(true);
    expect(Object.isFrozen(authority.tenantExecutionContext)).toBe(true);
    expect(isSessionReadAuthority(authority)).toBe(true);
    expect(isHostedSessionReadAuthority(authority)).toBe(true);
  });

  it('keeps personal authority valid without accepting a caller-controlled mode', () => {
    const authority = sessionReadAuthorityFromRequest(
      'current-user',
      undefined,
      undefined,
    );

    expect(authority).toMatchObject({
      userId: 'current-user',
      mode: 'personal',
      tenantExecutionContext: undefined,
    });
    expect(isHostedSessionReadAuthority(authority)).toBe(false);
  });

  it('represents missing hosted request context for a later fail-closed policy', () => {
    const authority = sessionReadAuthorityFromRequest(
      'current-user',
      undefined,
      parseHostedTenantRegistry(registry),
    );

    expect(authority).toMatchObject({
      mode: 'hosted',
      tenantExecutionContext: undefined,
    });
  });

  it('rejects a trusted-context misuse for an unknown configured tenant', () => {
    const parsed = parseHostedTenantRegistry(registry);

    expect(() =>
      sessionReadAuthorityFromRequest(
        'current-user',
        { tenantId: tenantIdForTest('unconfigured') },
        parsed,
      ),
    ).toThrow('Unknown hosted tenant read authority');
  });

  it('keeps authority opaque to plain request-body shapes and names aggregate reads', () => {
    const untrustedBody = {
      userId: 'current-user',
      tenantExecutionContext: { tenantId: 'alpha_01', source: 'request' },
      mode: 'hosted' as const,
    };

    expectTypeOf(untrustedBody).not.toMatchTypeOf<SessionReadAuthority>();
    expect(isSessionReadAuthority(untrustedBody)).toBe(false);
    expect(INTERNAL_SESSION_READ_SCOPE).toEqual({
      kind: 'internal-session-read-aggregate',
    });
    expect(Object.isFrozen(INTERNAL_SESSION_READ_SCOPE)).toBe(true);
  });

  it('derives an immutable execution context only from a trusted context', () => {
    const request = Object.freeze({ tenantId: 'alpha_01' as any });
    const execution = tenantExecutionContextFromRequest(request);
    const resumed = tenantExecutionContextFromSession(execution);

    expect(execution).toEqual({ tenantId: 'alpha_01', source: 'request' });
    expect(resumed).toEqual({ tenantId: 'alpha_01', source: 'session' });
    expect(Object.isFrozen(execution)).toBe(true);
    expect(Object.isFrozen(resumed)).toBe(true);
  });

  it('canonicalizes exact DNS authorities while preserving explicit ports', () => {
    const parsed = parseHostedTenantRegistry(registry);
    expect(parsed.authorityToTenant).toEqual({
      'alpha.example.test': 'alpha_01',
      'bravo.example.test:8443': 'bravo',
    });
    expect(resolveHostedTenant(parsed, 'ALPHA.example.test')).toBe('alpha_01');
    expect(resolveHostedTenant(parsed, 'bravo.example.test')).toBeUndefined();
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it.each([
    '',
    'https://alpha.example.test',
    'alpha.example.test/path',
    'user@alpha.example.test',
    '*.example.test',
    'alpha.example.test:0',
    'alpha.example.test:65536',
    'alpha.example.test:080',
    '127.0.0.1',
    '[::1]',
    'alpha.example.test,bravo.example.test',
    'alpha.example.test.',
  ])('rejects unsafe or ambiguous authority %s', (authority) => {
    expect(() => canonicalTenantAuthority(authority)).toThrow(
      'Invalid hosted tenant authority',
    );
  });

  it.each([
    {},
    { schemaVersion: 2, tenants: [] },
    { schemaVersion: 1, tenants: [] },
    {
      schemaVersion: 1,
      tenants: [{ id: 'bad id', authority: 'a.example.test' }],
    },
    {
      schemaVersion: 1,
      tenants: [{ id: 'a', authority: 'a.example.test', extra: true }],
    },
    {
      schemaVersion: 1,
      tenants: [
        { id: 'a', authority: 'a.example.test' },
        { id: 'a', authority: 'b.example.test' },
      ],
    },
    {
      schemaVersion: 1,
      tenants: [
        { id: 'a', authority: 'A.example.test' },
        { id: 'b', authority: 'a.example.test' },
      ],
    },
  ])('rejects malformed registry input', (input) => {
    expect(() => parseHostedTenantRegistry(input)).toThrow();
  });
});

function tenantIdForTest(value: string) {
  return resolveHostedTenant(
    parseHostedTenantRegistry({
      schemaVersion: 1,
      tenants: [{ id: value, authority: `${value}.example.test` }],
    }),
    `${value}.example.test`,
  )!;
}
