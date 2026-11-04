import { describe, expect, test } from 'vitest';
import {
  approvalModeExceedsCeiling,
  canonicalManagedPolicyJson,
  clampApprovalModeToCeiling,
  duplicateJsonMemberPath,
  MANAGED_POLICY_ENFORCED_LIMIT_KEYS,
  MANAGED_POLICY_INVALID_MARKER,
  MANAGED_POLICY_KEY_DISPLAY_MAX_CHARS,
  MANAGED_POLICY_RESERVED_LIMIT_KEYS,
  managedApprovalCeiling,
  managedApprovalCeilingDenial,
  managedByLabel,
  managedPolicyDenial,
  managedSettingsProblems,
  parseManagedPolicyDocument,
  parseManagedPolicyStatus,
  summarizeManagedPolicy,
  withoutLockedProjectFields,
} from '../managed-policy.js';
import {
  APPROVAL_MODE_BREADTH_ORDER,
  approvalModeBreadth,
} from '../provider.js';

function problemsOf(value: unknown) {
  const result = parseManagedPolicyDocument(value);
  if (result.ok) throw new Error('expected the document to be refused');
  return result.problems;
}

describe('parseManagedPolicyDocument', () => {
  test('accepts the minimal and the full v1 document this build enforces', () => {
    expect(
      parseManagedPolicyDocument({ schemaVersion: 1, organization: 'Acme' }),
    ).toEqual({
      ok: true,
      document: { schemaVersion: 1, organization: 'Acme' },
    });
    expect(
      parseManagedPolicyDocument({
        schemaVersion: 1,
        organization: 'Acme',
        supportUrl: 'https://help.example/station',
        settings: {},
        limits: {},
      }),
    ).toEqual({
      ok: true,
      document: {
        schemaVersion: 1,
        organization: 'Acme',
        supportUrl: 'https://help.example/station',
        settings: {},
        limits: {},
      },
    });
  });

  test('refuses an unknown key at the top level and inside limits', () => {
    expect(
      problemsOf({ schemaVersion: 1, organization: 'Acme', allowAll: true }),
    ).toEqual([
      {
        path: 'allowAll',
        message:
          'unknown key; this version of Station refuses keys it cannot enforce',
      },
    ]);
    expect(
      problemsOf({
        schemaVersion: 1,
        organization: 'Acme',
        limits: { 'not a key': 1 },
      }),
    ).toEqual([
      {
        path: 'limits["not a key"]',
        message:
          'unknown limit; this version of Station refuses keys it cannot enforce',
      },
    ]);
  });

  test('refuses a JSON __proto__ key instead of losing it', () => {
    expect(
      problemsOf(
        JSON.parse('{"schemaVersion":1,"organization":"A","__proto__":{}}'),
      ).map((problem) => problem.path),
    ).toEqual(['__proto__']);
  });

  test('refuses every limit key but maxApprovalMode until enforcement lands', () => {
    for (const key of [
      'clients',
      'engines',
      'telemetry',
      'webhookAutomations',
      'registries',
      'updates',
    ]) {
      expect(
        problemsOf({
          schemaVersion: 1,
          organization: 'Acme',
          limits: { [key]: false },
        }),
      ).toEqual([
        {
          path: `limits.${key}`,
          message: 'this limit is not supported by this version of Station',
        },
      ]);
    }
  });

  test('names the schemaVersion problem, including a newer one', () => {
    expect(problemsOf({ organization: 'Acme' })).toEqual([
      { path: 'schemaVersion', message: 'is required' },
    ]);
    expect(problemsOf({ schemaVersion: 2, organization: 'Acme' })).toEqual([
      {
        path: 'schemaVersion',
        message:
          '2 is newer than this version of Station supports (1); upgrade Station',
      },
    ]);
    expect(problemsOf({ schemaVersion: '1', organization: 'Acme' })).toEqual([
      { path: 'schemaVersion', message: 'must be 1' },
    ]);
  });

  test('requires a non-empty single-line organization', () => {
    for (const organization of [undefined, '', ' Acme', 'Ac\nme', 7]) {
      expect(
        problemsOf({ schemaVersion: 1, organization }).map((p) => p.path),
      ).toEqual(['organization']);
    }
    expect(
      problemsOf({ schemaVersion: 1, organization: 'a'.repeat(201) }),
    ).toHaveLength(1);
    expect(
      parseManagedPolicyDocument({
        schemaVersion: 1,
        organization: 'a'.repeat(200),
      }).ok,
    ).toBe(true);
  });

  test('requires an https support link without credentials', () => {
    for (const supportUrl of [
      'http://help.example',
      'not a url',
      '',
      'https://user:secret@help.example',
      `https://help.example/${'a'.repeat(2048)}`,
    ]) {
      expect(
        problemsOf({ schemaVersion: 1, organization: 'A', supportUrl }).map(
          (p) => p.path,
        ),
      ).toEqual(['supportUrl']);
    }
  });

  test('reports every problem at once, and a non-object document', () => {
    expect(problemsOf([])).toEqual([
      { path: '', message: 'the policy must be a JSON object' },
    ]);
    expect(
      problemsOf({ schemaVersion: 3, extra: 1, limits: 'x' }).map(
        (p) => p.path,
      ),
    ).toEqual(['extra', 'schemaVersion', 'organization', 'limits']);
  });
});

