/**
 * #4521: the capability switches in the policy parser, the client summary and
 * the status boundary. A switch accepts only `false`, so a policy can turn a
 * capability off but never force it on.
 */
import { describe, expect, test } from 'vitest';
import {
  capabilityLimitProblems,
  MANAGED_POLICY_ENFORCED_LIMIT_KEYS,
  MANAGED_POLICY_RESERVED_LIMIT_KEYS,
  managedRegistryLocationAllowed,
  managedTelemetryAllowed,
  managedWebhookAutomationsAllowed,
  normalizeManagedRegistryUrl,
  parseManagedPolicyDocument,
  parseManagedPolicyStatus,
  summarizeManagedPolicy,
} from '../managed-policy.js';

const base = { schemaVersion: 1, organization: 'Acme' } as const;

function problemsOf(limits: unknown) {
  const result = parseManagedPolicyDocument({ ...base, limits });
  if (result.ok) throw new Error('expected the document to be refused');
  return result.problems;
}

describe('capability switches in the policy document', () => {
  test('the three keys are enforced and no longer reserved', () => {
    for (const key of ['telemetry', 'webhookAutomations', 'registries']) {
      expect(MANAGED_POLICY_ENFORCED_LIMIT_KEYS).toContain(key);
      expect(MANAGED_POLICY_RESERVED_LIMIT_KEYS).not.toContain(key);
    }
  });

  test('accepts every switch turned off and keeps it in the document and summary', () => {
    const limits = {
      telemetry: false,
      webhookAutomations: false,
      registries: {
        allowedUrls: ['https://plugins.example.com/registry.json'],
        unsignedPackages: false,
        defaultSkillRegistries: false,
        acpRegistryInstalls: false,
      },
    };
    const parsed = parseManagedPolicyDocument({ ...base, limits });
    expect(parsed).toEqual({ ok: true, document: { ...base, limits } });
    if (!parsed.ok) return;
    expect(summarizeManagedPolicy(parsed.document).limits).toEqual(limits);
  });

  test('refuses true: a policy can never force a capability on', () => {
    expect(
      problemsOf({
        telemetry: true,
        webhookAutomations: true,
        registries: {
          unsignedPackages: true,
          defaultSkillRegistries: true,
          acpRegistryInstalls: 'no',
        },
      }).map((problem) => problem.path),
    ).toEqual([
      'limits.telemetry',
      'limits.webhookAutomations',
      'limits.registries.unsignedPackages',
      'limits.registries.defaultSkillRegistries',
      'limits.registries.acpRegistryInstalls',
    ]);
    expect(problemsOf({ telemetry: true })[0]?.message).toBe(
      'must be false; a policy can turn telemetry off but never on, so omit the key to leave it to each user',
    );
  });

  test('refuses an unknown registries key and a malformed allow list', () => {
    expect(problemsOf({ registries: { trustedKeys: {} } })).toEqual([
      {
        path: 'limits.registries.trustedKeys',
        message:
          'unknown key; this version of Station refuses keys it cannot enforce',
      },
    ]);
    expect(problemsOf({ registries: [] })).toEqual([
      { path: 'limits.registries', message: 'must be an object' },
    ]);
    expect(
      problemsOf({
        registries: {
          allowedUrls: [
            'ftp://x.example/r',
            'https://user:pw@x.example/r',
            'https://x.example/r?token=1',
            'github:owner/repo',
            'https://x.example/r/',
            'https://x.example/r',
            7,
          ],
        },
      }).map((problem) => `${problem.path}: ${problem.message}`),
    ).toEqual([
      'limits.registries.allowedUrls[0]: must be an https URL without a user name, password, query or fragment',
      'limits.registries.allowedUrls[1]: must be an https URL without a user name, password, query or fragment',
      'limits.registries.allowedUrls[2]: must be an https URL without a user name, password, query or fragment',
      'limits.registries.allowedUrls[3]: must be an https URL of at most 2048 characters',
      'limits.registries.allowedUrls[5]: repeats an earlier URL',
      'limits.registries.allowedUrls[6]: must be an https URL of at most 2048 characters',
    ]);
    expect(
      problemsOf({
        registries: {
          allowedUrls: Array.from(
            { length: 65 },
            (_, i) => `https://r${i}.example`,
          ),
        },
      }),
    ).toEqual([
      {
        path: 'limits.registries.allowedUrls',
        message: 'must list at most 64 URLs',
      },
    ]);
  });

  test('refuses an http allow-list entry at load: a registry read over http can be altered in transit', () => {
    expect(
      problemsOf({
        registries: {
          allowedUrls: [
            'https://plugins.example.com/registry.json',
            'http://plugins.example.com/registry.json',
            'HTTP://mirror.example/r',
          ],
        },
      }),
    ).toEqual([
      {
        path: 'limits.registries.allowedUrls[1]',
        message:
          'must use https; a registry read over http can be altered in transit',
      },
      {
        path: 'limits.registries.allowedUrls[2]',
        message:
          'must use https; a registry read over http can be altered in transit',
      },
    ]);
    // The status boundary refuses a summary that lists one, too.
    expect(
      parseManagedPolicyStatus({
        state: 'loaded',
        source: { kind: 'file', location: '/etc/station/policy.json' },
        digest: `sha256:${'a'.repeat(64)}`,
        summary: {
          organization: 'Acme',
          supportUrl: null,
          lockedSettings: [],
          limits: { registries: { allowedUrls: ['http://x.example/r'] } },
        },
      }),
    ).toBeNull();
  });

  test('an http location never matches an https entry, and the bundled catalog stays allowed', () => {
    const registries = {
      allowedUrls: ['https://plugins.example.com/registry.json'],
    };
    expect(
      managedRegistryLocationAllowed(
        registries,
        'http://plugins.example.com/registry.json',
      ),
    ).toBe(false);
    expect(
      managedRegistryLocationAllowed(registries, '/opt/station/catalog', true),
    ).toBe(true);
  });

  test('an empty allow list is accepted and allows nothing but the bundled catalog', () => {
    const registries = { allowedUrls: [] };
    expect(capabilityLimitProblems({ registries })).toEqual([]);
    expect(
      managedRegistryLocationAllowed(registries, 'https://a.example/r'),
    ).toBe(false);
    expect(managedRegistryLocationAllowed(registries, '/opt/x', true)).toBe(
      true,
    );
  });
});

