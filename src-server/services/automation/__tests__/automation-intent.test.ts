import type {
  AutomationActionIntent,
  AutomationSource,
} from '@kontourai/station-contracts/automation';
import { expect, test } from 'vitest';
import {
  automationAuthorityFingerprint,
  automationPolicyFingerprint,
  classifyAutomationPolicy,
} from '../automation-intent.js';
import { QUALIFICATION_RULE } from './fixtures/workflow-run-fixture.js';

const SOURCE: AutomationSource = {
  id: 'source-1',
  kind: 'github-poll',
  name: 'station',
  repository: 'kontourai/station',
  enabled: true,
  grants: [
    { projectId: 'station', agentId: 'repairer', actions: ['dispatch-task'] },
  ],
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

// #4511: only authority-bearing fields take part.
const LIVE = { ...QUALIFICATION_RULE, mode: 'live' as const };

test('cosmetic and scheduling edits keep the policy fingerprint (#4511)', () => {
  const base = automationPolicyFingerprint(SOURCE, LIVE);
  const cosmetic: [string, AutomationSource, typeof LIVE][] = [
    ['rule name', SOURCE, { ...LIVE, name: 'Renamed' }],
    [
      'rule rate limit',
      SOURCE,
      { ...LIVE, rateLimit: { maxStartsPerHour: 9 } },
    ],
    ['episode policy', SOURCE, { ...LIVE, episode: undefined }],
    ['source name', { ...SOURCE, name: 'renamed' }, LIVE],
    ['poll interval', { ...SOURCE, pollIntervalMs: 600_000 }, LIVE],
    [
      'an unrelated grant',
      {
        ...SOURCE,
        grants: [
          ...SOURCE.grants!,
          { projectId: 'other', agentId: 'other', actions: ['dispatch-task'] },
        ],
      },
      LIVE,
    ],
  ];
  for (const [label, source, rule] of cosmetic)
    expect(automationPolicyFingerprint(source, rule), label).toBe(base);
});

test('authority edits change the fingerprint; a removed grant or disabled source is a revocation (#4511)', () => {
  const base = automationPolicyFingerprint(SOURCE, LIVE);
  const action = LIVE.action as Extract<
    typeof LIVE.action,
    { kind: 'dispatch-task' }
  >;
  for (const [label, source, rule] of [
    [
      'matcher',
      SOURCE,
      { ...LIVE, match: { ...LIVE.match, where: { 'run.id': '1' } } },
    ],
    [
      'approval mode',
      SOURCE,
      { ...LIVE, action: { ...action, approvalMode: 'auto' } },
    ],
    ['agent', SOURCE, { ...LIVE, action: { ...action, agentId: 'other' } }],
    ['repository', { ...SOURCE, repository: 'kontourai/other' }, LIVE],
    ['source disabled', { ...SOURCE, enabled: false }, LIVE],
  ] as [string, AutomationSource, typeof LIVE][])
    expect(automationPolicyFingerprint(source, rule), label).not.toBe(base);
});

test('classification: an instructions or budget edit is an amendment; anything else revokes with its cause (#4511)', () => {
  const action = LIVE.action as Extract<
    typeof LIVE.action,
    { kind: 'dispatch-task' }
  >;
  const intent = {
    sourceId: SOURCE.id,
    ruleId: LIVE.id,
    policyFingerprint: automationPolicyFingerprint(SOURCE, LIVE),
    authorityFingerprint: automationAuthorityFingerprint(SOURCE, LIVE),
    event: { fields: { repository: SOURCE.repository } },
    action,
  } as unknown as AutomationActionIntent;
  expect(classifyAutomationPolicy(intent, SOURCE, LIVE).kind).toBe('current');
  expect(
    classifyAutomationPolicy(intent, SOURCE, { ...LIVE, name: 'Renamed' }).kind,
  ).toBe('current');
  expect(
    classifyAutomationPolicy(intent, SOURCE, {
      ...LIVE,
      action: {
        ...action,
        instructions: 'New text',
        budget: { ...action.budget, maxTurns: 1 },
      },
    }),
  ).toMatchObject({ kind: 'amended', changed: ['instructions', 'budget'] });
  for (const [cause, source, rule] of [
    ['rule-deleted', SOURCE, undefined],
    ['rule-disabled', SOURCE, { ...LIVE, mode: 'off' }],
    ['rule-observing', SOURCE, { ...LIVE, mode: 'observe' }],
    ['source-deleted', undefined, LIVE],
    ['source-disabled', { ...SOURCE, enabled: false }, LIVE],
    [
      'source-revoked',
      { ...SOURCE, revokedAt: '2026-11-06T00:00:00.000Z' },
      LIVE,
    ],
    ['grant-removed', { ...SOURCE, grants: [] }, LIVE],
    [
      'rule-changed',
      SOURCE,
      { ...LIVE, action: { ...action, approvalMode: 'auto' } },
    ],
  ] as const)
    expect(
      classifyAutomationPolicy(
        intent,
        source as AutomationSource | undefined,
        rule as typeof LIVE | undefined,
      ),
      cause,
    ).toEqual({ kind: 'revoked', cause });
  // An intent retained before #4511 has no authority fingerprint: an
  // amendment cannot be proven, so it is a revocation.
  const { authorityFingerprint: _omit, ...legacy } = intent;
  expect(
    classifyAutomationPolicy(legacy as AutomationActionIntent, SOURCE, {
      ...LIVE,
      action: { ...action, instructions: 'New text' },
    }),
  ).toEqual({ kind: 'revoked', cause: 'rule-changed' });
});