describe('summary, fingerprint input and status', () => {
  test('the canonical form sorts keys and drops whitespace', () => {
    expect(
      canonicalManagedPolicyJson({
        supportUrl: 'https://h.example',
        schemaVersion: 1,
        organization: 'Acme',
      }),
    ).toBe(
      '{"organization":"Acme","schemaVersion":1,"supportUrl":"https://h.example"}',
    );
  });

  test('the summary carries locked paths only, never values', () => {
    const summary = summarizeManagedPolicy({
      schemaVersion: 1,
      organization: 'Acme',
      settings: {
        b: { value: 'secret-ish', locked: true },
        a: { value: 1, locked: true },
        c: { value: 2, locked: false },
      },
    });
    expect(summary).toEqual({
      organization: 'Acme',
      supportUrl: null,
      lockedSettings: ['a', 'b'],
      limits: {},
    });
    expect(JSON.stringify(summary)).not.toContain('secret-ish');
  });

  test('status parsing accepts what a server sends and refuses anything else', () => {
    const loaded = {
      state: 'loaded',
      source: { kind: 'file', location: '/etc/station/policy.json' },
      digest: `sha256:${'a'.repeat(64)}`,
      summary: {
        organization: 'Acme',
        supportUrl: null,
        lockedSettings: [],
        limits: {},
      },
    };
    expect(parseManagedPolicyStatus(loaded)).toEqual(loaded);
    expect(parseManagedPolicyStatus({ state: 'none' })).toEqual({
      state: 'none',
    });
    expect(
      parseManagedPolicyStatus({ ...loaded, digest: 'sha256:abc' }),
    ).toBeNull();
    expect(parseManagedPolicyStatus({ state: 'error' })).toBeNull();
  });

  test('denial and label text name the organization and help', () => {
    const summary = {
      organization: 'Acme',
      supportUrl: 'https://help.example',
      lockedSettings: [],
      limits: {},
    };
    expect(managedByLabel(summary)).toBe('Managed by Acme');
    expect(managedPolicyDenial(summary, 'this setting')).toBe(
      "Acme's policy manages this setting. For help, visit https://help.example",
    );
    expect(
      managedPolicyDenial({ ...summary, supportUrl: null }, 'this setting'),
    ).toBe(
      "Acme's policy manages this setting. Contact your administrator for help.",
    );
    expect(MANAGED_POLICY_INVALID_MARKER).toBe(
      'STATION_MANAGED_POLICY_INVALID',
    );
  });
});

