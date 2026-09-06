import type { PairedDevice } from '@kontourai/station-contracts';
import { describe, expect, it } from 'vitest';
import {
  DEVICE_ACTIVE_WINDOW_MS,
  describeDelegationStanding,
  describeDeviceActivity,
  describeDeviceKind,
  describeDeviceProvenance,
  describeDeviceRevocation,
  describeDeviceScope,
  deviceRevokeError,
  formatElapsed,
  partitionPairedDevices,
} from '../core/deviceActivity';

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function device(overrides: Partial<PairedDevice> = {}): PairedDevice {
  return {
    id: 'device-1',
    name: 'Pixel 9',
    scope: 'station:interactive',
    kind: 'device',
    createdAt: NOW - DAY,
    activityTracking: 'tracked-since-issued',
    lastSeenFrom: null,
    usageCount: 0,
    lastActiveDay: null,
    revokedAt: null,
    revocation: { state: 'not-revoked' },
    ...overrides,
  };
}

describe('formatElapsed', () => {
  it('reads sub-minute ages as the present', () => {
    expect(formatElapsed(NOW - 30_000, NOW)).toBe('just now');
  });

  it('singularizes and pluralizes each unit', () => {
    expect(formatElapsed(NOW - MINUTE, NOW)).toBe('1 minute ago');
    expect(formatElapsed(NOW - 8 * MINUTE, NOW)).toBe('8 minutes ago');
    expect(formatElapsed(NOW - HOUR, NOW)).toBe('1 hour ago');
    expect(formatElapsed(NOW - 5 * HOUR, NOW)).toBe('5 hours ago');
    expect(formatElapsed(NOW - DAY, NOW)).toBe('1 day ago');
    expect(formatElapsed(NOW - 3 * DAY, NOW)).toBe('3 days ago');
  });

  it('falls back to a date once elapsed time stops being readable', () => {
    const old = NOW - 40 * DAY;
    expect(formatElapsed(old, NOW)).toBe(new Date(old).toLocaleDateString());
  });

  it('clamps a future timestamp instead of counting backwards', () => {
    expect(formatElapsed(NOW + 5 * MINUTE, NOW)).toBe('just now');
  });
});

describe('activity tracking state', () => {
  it('does not portray migrated pre-tracking history as a never-used device', () => {
    expect(
      describeDeviceActivity(
        device({
          activityTracking: 'unobserved-before-activity-tracking',
          lastUsedAt: NOW - HOUR,
          usageCount: null,
          lastActiveDay: null,
          lastSeenFrom: null,
        }),
        NOW,
      ).lastUsedLabel,
    ).toBe('Activity before tracking is unavailable');
  });
});

describe('revocation provenance', () => {
  it('names a recorded operator revocation and never invents old provenance', () => {
    expect(
      describeDeviceRevocation(
        device({
          revokedAt: NOW - HOUR,
          revocation: {
            state: 'recorded',
            actor: 'operator-credential',
            reason: 'owner-request',
          },
        }),
      ),
    ).toBe('Revoked by the Station operator · Owner request');
    expect(
      describeDeviceRevocation(
        device({
          revokedAt: NOW - HOUR,
          revocation: { state: 'unobserved-before-revocation-provenance' },
        }),
      ),
    ).toBe('Revocation provenance unavailable');
  });
});

describe('describeDeviceActivity', () => {
  it('marks a device used inside the window as recently active', () => {
    const activity = describeDeviceActivity(
      device({ lastUsedAt: NOW - 30_000 }),
      NOW,
    );
    expect(activity.recentlyActive).toBe(true);
    expect(activity.lastUsedLabel).toBe('Active recently');
  });

  it('reports an elapsed time once the device falls outside the window', () => {
    const activity = describeDeviceActivity(
      device({ lastUsedAt: NOW - DEVICE_ACTIVE_WINDOW_MS - 1 }),
      NOW,
    );
    expect(activity.recentlyActive).toBe(false);
    expect(activity.lastUsedLabel).toBe('Last used 2 minutes ago');
  });

  it('distinguishes a device that has never connected', () => {
    const activity = describeDeviceActivity(
      device({ lastUsedAt: undefined }),
      NOW,
    );
    expect(activity.lastUsedLabel).toBe('Never used');
    expect(activity.recentlyActive).toBe(false);
  });

  it('never calls a revoked device active, however recently it was used', () => {
    const activity = describeDeviceActivity(
      device({ lastUsedAt: NOW - 1_000, revokedAt: NOW - 500 }),
      NOW,
    );
    expect(activity.recentlyActive).toBe(false);
    expect(activity.revokedLabel).toBe('Revoked just now');
  });

  it('always reports when the device was paired', () => {
    expect(describeDeviceActivity(device(), NOW).pairedLabel).toBe(
      'Paired 1 day ago',
    );
  });
});

