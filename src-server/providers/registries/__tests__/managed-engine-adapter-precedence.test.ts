/**
 * #4520: a plugin adapter normally replaces the built-in adapter for its
 * engine. While the managed policy locks that engine's launch it does not,
 * because a plugin runtime would not apply the pinned launch fields.
 */
import {
  parseManagedPolicyDocument,
  summarizeManagedPolicy,
} from '@kontourai/station-contracts/managed-policy';
import { afterEach, describe, expect, test } from 'vitest';
import { installManagedEngineLimits } from '../../../security/managed-engine-limits.js';
import type { ProviderAdapterShape } from '../../adapter-shape.js';
import {
  clearAll,
  getProviderAdapter,
  registerProviderAdapter,
} from '../registry.js';

afterEach(() => {
  installManagedEngineLimits(null);
  clearAll();
});

function adapter(label: string): ProviderAdapterShape {
  return {
    provider: 'codex',
    metadata: { displayName: label, description: label, capabilities: [] },
  } as unknown as ProviderAdapterShape;
}

function pinCodex(locked: boolean) {
  const parsed = parseManagedPolicyDocument({
    schemaVersion: 1,
    organization: 'Acme',
    limits: {
      engines: { instances: { codex: { locked, binaryPath: '/opt/codex' } } },
    },
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
  installManagedEngineLimits({
    document: parsed.document,
    summary: summarizeManagedPolicy(parsed.document),
  });
}

describe('adapter precedence under a locked engine', () => {
  test.each([
    ['no policy', undefined, 'plugin'],
    ['an unlocked pin', false, 'plugin'],
    ['a locked pin', true, 'builtin'],
  ] as const)(
    'with %s (locked: %s) the %s adapter wins',
    (_label, locked, winner) => {
      if (locked !== undefined) pinCodex(locked);
      registerProviderAdapter(adapter('builtin'), { builtin: true });
      registerProviderAdapter(adapter('plugin'), { plugin: true });
      expect(getProviderAdapter('codex')?.metadata.displayName).toBe(winner);
    },
  );
});