describe('duplicateJsonMemberPath', () => {
  test.each([
    ['{"a":1,"b":2}', null],
    ['{"limits":{"telemetry":false},"limits":{}}', 'limits'],
    ['{"limits":1,"\\u006cimits":2}', 'limits'],
    ['{"a":{"b":[{"c":1},{"c":1,"c":2}]}}', 'a.b[1].c'],
    ['{"a":{"x":1},"b":{"x":1}}', null],
    ['{"a\\"":1,"a\\"":2}', '["a\\""]'],
    ['{"x":"}","y":"\\\\","z":"\\"{"}', null],
    ['[{"k":1},{"k":2}]', null],
    [
      ' {\n\t"n": -1.5e+3, "t": true, "f": false, "z": null, "e": [], "o": {} } ',
      null,
    ],
    ['{"__proto__":1,"__proto__":2}', '__proto__'],
    ['{"":1,"":2}', '[""]'],
    ['"text"', null],
  ])('%s -> %s', (text, expected) => {
    // Every case is valid JSON, as the scanner expects.
    JSON.parse(text);
    expect(duplicateJsonMemberPath(text)).toBe(expected);
  });

  test('handles nesting deeper than a recursive parser could', () => {
    const depth = 200_000;
    expect(
      duplicateJsonMemberPath(`${'['.repeat(depth)}${']'.repeat(depth)}`),
    ).toBeNull();
    const nested = `${'{"a":'.repeat(5000)}{"b":1,"b":2}${'}'.repeat(5000)}`;
    expect(duplicateJsonMemberPath(nested)).toBe(`${'a.'.repeat(5000)}b`);
  });

  test.each(['{', '{"a":1,}', '[1 2]', '{"a" 1}', 'tru', '{} {}'])(
    'throws on input JSON.parse refuses: %s',
    (text) => {
      expect(() => duplicateJsonMemberPath(text)).toThrow(SyntaxError);
    },
  );

  test('a huge duplicate name is shown truncated', () => {
    const name = 'k'.repeat(100_000);
    const path = duplicateJsonMemberPath(`{"${name}":1,"${name}":2}`);
    expect(path).toBe(`["${'k'.repeat(64)}"… (100000 characters)]`);
    expect(MANAGED_POLICY_KEY_DISPLAY_MAX_CHARS).toBe(64);
  });
});

describe('problem paths for huge keys', () => {
  test('quote at most the display bound of a key name', () => {
    const key = 'k'.repeat(100_000);
    const problems = problemsOf({
      schemaVersion: 1,
      organization: 'A',
      [key]: 1,
    });
    expect(problems).toEqual([
      {
        path: `["${'k'.repeat(64)}"… (100000 characters)]`,
        message:
          'unknown key; this version of Station refuses keys it cannot enforce',
      },
    ]);
  });
});