describe('partitionPairedDevices', () => {
  it('separates devices that still have access from revoked ones', () => {
    const live = device({ id: 'live' });
    const dead = device({ id: 'dead', revokedAt: NOW - HOUR });
    const { active, revoked } = partitionPairedDevices([dead, live]);
    expect(active.map((d) => d.id)).toEqual(['live']);
    expect(revoked.map((d) => d.id)).toEqual(['dead']);
  });

  it('orders active devices by most recent activity', () => {
    const { active } = partitionPairedDevices([
      device({ id: 'stale', lastUsedAt: NOW - 10 * DAY }),
      device({ id: 'fresh', lastUsedAt: NOW - MINUTE }),
      device({ id: 'middling', lastUsedAt: NOW - HOUR }),
    ]);
    expect(active.map((d) => d.id)).toEqual(['fresh', 'middling', 'stale']);
  });

  it('falls back to pairing time for a device that never connected', () => {
    const { active } = partitionPairedDevices([
      device({
        id: 'never-old',
        lastUsedAt: undefined,
        createdAt: NOW - 5 * DAY,
      }),
      device({
        id: 'never-new',
        lastUsedAt: undefined,
        createdAt: NOW - MINUTE,
      }),
    ]);
    expect(active.map((d) => d.id)).toEqual(['never-new', 'never-old']);
  });

  it('orders revoked devices by when access was cut', () => {
    const { revoked } = partitionPairedDevices([
      device({ id: 'older', revokedAt: NOW - 5 * DAY }),
      device({ id: 'newer', revokedAt: NOW - HOUR }),
    ]);
    expect(revoked.map((d) => d.id)).toEqual(['newer', 'older']);
  });
});

describe('describeDeviceScope', () => {
  it('translates the legacy pre-scoping marker into copy', () => {
    expect(describeDeviceScope('station:interactive')).toBe(
      'Standard + device management',
    );
  });

  it('station#1398 slice 2: the default grant no longer claims "Full access", because it is no longer the whole vocabulary', () => {
    // These four tokens used to BE the vocabulary, so "Full access" was
    // accurate by construction. `inference:invoke` exists now and this set
    // deliberately withholds it, so the old label would tell an owner their
    // laptop can borrow this machine's GPU when it cannot.
    expect(
      describeDeviceScope(
        'orchestration:read orchestration:operate terminal:operate access:manage',
      ),
    ).toBe('Standard + device management');
    // The legacy marker keeps reading as the same thing it migrates to.
    expect(describeDeviceScope('station:interactive')).toBe(
      describeDeviceScope(
        'orchestration:read orchestration:operate terminal:operate access:manage',
      ),
    );
  });

  it('station#1398 slice 2: "Full access" is reserved for a scope that genuinely carries every token', () => {
    // "Every token" is the whole current vocabulary. access:approve joined
    // PAIRING_SCOPES in #1887 slice 1 and consent:decide in #3677, so the
    // home:transfer and home:control later brought the set to nine tokens.
    expect(
      describeDeviceScope(
        'orchestration:read orchestration:operate terminal:operate access:manage inference:invoke access:approve consent:decide home:transfer home:control',
      ),
    ).toBe('Full access');
    // Order-independent, like every other preset match.
    expect(
      describeDeviceScope(
        'home:control home:transfer consent:decide access:approve inference:invoke access:manage terminal:operate orchestration:operate orchestration:read',
      ),
    ).toBe('Full access');
    // A scope missing any single token (here consent:decide) is not Full.
    expect(
      describeDeviceScope(
        'orchestration:read orchestration:operate terminal:operate access:manage inference:invoke access:approve',
      ),
    ).toBe('Custom access');
  });

  it('station#1398 slice 2: labels the fleet-inference preset', () => {
    expect(describeDeviceScope('inference:invoke')).toBe('Fleet inference');
  });

  it('labels the dedicated home-transfer preset', () => {
    expect(describeDeviceScope('home:transfer')).toBe('Home transfer');
  });

  it('labels the operator-promoted home-control scope', () => {
    expect(describeDeviceScope('home:control')).toBe('Home control');
  });

  it('labels the read-only preset', () => {
    expect(describeDeviceScope('orchestration:read')).toBe('Read-only');
  });

  it('labels the standard preset regardless of token order', () => {
    expect(
      describeDeviceScope(
        'orchestration:read orchestration:operate terminal:operate',
      ),
    ).toBe('Standard');
    expect(
      describeDeviceScope(
        'terminal:operate orchestration:operate orchestration:read',
      ),
    ).toBe('Standard');
  });

  it('labels a valid but non-preset scope combination as custom access', () => {
    expect(describeDeviceScope('orchestration:read access:manage')).toBe(
      'Custom access',
    );
  });

  it('station#1123 slice 1: labels the delegation preset distinctly from standard/read-only', () => {
    expect(
      describeDeviceScope('orchestration:read orchestration:operate'),
    ).toBe('Delegation');
    expect(
      describeDeviceScope('orchestration:operate orchestration:read'),
    ).toBe('Delegation');
  });

  it('passes an unrecognized scope through rather than inventing a label', () => {
    expect(describeDeviceScope('station:future')).toBe('station:future');
  });
});

