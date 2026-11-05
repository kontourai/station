/**
 * #4515: every managed-policy slice adds keys. The parsed document and the
 * client summary rebuild `limits` from `MANAGED_POLICY_LIMIT_SLICES`, and the
 * status decode reads it with `MANAGED_POLICY_SUMMARY_LIMIT_READERS`. This
 * sets every enforced key at once and checks each one survives all three, so
 * a merge that registers a slice in only one place, or drops one, fails here.
 */
import { describe, expect, test } from 'vitest';
import {
  MANAGED_POLICY_ENFORCED_LIMIT_KEYS,
  MANAGED_POLICY_SUMMARY_LIMIT_READERS,
  parseManagedPolicyDocument,
  parseManagedPolicyStatus,
  summarizeManagedPolicy,
} from '../managed-policy.js';
import {
  EVERY_KEY_ENGINE_GATEWAY,
  EVERY_KEY_ENGINE_SUMMARY,
  EVERY_KEY_FEED_URL,
  EVERY_KEY_LIMITS,
  EVERY_KEY_POLICY,
  EVERY_KEY_SETTINGS,
  EVERY_KEY_SUMMARY_LIMITS,
} from './managed-policy-every-key.fixture.js';

describe('a policy that sets every enforced key at once', () => {
  test('the fixture sets every enforced limit key', () => {
    expect(Object.keys(EVERY_KEY_LIMITS).sort()).toEqual(
      [...MANAGED_POLICY_ENFORCED_LIMIT_KEYS].sort(),
    );
    // Pinned independently of the constant under test: the keys the four
    // landed slices enforce (#4521, #4519, #4522).
    expect(Object.keys(EVERY_KEY_LIMITS).sort()).toEqual([
      'clients',
      'engines',
      'registries',
      'telemetry',
      'updates',
      'webhookAutomations',
    ]);
    // The status decode reads `summary.limits` with one reader per limit,
    // apart from the document slices, and `summary.engines` (#4520) with the
    // engine summary parser; every enforced key needs one of the two.
    expect(
      [...Object.keys(MANAGED_POLICY_SUMMARY_LIMIT_READERS), 'engines'].sort(),
    ).toEqual([...MANAGED_POLICY_ENFORCED_LIMIT_KEYS].sort());
  });

  test('every value survives the parsed document, the summary and the status decode', () => {
    // Through JSON text, as a policy file and a status response arrive.
    const parsed = parseManagedPolicyDocument(
      JSON.parse(JSON.stringify(EVERY_KEY_POLICY)),
    );
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
    // The document keeps every value as written, the feed URL included.
    expect(parsed.document).toEqual(EVERY_KEY_POLICY);

    const summary = summarizeManagedPolicy(parsed.document);
    expect(summary).toEqual({
      organization: 'Acme',
      supportUrl: 'https://help.example/station',
      lockedSettings: ['defaultMaxTurns'],
      limits: EVERY_KEY_SUMMARY_LIMITS,
      engines: EVERY_KEY_ENGINE_SUMMARY,
    });
    const wire = JSON.stringify({
      state: 'loaded',
      source: { kind: 'file', location: '/etc/station/policy.json' },
      digest: `sha256:${'b'.repeat(64)}`,
      summary,
    });
    // The summary carries no setting value and never the mirror's URL.
    expect(wire).not.toContain(EVERY_KEY_FEED_URL);
    expect(wire).not.toContain('mirror.example');
    expect(wire).not.toContain('feedUrl');
    // Nor a pinned engine value: names only.
    expect(wire).not.toContain(EVERY_KEY_ENGINE_GATEWAY);
    expect(wire).not.toContain('/opt/acme');
    expect(wire).not.toContain(
      String(EVERY_KEY_SETTINGS.checkoutStaleAfterDays.value),
    );

    const status = parseManagedPolicyStatus(JSON.parse(wire));
    expect(status).toEqual({
      state: 'loaded',
      source: { kind: 'file', location: '/etc/station/policy.json' },
      digest: `sha256:${'b'.repeat(64)}`,
      summary: {
        organization: 'Acme',
        supportUrl: 'https://help.example/station',
        lockedSettings: ['defaultMaxTurns'],
        limits: EVERY_KEY_SUMMARY_LIMITS,
        engines: EVERY_KEY_ENGINE_SUMMARY,
      },
    });
  });

  test('the status decode refuses a summary that names the feed URL in place of its projection', () => {
    const parsed = parseManagedPolicyDocument(EVERY_KEY_POLICY);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
    const status = (limits: unknown) =>
      parseManagedPolicyStatus({
        state: 'loaded',
        source: { kind: 'file', location: '/etc/station/policy.json' },
        digest: `sha256:${'b'.repeat(64)}`,
        summary: { ...summarizeManagedPolicy(parsed.document), limits },
      });
    // The document shape is not a summary: `mirror` is required there.
    expect(status(EVERY_KEY_LIMITS)).toBeNull();
    // Engines are summarized beside `limits`, never inside it (#4520).
    expect(
      status({
        ...EVERY_KEY_SUMMARY_LIMITS,
        engines: EVERY_KEY_ENGINE_SUMMARY,
      }),
    ).toBeNull();
    // And a document must not use the summary's `mirror` key.
    expect(
      parseManagedPolicyDocument({
        ...EVERY_KEY_POLICY,
        limits: EVERY_KEY_SUMMARY_LIMITS,
      }).ok,
    ).toBe(false);
  });
});
