import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../identity/principal-resolver.js';
import {
  NativeSurfaceOperatorAuthority,
  NativeSurfaceRegistry,
  type NativeSurfaceTuple,
} from '../native-surface-registry.js';

const makeTempDir = trackTempDirs();

const homes: string[] = [];
const stores: NativeSurfaceRegistry[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const home = makeTempDir('native-surface-registry-');
  homes.push(home);
  const tuple: NativeSurfaceTuple = {
    scope: {
      stationId: randomUUID(),
      enrollmentId: randomUUID(),
      routingGeneration: 1,
    },
    surface: {
      kind: 'station-native',
      appIdentifier: 'io.kontourai.station',
      channel: 'nightly',
      clientInstanceId: randomUUID(),
      keyThumbprint: 'T'.repeat(43),
    },
  };
  const registry = new NativeSurfaceRegistry(home, tuple.scope.stationId);
  stores.push(registry);
  return {
    home,
    tuple,
    registry,
    authority: new NativeSurfaceOperatorAuthority(),
  };
}

describe('operator-approved native surface registry', () => {
  test('freezes exact operator-reviewed surface and refuses wrong identity, operation and reuse', () => {
    const h = fixture();
    expect(() =>
      h.authority.approve('human:deployment:other', 'approve', h.tuple),
    ).toThrow('operator_required');
    expect(() =>
      h.authority.approve(LOCAL_OPERATOR_PRINCIPAL_ID, 'approve', {
        ...h.tuple,
        surface: { ...h.tuple.surface, keyThumbprint: 'bad' },
      }),
    ).toThrow();
    expect(() =>
      h.authority.approve(LOCAL_OPERATOR_PRINCIPAL_ID, 'approve', {
        ...h.tuple,
        surface: { ...h.tuple.surface, credential: 'secret' },
      }),
    ).toThrow();
    const context = h.authority.approve(
      LOCAL_OPERATOR_PRINCIPAL_ID,
      'approve',
      h.tuple,
    );
    Object.assign(h.tuple.surface, { keyThumbprint: 'X'.repeat(43) });
    const admission = h.registry.approve(context);
    expect(admission.surface.keyThumbprint).toBe('T'.repeat(43));
    expect(admission.isCurrent()).toBe(true);
    expect(() => h.registry.approve(context)).toThrow('approval_reused');
    expect(() =>
      h.registry.revoke(
        h.authority.approve(LOCAL_OPERATOR_PRINCIPAL_ID, 'approve', {
          scope: admission.scope,
          surface: admission.surface,
        }),
      ),
    ).toThrow('operator_required');
    expect(h.registry.approvedSurfaces()).toHaveLength(1);
  });

  test('durable cross-owner revocation invalidates captured peers and cannot be reapproved', () => {
    const h = fixture();
    const admission = h.registry.approve(
      h.authority.approve(LOCAL_OPERATOR_PRINCIPAL_ID, 'approve', h.tuple),
    );
    const reopened = new NativeSurfaceRegistry(h.home, h.tuple.scope.stationId);
    stores.push(reopened);
    expect(reopened.approvedSurfaces()[0]?.approvalId).toBe(
      admission.approvalId,
    );
    reopened.revoke(
      h.authority.approve(LOCAL_OPERATOR_PRINCIPAL_ID, 'revoke', h.tuple),
    );
    expect(admission.isCurrent()).toBe(false);
    expect(h.registry.approvedSurfaces()).toEqual([]);
    expect(() =>
      h.registry.approve(
        h.authority.approve(LOCAL_OPERATOR_PRINCIPAL_ID, 'approve', h.tuple),
      ),
    ).toThrow('revoked');
  });

  test('fails closed for a foreign Station database and corrupted persisted tuples', () => {
    const h = fixture();
    const admission = h.registry.approve(
      h.authority.approve(LOCAL_OPERATOR_PRINCIPAL_ID, 'approve', h.tuple),
    );
    expect(() => new NativeSurfaceRegistry(h.home, randomUUID())).toThrow(
      'station_mismatch',
    );
    const db = new DatabaseSync(
      join(h.home, 'security', 'native-surfaces.sqlite'),
    );
    try {
      db.prepare('UPDATE native_surfaces SET record=?').run('{}');
      expect(admission.isCurrent()).toBe(false);
      expect(() => h.registry.approvedSurfaces()).toThrow();
    } finally {
      db.close();
    }
  });

  test('caps historical approvals so repeated revocations cannot bypass capacity', () => {
    const h = fixture();
    for (let index = 0; index < 16; index++) {
      const tuple = {
        ...h.tuple,
        surface: { ...h.tuple.surface, clientInstanceId: randomUUID() },
      };
      h.registry.approve(
        h.authority.approve(LOCAL_OPERATOR_PRINCIPAL_ID, 'approve', tuple),
      );
      h.registry.revoke(
        h.authority.approve(LOCAL_OPERATOR_PRINCIPAL_ID, 'revoke', tuple),
      );
    }
    expect(() =>
      h.registry.approve(
        h.authority.approve(LOCAL_OPERATOR_PRINCIPAL_ID, 'approve', h.tuple),
      ),
    ).toThrow('capacity');
  });
});
