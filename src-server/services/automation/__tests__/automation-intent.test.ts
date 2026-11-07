import type { AutomationSource } from '@kontourai/station-contracts/automation';
import { expect, test } from 'vitest';
import { automationPolicyFingerprint } from '../automation-intent.js';
import { QUALIFICATION_RULE } from './fixtures/workflow-run-fixture.js';

const SOURCE: AutomationSource = {
  id: 'source-1',
  kind: 'github-poll',
  name: 'station',
  repository: 'kontourai/station',
  enabled: true,
  grants: [{ projectId: 'station', agentId: 'repairer', actions: ['notify'] }],
};

// Both consumers compare a retained intent's fingerprint with the current
// rule's (#4509). Intents are retained only for `live` rules, so a rule moved
// to `observe` or `off` must hash differently for its intents to be refused
// even without the consumers' explicit mode check.
test('the policy fingerprint changes with the rule mode', () => {
  const live = automationPolicyFingerprint(SOURCE, {
    ...QUALIFICATION_RULE,
    mode: 'live',
  });
  expect(live).toMatch(/^[0-9a-f]{64}$/);
  for (const mode of ['observe', 'off'] as const)
    expect(
      automationPolicyFingerprint(SOURCE, { ...QUALIFICATION_RULE, mode }),
    ).not.toBe(live);
  expect(
    automationPolicyFingerprint(SOURCE, {
      ...QUALIFICATION_RULE,
      mode: 'live',
    }),
  ).toBe(live);
});
