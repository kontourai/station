import type { PairedDevice } from '@kontourai/station-contracts/environment-security';
import { expect, test } from 'vitest';
import { canReadAgentActivity } from '../agent-activity-eligibility.js';

const device = (overrides: Partial<PairedDevice> = {}): PairedDevice =>
  ({
    id: 'device-1',
    name: 'Pixel',
    scope: 'orchestration:read orchestration:operate',
    kind: 'device',
    createdAt: 1,
    revokedAt: null,
    ...overrides,
  }) as PairedDevice;

test.each([
  ['an active person device with orchestration:read', device(), true],
  ['a revoked device', device({ revokedAt: 5 }), false],
  ['a delegation grant', device({ kind: 'delegation' }), false],
  [
    'a device without orchestration:read',
    device({ scope: 'orchestration:operate inference:invoke' }),
    false,
  ],
  [
    'a device bound to a deployment account (its requests read as the account)',
    device({
      principalBinding: {
        kind: 'account',
        issuer: 'https://id.example.test',
        subject: 'account-1',
        displayName: 'Account',
        approvedAt: 1,
        approvalId: '22222222-2222-4222-8222-222222222222',
        approvedBy: 'human:local:operator',
      } as PairedDevice['principalBinding'],
    }),
    false,
  ],
  [
    'a tailnet person-bound device',
    device({
      principalBinding: {
        provider: 'tailscale-serve',
        subject: 'alice@example.com',
        approvedAt: 1,
        approvalId: '22222222-2222-4222-8222-222222222222',
        approvedBy: 'human:local:operator',
      } as PairedDevice['principalBinding'],
    }),
    true,
  ],
])('%s → %s', (_label, candidate, expected) => {
  expect(canReadAgentActivity(candidate)).toBe(expected);
});