describe('describeDeviceKind (station#1123 slice 1)', () => {
  it('labels an ordinary paired device', () => {
    expect(describeDeviceKind('device')).toBe('Device');
  });

  it('labels a delegation grant distinctly', () => {
    expect(describeDeviceKind('delegation')).toBe('Delegation');
  });
});

describe('describeDeviceProvenance (station#1878 slice 1)', () => {
  it('renders nothing for a device paired before the field existed, rather than a guess', () => {
    expect(describeDeviceProvenance(device({ source: undefined }))).toBeNull();
  });

  it('labels a same-origin pairing', () => {
    expect(describeDeviceProvenance(device({ source: 'same-origin' }))).toBe(
      'Same-origin',
    );
  });

  it('labels a scanned/typed pairing code', () => {
    expect(describeDeviceProvenance(device({ source: 'pairing-code' }))).toBe(
      'Pairing code',
    );
  });

  it('names the verified tailnet requester by display name when present', () => {
    expect(
      describeDeviceProvenance(
        device({
          source: 'tailnet',
          requester: {
            provider: 'tailscale-serve',
            login: 'brian@example.test',
            displayName: 'Brian',
          },
        }),
      ),
    ).toBe('Tailnet · Brian');
  });

  it('falls back to the login when no display name was verified', () => {
    expect(
      describeDeviceProvenance(
        device({
          source: 'tailnet',
          requester: {
            provider: 'tailscale-serve',
            login: 'brian@example.test',
          },
        }),
      ),
    ).toBe('Tailnet · brian@example.test');
  });
});

describe('deviceRevokeError', () => {
  it('names the credential problem behind a 401', () => {
    expect(deviceRevokeError(401)).toMatch(/no longer has owner access/);
  });

  it('distinguishes a rejected origin from a missing device', () => {
    expect(deviceRevokeError(403)).toMatch(/app address/);
    expect(deviceRevokeError(404)).toMatch(/no longer in this Station/);
  });

  it('still reports an unexpected status rather than staying silent', () => {
    expect(deviceRevokeError(500)).toBe(
      'This Station could not revoke that device (HTTP 500).',
    );
  });
});

describe('describeDelegationStanding (station#3845)', () => {
  const device = (kind: PairedDevice['kind'], scope: string) =>
    ({ kind, scope }) as Pick<PairedDevice, 'kind' | 'scope'>;

  it('claims delegation only while the device can still operate', () => {
    expect(
      describeDelegationStanding(
        device('delegation', 'orchestration:read orchestration:operate'),
      ),
    ).toMatchObject({ label: 'Delegation' });
  });

  it('keeps the provenance but drops the claim once the scope no longer allows it', () => {
    // The defect: scope became editable (station#3816), so a delegation
    // device narrowed to Read-only kept advertising "may delegate work" —
    // an operator auditing the list read a capability that was gone.
    const narrowed = describeDelegationStanding(
      device('delegation', 'orchestration:read'),
    );
    expect(narrowed?.label).toBe('Paired for delegation');
    expect(narrowed?.title).toMatch(/no longer allows it/);
    // Provenance survives: "was paired to delegate and cannot now" is the
    // state someone needs in order to restore or revoke it.
    expect(narrowed?.title).toMatch(/paired to delegate work/);
  });

  it('says nothing about a device never minted for delegation', () => {
    expect(
      describeDelegationStanding(device('device', 'orchestration:operate')),
    ).toBeNull();
  });

  it('reads an unparseable legacy scope as unable, never as able', () => {
    expect(
      describeDelegationStanding(device('delegation', 'legacy-unparseable')),
    ).toMatchObject({ label: 'Paired for delegation' });
  });
});