describe('#4518: limits.maxApprovalMode', () => {
  const policy = (limits: unknown, extra: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    organization: 'Acme',
    limits,
    ...extra,
  });

  test('the order is ask < auto < never (full access)', () => {
    // Pinned literal, independent of the constant under test.
    expect(APPROVAL_MODE_BREADTH_ORDER).toEqual(['ask', 'auto', 'never']);
    expect(approvalModeBreadth('ask')).toBeLessThan(
      approvalModeBreadth('auto'),
    );
    expect(approvalModeBreadth('auto')).toBeLessThan(
      approvalModeBreadth('never'),
    );
  });

  test('is the one enforced limit; the others stay reserved', () => {
    expect(MANAGED_POLICY_ENFORCED_LIMIT_KEYS).toEqual(['maxApprovalMode']);
    expect(MANAGED_POLICY_RESERVED_LIMIT_KEYS).not.toContain('maxApprovalMode');
  });

  for (const mode of ['ask', 'auto', 'never'] as const)
    test(`accepts ${mode} and exposes it in the summary and the status`, () => {
      const parsed = parseManagedPolicyDocument(
        policy({ maxApprovalMode: mode }),
      );
      expect(parsed).toEqual({
        ok: true,
        document: {
          schemaVersion: 1,
          organization: 'Acme',
          limits: { maxApprovalMode: mode },
        },
      });
      if (!parsed.ok) return;
      const summary = summarizeManagedPolicy(parsed.document);
      expect(summary.limits).toEqual({ maxApprovalMode: mode });
      expect(
        parseManagedPolicyStatus({
          state: 'loaded',
          source: { kind: 'file', location: '/etc/station/policy.json' },
          digest: `sha256:${'a'.repeat(64)}`,
          summary,
        }),
      ).toMatchObject({ summary: { limits: { maxApprovalMode: mode } } });
    });

  test('refuses connection-default and any non-posture value', () => {
    expect(
      problemsOf(policy({ maxApprovalMode: 'connection-default' })),
    ).toEqual([
      {
        path: 'limits.maxApprovalMode',
        message:
          'must be a posture ("ask", "auto" or "never"); "connection-default" depends on each engine\'s own settings',
      },
    ]);
    for (const value of ['full-access', 'ASK', 1, null, true, {}])
      expect(problemsOf(policy({ maxApprovalMode: value }))).toEqual([
        {
          path: 'limits.maxApprovalMode',
          message: 'must be "ask", "auto" or "never"',
        },
      ]);
  });

  test('another limit key beside it is still refused', () => {
    expect(
      problemsOf(policy({ maxApprovalMode: 'ask', telemetry: false })),
    ).toEqual([
      {
        path: 'limits.telemetry',
        message: 'this limit is not supported by this version of Station',
      },
    ]);
  });

  test('a status whose summary carries an invalid ceiling is unreadable', () => {
    expect(
      parseManagedPolicyStatus({
        state: 'loaded',
        source: { kind: 'file', location: '/etc/station/policy.json' },
        digest: `sha256:${'a'.repeat(64)}`,
        summary: {
          organization: 'Acme',
          supportUrl: null,
          lockedSettings: [],
          limits: { maxApprovalMode: 'connection-default' },
        },
      }),
    ).toBeNull();
  });

  test('a managed default approval mode above the ceiling is refused at load', () => {
    const problems = problemsOf(
      policy(
        { maxApprovalMode: 'auto' },
        {
          settings: { defaultApprovalMode: { value: 'never', locked: false } },
        },
      ),
    );
    // Settings parse (#4517), so the cross-check is the only problem.
    expect(problems).toEqual([
      {
        path: 'settings.defaultApprovalMode.value',
        message: '"never" is broader than limits.maxApprovalMode ("auto")',
      },
    ]);
    // At or below the ceiling, and connection-default, the policy loads.
    for (const value of ['auto', 'ask', 'connection-default'])
      expect(
        parseManagedPolicyDocument(
          policy(
            { maxApprovalMode: 'auto' },
            { settings: { defaultApprovalMode: { value, locked: true } } },
          ),
        ),
      ).toMatchObject({ ok: true });
  });

  test('helpers: the ceiling, the comparison and the clamp', () => {
    const limits = (maxApprovalMode?: 'ask' | 'auto' | 'never') => ({
      limits: maxApprovalMode ? { maxApprovalMode } : {},
    });
    expect(managedApprovalCeiling(null)).toBeUndefined();
    expect(managedApprovalCeiling(limits())).toBeUndefined();
    // Full access is the broadest posture: a ceiling there restricts nothing.
    expect(managedApprovalCeiling(limits('never'))).toBeUndefined();
    expect(managedApprovalCeiling(limits('auto'))).toBe('auto');

    expect(approvalModeExceedsCeiling('never', 'auto')).toBe(true);
    expect(approvalModeExceedsCeiling('auto', 'auto')).toBe(false);
    expect(approvalModeExceedsCeiling('auto', 'ask')).toBe(true);
    expect(approvalModeExceedsCeiling('never', undefined)).toBe(false);

    expect(clampApprovalModeToCeiling('never', 'auto')).toBe('auto');
    expect(clampApprovalModeToCeiling('ask', 'auto')).toBe('ask');
    expect(clampApprovalModeToCeiling('connection-default', 'ask')).toBe(
      'connection-default',
    );
    expect(clampApprovalModeToCeiling('never', undefined)).toBe('never');
  });

  test('the denial names the organization, the ceiling and where to get help', () => {
    const summary = {
      organization: 'Acme',
      supportUrl: 'https://help.acme.example',
      lockedSettings: [],
      limits: { maxApprovalMode: 'ask' as const },
    };
    expect(managedApprovalCeilingDenial(summary, 'ask')).toBe(
      "Acme's policy manages approval modes: the broadest allowed is Ask first. For help, visit https://help.acme.example",
    );
    expect(
      managedApprovalCeilingDenial({ ...summary, supportUrl: null }, 'auto'),
    ).toBe(
      "Acme's policy manages approval modes: the broadest allowed is Auto. Contact your administrator for help.",
    );
  });
});