describe('capability predicates', () => {
  test('telemetry and webhooks are allowed unless the switch is false', () => {
    expect(managedTelemetryAllowed(undefined)).toBe(true);
    expect(managedTelemetryAllowed({})).toBe(true);
    expect(managedTelemetryAllowed({ telemetry: false })).toBe(false);
    expect(managedWebhookAutomationsAllowed({})).toBe(true);
    expect(
      managedWebhookAutomationsAllowed({ webhookAutomations: false }),
    ).toBe(false);
  });

  test('registry locations compare as parsed URLs, never as substrings', () => {
    const registries = {
      allowedUrls: [
        'https://plugins.example.com/registry.json',
        'https://github.com/acme/skills',
      ],
    };
    const allowed = (location: string | undefined) =>
      managedRegistryLocationAllowed(registries, location);
    expect(allowed('https://PLUGINS.example.com/registry.json')).toBe(true);
    expect(allowed('github:acme/skills')).toBe(true);
    expect(allowed('https://github.com/acme/skills/')).toBe(true);
    // Prefix, suffix and lookalike locations are refused.
    expect(allowed('https://plugins.example.com/registry.json.evil')).toBe(
      false,
    );
    expect(allowed('https://plugins.example.com.evil/registry.json')).toBe(
      false,
    );
    expect(allowed('https://github.com/acme/skills-fork')).toBe(false);
    // A local folder is not a listed URL.
    expect(allowed('/Users/me/skills')).toBe(false);
    expect(allowed(undefined)).toBe(false);
    // Without an allow list every location is allowed.
    expect(managedRegistryLocationAllowed({}, '/Users/me/skills')).toBe(true);
    expect(normalizeManagedRegistryUrl('github:acme/skills')).toBe(
      'https://github.com/acme/skills',
    );
  });
});

describe('the status boundary', () => {
  const loaded = (limits: unknown) => ({
    state: 'loaded',
    source: { kind: 'file', location: '/etc/station/policy.json' },
    digest: `sha256:${'a'.repeat(64)}`,
    summary: {
      organization: 'Acme',
      supportUrl: null,
      lockedSettings: [],
      limits,
    },
  });

  test('keeps the switches a server reports', () => {
    const limits = {
      telemetry: false,
      registries: { acpRegistryInstalls: false, allowedUrls: [] },
    };
    expect(parseManagedPolicyStatus(loaded(limits))?.state).toBe('loaded');
    const status = parseManagedPolicyStatus(loaded(limits));
    expect(status?.state === 'loaded' && status.summary.limits).toEqual(limits);
  });

  test('refuses a summary claiming a switch is on', () => {
    expect(parseManagedPolicyStatus(loaded({ telemetry: true }))).toBeNull();
  });
});
