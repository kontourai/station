import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  PAIRING_SCOPE_FAMILY_INHERITED_LEAVES,
  requiredPairingScope,
} from '../../../security/pairing-route-scopes.js';
import { createSettingsRegistryRoutes } from '../settings-registry.js';

const CHECKED_IN_ARTIFACT = new URL(
  '../../../generated/settings-registry.json',
  import.meta.url,
);

describe('GET /api/settings/registry', () => {
  test('serves the checked-in artifact verbatim', async () => {
    const response = await createSettingsRegistryRoutes().request('/registry');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: boolean;
      data: { $comment: string; settings: unknown[] };
    };
    expect(body.success).toBe(true);
    // Byte-for-byte against the file on disk, not a re-derivation: the point
    // of the route is that it adds nothing to what the gate holds current.
    expect(body.data).toEqual(
      JSON.parse(readFileSync(CHECKED_IN_ARTIFACT, 'utf8')),
    );
  });

  test('every entry carries the fields an agent answers with', async () => {
    const response = await createSettingsRegistryRoutes().request('/registry');
    const { data } = (await response.json()) as {
      data: {
        settings: {
          id: string;
          label: string;
          scope: string;
          section: string;
          route: string;
        }[];
      };
    };
    expect(data.settings.length).toBeGreaterThanOrEqual(40);
    for (const entry of data.settings) {
      expect(entry.id, JSON.stringify(entry)).toBeTruthy();
      expect(entry.label, entry.id).toBeTruthy();
      expect(entry.scope, entry.id).toBeTruthy();
      expect(entry.route, entry.id).toBe(
        `/settings?view=${entry.section}&highlight=${entry.id}`,
      );
    }
  });

  test('carries no stored configuration value', async () => {
    // The tier below is justified by this: the registry says which controls
    // exist, never what they are set to. A future field that leaked a value
    // would make the read-tier classification wrong.
    const serialized = readFileSync(CHECKED_IN_ARTIFACT, 'utf8');
    const parsed = JSON.parse(serialized) as {
      settings: Record<string, unknown>[];
    };
    const allowed = new Set([
      'id',
      'label',
      'help',
      'scope',
      'section',
      'route',
      'configKey',
    ]);
    const unexpected = [
      ...new Set(parsed.settings.flatMap((entry) => Object.keys(entry))),
    ].filter((key) => !allowed.has(key));
    expect(unexpected).toEqual([]);
  });

  test('is classified at the read tier, as a reviewed family leaf', () => {
    expect(requiredPairingScope('GET', '/api/settings/registry')).toBe(
      'orchestration:read',
    );
    expect(
      PAIRING_SCOPE_FAMILY_INHERITED_LEAVES.some(
        (leaf) =>
          leaf.method === 'GET' && leaf.path === '/api/settings/registry',
      ),
    ).toBe(true);
  });
});