describe('managed settings (#4517)', () => {
  const policy = (settings: unknown) => ({
    schemaVersion: 1,
    organization: 'Acme',
    settings,
  });

  test('accepts locks and defaults on registered settings, copying each entry', () => {
    const value = { enabled: true, mode: 'review' };
    const result = parseManagedPolicyDocument(
      policy({
        defaultMaxTurns: { value: 40, locked: true },
        workspaceCheckpoints: { value: true, locked: false },
        approvalGuardian: { value, locked: true },
        builtinAgentEngineConnectionId: { value: null, locked: true },
      }),
    );
    if (!result.ok) throw new Error(JSON.stringify(result.problems));
    expect(result.document.settings).toEqual({
      defaultMaxTurns: { value: 40, locked: true },
      workspaceCheckpoints: { value: true, locked: false },
      approvalGuardian: {
        value: { enabled: true, mode: 'review' },
        locked: true,
      },
      builtinAgentEngineConnectionId: { value: null, locked: true },
    });
    // The document owns its values: mutating the input does not reach it.
    value.enabled = false;
    expect(result.document.settings?.approvalGuardian.value).toEqual({
      enabled: true,
      mode: 'review',
    });
    expect(summarizeManagedPolicy(result.document).lockedSettings).toEqual([
      'approvalGuardian',
      'builtinAgentEngineConnectionId',
      'defaultMaxTurns',
    ]);
  });

  test.each([
    [
      'an unknown path',
      { noSuchSetting: { value: 1, locked: true } },
      'settings.noSuchSetting',
      'unknown setting; this version of Station refuses keys it cannot enforce',
    ],
    [
      'a field inside a setting managed as a whole',
      { 'approvalGuardian.enabled': { value: true, locked: true } },
      'settings["approvalGuardian.enabled"]',
      '"approvalGuardian" is managed as a whole; manage "approvalGuardian" instead of one field inside it',
    ],
    [
      'a field inside a scalar setting',
      { 'defaultMaxTurns.max': { value: 1, locked: true } },
      'settings["defaultMaxTurns.max"]',
      '"defaultMaxTurns" has no fields; manage "defaultMaxTurns" itself',
    ],
    [
      'a device setting',
      { theme: { value: 'dark', locked: true } },
      'settings.theme',
      'this is a device setting, stored on each client; the server cannot enforce it',
    ],
    [
      'an environment variable',
      { AWS_REGION: { value: 'us-east-1', locked: true } },
      'settings.AWS_REGION',
      'this is an environment variable, not a setting; manage "region" instead',
    ],
    [
      'an internal field',
      { runtime: { value: 'voltagent', locked: true } },
      'settings.runtime',
      'this is an internal field, not a setting a policy can manage',
    ],
    [
      'a runtime-derived field',
      { mcpUiFrameOrigin: { value: 'http://x', locked: true } },
      'settings.mcpUiFrameOrigin',
      'this value is derived at runtime and is not a stored setting',
    ],
    [
      'a wrong type',
      { defaultMaxTurns: { value: 'many', locked: true } },
      'settings.defaultMaxTurns.value',
      'defaultMaxTurns: expected a number',
    ],
    [
      'an enum value the registry does not list',
      { defaultWorkspaceIsolation: { value: 'vm', locked: false } },
      'settings.defaultWorkspaceIsolation.value',
      'defaultWorkspaceIsolation: expected one of shared|worktree',
    ],
    [
      'null on a setting that cannot store null',
      { defaultMaxTurns: { value: null, locked: true } },
      'settings.defaultMaxTurns.value',
      'value must not be null',
    ],
    [
      'a blank string, which Station reads as unset',
      { systemPrompt: { value: '   ', locked: true } },
      'settings.systemPrompt.value',
      'value must not be blank',
    ],
    [
      'a missing value',
      { defaultMaxTurns: { locked: true } },
      'settings.defaultMaxTurns.value',
      'is required',
    ],
    [
      'a missing or non-boolean locked',
      { defaultMaxTurns: { value: 4, locked: 'yes' } },
      'settings.defaultMaxTurns.locked',
      'must be true (a fixed value) or false (a default users can change)',
    ],
    [
      'an unknown entry key',
      { defaultMaxTurns: { value: 4, locked: true, force: true } },
      'settings.defaultMaxTurns.force',
      'unknown key; this version of Station refuses keys it cannot enforce',
    ],
    [
      'an entry that is not an object',
      { defaultMaxTurns: 4 },
      'settings.defaultMaxTurns',
      'must be an object with "value" and "locked"',
    ],
  ])('refuses %s', (_name, settings, path, message) => {
    expect(problemsOf(policy(settings))).toEqual([{ path, message }]);
  });

  test('refuses a secret setting: every user on the machine can read the policy', () => {
    // No registered setting is secret today; the rule is reached through a
    // registry that declares one, with the production registry's shape.
    const secret = {
      key: 'productTelemetryKeyRef',
      scope: 'station',
      descriptor: { kind: 'string' },
      label: 'Key',
      help: 'A key.',
      description: 'A key.',
      secret: true,
    } as const;
    expect(
      managedSettingsProblems(
        { productTelemetryKeyRef: { value: 'k', locked: true } },
        [secret],
      ),
    ).toEqual([
      {
        path: 'settings.productTelemetryKeyRef',
        message:
          'secret settings cannot be managed; every user on the machine can read the policy',
      },
    ]);
  });

  test('refuses a settings value that is not an object', () => {
    expect(problemsOf(policy([]))).toEqual([
      { path: 'settings', message: 'must be an object' },
    ]);
  });
});

