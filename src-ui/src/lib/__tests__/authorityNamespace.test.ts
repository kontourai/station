/**
 * #481 — stable durable namespace encoding.
 *
 * Pure unit coverage for `lib/authorityNamespace.ts`: canonical encoding,
 * live-fact exclusion, and the legacy quarantine boundary. Provider-tree
 * discrimination (two homes, delayed activation, revocation) lives in
 * `src-ui/src/__tests__/authorityQueryIsolation.test.tsx`.
 */
import { describe, expect, it } from 'vitest';
import {
  AUTHORITY_CACHE_KEY_PREFIX,
  authorityPersistenceKey,
  buildAuthorityNamespace,
  LEGACY_AUTHORITY_CACHE_KEY,
} from '../authorityNamespace';
import { QUERY_PERSISTENCE_STORAGE_KEY } from '../queryPersistence';

const operatorObservation = {
  schemaVersion: 'station.authority-observation/v1',
  environmentId: '11111111-1111-4111-8111-111111111111',
  principal: { kind: 'human', id: 'human:local:operator' },
  grant: { kind: 'operator' },
} as const;

const deviceObservation = {
  schemaVersion: 'station.authority-observation/v1',
  environmentId: '11111111-1111-4111-8111-111111111111',
  principal: { kind: 'human', id: 'human:local:operator' },
  grant: {
    kind: 'device',
    deviceId: 'device-abc',
    grantedScopes: ['orchestration:read', 'pairing:chat'],
  },
} as const;

describe('buildAuthorityNamespace', () => {
  it('encodes the operator tuple canonically', () => {
    expect(buildAuthorityNamespace({ ...operatorObservation })).toBe(
      'v1|env=11111111-1111-4111-8111-111111111111|principal=human:human%3Alocal%3Aoperator|grant=operator',
    );
  });

  it('sorts granted scopes so wire order cannot fork the shelf', () => {
    const shuffled = {
      ...deviceObservation,
      grant: {
        ...deviceObservation.grant,
        grantedScopes: ['pairing:chat', 'orchestration:read'],
      },
    };
    expect(buildAuthorityNamespace({ ...deviceObservation })).toBe(
      buildAuthorityNamespace(shuffled),
    );
  });

  it('dedupes repeat scopes without changing the namespace', () => {
    const duplicated = {
      ...deviceObservation,
      grant: {
        ...deviceObservation.grant,
        grantedScopes: ['pairing:chat', 'orchestration:read', 'pairing:chat'],
      },
    };
    expect(buildAuthorityNamespace(duplicated)).toBe(
      buildAuthorityNamespace({ ...deviceObservation }),
    );
  });

  it('discriminates operator from device grants on the same home and principal', () => {
    expect(buildAuthorityNamespace({ ...deviceObservation })).not.toBe(
      buildAuthorityNamespace({ ...operatorObservation }),
    );
  });

  it('discriminates principals sharing one endpoint — the origin is not identity', () => {
    const other = {
      ...operatorObservation,
      principal: { kind: 'human', id: 'human:local:second' },
    } as const;
    const a = buildAuthorityNamespace({ ...operatorObservation });
    const b = buildAuthorityNamespace(other);
    expect(a).not.toBe(b);
    // Neither namespace names the endpoint: origins are not in the tuple.
    expect(a).not.toContain('station');
    expect(a).not.toContain('3141');
  });

  it('discriminates tenant from human principals', () => {
    const tenant = {
      ...operatorObservation,
      principal: { kind: 'tenant', id: 'tenant:acme' },
    } as const;
    expect(buildAuthorityNamespace(tenant)).not.toBe(
      buildAuthorityNamespace({ ...operatorObservation }),
    );
  });

  it('carries no credential material, hashes, or binding secrets', () => {
    const namespace = buildAuthorityNamespace({ ...deviceObservation });
    for (const forbidden of ['Bearer', 'token', 'secret', 'hash', 'binding']) {
      expect(namespace.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('is deterministic across calls (no epoch/generation churn by construction)', () => {
    // The observation type carries no activationEpoch/authorityGeneration —
    // this pins that repeated builds of the same observed facts agree, so a
    // re-pair or tab churn can never orphan a shelf.
    expect(buildAuthorityNamespace({ ...deviceObservation })).toBe(
      buildAuthorityNamespace({ ...deviceObservation }),
    );
  });
});

describe('authorityPersistenceKey', () => {
  it('namespaces disjoint shelves under the shared prefix', () => {
    const a = authorityPersistenceKey(
      buildAuthorityNamespace({ ...operatorObservation }),
    );
    const b = authorityPersistenceKey(
      buildAuthorityNamespace({ ...deviceObservation }),
    );
    expect(a).not.toBe(b);
    expect(a.startsWith(`${AUTHORITY_CACHE_KEY_PREFIX}::`)).toBe(true);
  });

  it('never produces the legacy singleton — quarantine is structural', () => {
    expect(LEGACY_AUTHORITY_CACHE_KEY).toBe(QUERY_PERSISTENCE_STORAGE_KEY);
    const namespaced = authorityPersistenceKey(
      buildAuthorityNamespace({ ...operatorObservation }),
    );
    expect(namespaced).not.toBe(LEGACY_AUTHORITY_CACHE_KEY);
  });
});
