import { describe, expect, test } from 'vitest';
import {
  type AccessEndpoint,
  KNOWN_ENVIRONMENT_SCHEMA_VERSION,
  type KnownEnvironment,
  type KnownEnvironmentSource,
} from '../known-environment.js';

describe('known-environment contracts', () => {
  test('fixes the schema version', () => {
    expect(KNOWN_ENVIRONMENT_SCHEMA_VERSION).toBe(1);
  });

  test('a fully-populated KnownEnvironment matches the declared shape', () => {
    const endpoint: AccessEndpoint = {
      id: 'endpoint-1',
      httpBaseUrl: 'https://box-b.tailnet.ts.net',
      kind: 'direct',
      preferred: true,
      addedAt: 1000,
      lastVerifiedAt: 2000,
    };
    const environment: KnownEnvironment = {
      schemaVersion: KNOWN_ENVIRONMENT_SCHEMA_VERSION,
      id: 'known-env-1',
      environmentId: 'environment-fixture',
      label: 'Box B',
      source: 'paired',
      endpoints: [endpoint],
      createdAt: 1000,
      updatedAt: 2000,
    };
    expect(environment.endpoints).toHaveLength(1);
    expect(environment.environmentId).toBe('environment-fixture');
  });

  test('an environment that has never been reached omits environmentId', () => {
    const environment: KnownEnvironment = {
      schemaVersion: KNOWN_ENVIRONMENT_SCHEMA_VERSION,
      id: 'known-env-2',
      label: 'Unverified box',
      source: 'manual',
      endpoints: [],
      createdAt: 1000,
      updatedAt: 1000,
    };
    expect(environment.environmentId).toBeUndefined();
  });

  test('every KnownEnvironmentSource is a distinct mechanism tag', () => {
    const sources: KnownEnvironmentSource[] = [
      'manual',
      'ssh',
      'paired',
      'discovered',
    ];
    expect(new Set(sources).size).toBe(sources.length);
  });
});