describe('settings this version cannot manage (#4517)', () => {
  // Each has a reader the overlay cannot reach (the OpenTelemetry bootstrap
  // reads `config/app.json` before the policy loads; the tier resolves
  // against environment variables outside the registry), so the policy is
  // refused rather than reporting a managed value that is not in effect.
  test.each([
    'telemetryTier',
    'productTelemetryEndpoint',
    'productTelemetryKeyRef',
    'otelTelemetryEndpoint',
    'otelTelemetryKeyRef',
  ])('refuses %s, locked or default, and says why', (key) => {
    for (const locked of [true, false]) {
      const problems = problemsOf({
        schemaVersion: 1,
        organization: 'Acme',
        settings: { [key]: { value: 'x', locked } },
      });
      expect(problems).toEqual([
        {
          path: `settings.${key}`,
          message:
            'telemetry settings are not manageable in this version of Station; telemetry limits arrive with #4521',
        },
      ]);
    }
  });
});

describe('withoutLockedProjectFields (#4517)', () => {
  const project = {
    slug: 'p',
    defaultProviderId: 'provider',
    defaultModel: 'model',
    defaultModelSelection: 'last-used',
    defaultApprovalMode: 'auto',
    defaultApprovalModeSelection: 'last-used',
    defaultWorkspaceIsolation: 'worktree',
  };

  test.each([
    [
      'defaultModel',
      ['defaultProviderId', 'defaultModel', 'defaultModelSelection'],
    ],
    [
      'defaultLLMProvider',
      ['defaultProviderId', 'defaultModel', 'defaultModelSelection'],
    ],
    [
      'defaultApprovalMode',
      ['defaultApprovalMode', 'defaultApprovalModeSelection'],
    ],
    ['defaultWorkspaceIsolation', ['defaultWorkspaceIsolation']],
  ])('a %s lock hides exactly %j', (key, hidden) => {
    const masked = withoutLockedProjectFields(project, [key]);
    expect(
      Object.keys(project)
        .filter((field) => !(field in masked))
        .sort(),
    ).toEqual([...hidden].sort());
    expect(project.defaultModel).toBe('model');
  });

  test('nothing locked returns the record itself', () => {
    expect(withoutLockedProjectFields(project, ['defaultMaxTurns'])).toBe(
      project,
    );
  });
});

// #4517 round 2: the administrator guide's "What a lock does not cover"
// table is the published form of MANAGED_SETTING_NARROWER_SCOPES; a row the
// constant drops, adds or rewords fails here.
describe('MANAGED_SETTING_NARROWER_SCOPES', () => {
  test('matches the managed policy guide table row for row', async () => {
    const { readFileSync } = await import('node:fs');
    const { MANAGED_SETTING_NARROWER_SCOPES } = await import(
      '../managed-policy.js'
    );
    const guide = readFileSync(
      new URL('../../../../docs/guides/managed-policy.md', import.meta.url),
      'utf8',
    );
    const section = (
      guide.split('### What a lock does not cover')[1] ?? ''
    ).split(/^#{2,3} /m)[0];
    const rows = [...section.matchAll(/^\| `([^`]+)` \| (.+) \|$/gm)].map(
      ([, key, text]) => [key, text.replace(/\\\|/g, '|')],
    );
    expect(Object.fromEntries(rows)).toEqual(MANAGED_SETTING_NARROWER_SCOPES);
    // Pinned independently: the two scopes the product decision names.
    expect(Object.keys(MANAGED_SETTING_NARROWER_SCOPES)).toEqual(
      expect.arrayContaining(['defaultApprovalMode', 'region']),
    );
  });
});

// #4517 and #4518 together: managed settings and the approval ceiling in one
// policy. Each slice's output must survive the other's into the parsed
// document, the client summary and the status a client decodes.
describe('managed settings with the approval ceiling', () => {
  const combined = (defaultApprovalMode: string) => ({
    schemaVersion: 1,
    organization: 'Acme',
    settings: {
      defaultMaxTurns: { value: 40, locked: true },
      checkoutStaleAfterDays: { value: 9, locked: false },
      defaultApprovalMode: { value: defaultApprovalMode, locked: true },
    },
    limits: { maxApprovalMode: 'auto' },
  });

  test('every setting and the ceiling survive parsing, the summary and the status', () => {
    const parsed = parseManagedPolicyDocument(combined('ask'));
    expect(parsed).toEqual({
      ok: true,
      document: {
        schemaVersion: 1,
        organization: 'Acme',
        settings: {
          defaultMaxTurns: { value: 40, locked: true },
          checkoutStaleAfterDays: { value: 9, locked: false },
          defaultApprovalMode: { value: 'ask', locked: true },
        },
        limits: { maxApprovalMode: 'auto' },
      },
    });
    if (!parsed.ok) return;

    const summary = summarizeManagedPolicy(parsed.document);
    expect(summary).toEqual({
      organization: 'Acme',
      supportUrl: null,
      // Locked paths only; the unlocked default is not listed.
      lockedSettings: ['defaultApprovalMode', 'defaultMaxTurns'],
      limits: { maxApprovalMode: 'auto' },
    });

    // Through the wire, as a client reads `GET /api/settings/managed-policy`.
    const status = {
      state: 'loaded',
      source: { kind: 'file', location: '/etc/station/policy.json' },
      digest: `sha256:${'a'.repeat(64)}`,
      summary,
    };
    expect(
      parseManagedPolicyStatus(JSON.parse(JSON.stringify(status))),
    ).toEqual(status);
  });

  test('a locked default approval mode above the ceiling is refused at load', () => {
    expect(problemsOf(combined('never'))).toEqual([
      {
        path: 'settings.defaultApprovalMode.value',
        message: '"never" is broader than limits.maxApprovalMode ("auto")',
      },
    ]);
  });
});
