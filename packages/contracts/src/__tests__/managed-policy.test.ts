import { describe, expect, test } from 'vitest';
import {
  canonicalManagedPolicyJson,
  duplicateJsonMemberPath,
  MANAGED_POLICY_INVALID_MARKER,
  MANAGED_POLICY_KEY_DISPLAY_MAX_CHARS,
  MANAGED_POLICY_REMOTE_CLIENTS_CODE,
  MANAGED_POLICY_UPDATES_REFUSED_CODE,
  managedByLabel,
  managedPolicyAllowsRemoteClients,
  managedPolicyDenial,
  managedRemoteClientsDenial,
  managedSettingsProblems,
  managedUpdateMirrorUrl,
  managedUpdatesRefusal,
  parseManagedPolicyDocument,
  parseManagedPolicyStatus,
  STATION_RELEASE_DOWNLOAD_BASE,
  summarizeManagedPolicy,
  withoutLockedProjectFields,
} from '../managed-policy.js';

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

  test('refuses every reserved limit key until enforcement lands', () => {
    for (const key of ['maxApprovalMode', 'engines']) {
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
            'telemetry settings are not manageable; a policy turns telemetry off with `limits.telemetry`',
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

describe('limits.clients (#4519)', () => {
  const policy = (clients: unknown) => ({
    schemaVersion: 1,
    organization: 'Acme',
    limits: { clients },
  });

  test('accepts the local kinds with or without remote, in canonical order', () => {
    expect(
      parseManagedPolicyDocument(policy(['local-browser', 'desktop'])),
    ).toEqual({
      ok: true,
      document: {
        schemaVersion: 1,
        organization: 'Acme',
        limits: { clients: ['desktop', 'local-browser'] },
      },
    });
    const all = parseManagedPolicyDocument(
      policy(['remote', 'desktop', 'local-browser']),
    );
    expect(all.ok && all.document.limits).toEqual({
      clients: ['desktop', 'local-browser', 'remote'],
    });
  });

  test('refuses a list this build cannot enforce, naming why', () => {
    expect(problemsOf(policy(['desktop']))).toEqual([
      {
        path: 'limits.clients',
        message:
          'must include "local-browser"; this version of Station can only leave out "remote"',
      },
    ]);
    expect(problemsOf(policy([]))[0]?.message).toContain(
      'must include "desktop" and "local-browser"',
    );
    for (const bad of [
      'desktop',
      false,
      ['desktop', 'local-browser', 'phone'],
      ['desktop', 'local-browser', 1],
    ])
      expect(problemsOf(policy(bad))).toEqual([
        {
          path: 'limits.clients',
          message: 'must be a list of "desktop", "local-browser" and "remote"',
        },
      ]);
    expect(
      problemsOf(policy(['desktop', 'local-browser', 'desktop']))[0]?.message,
    ).toBe('must not list a client kind twice');
  });

  test('the summary and status carry the list; remote is allowed only when listed or unset', () => {
    const summary = summarizeManagedPolicy({
      schemaVersion: 1,
      organization: 'Acme',
      limits: { clients: ['desktop', 'local-browser'] },
    });
    expect(summary.limits).toEqual({ clients: ['desktop', 'local-browser'] });
    expect(managedPolicyAllowsRemoteClients(summary)).toBe(false);
    expect(
      managedPolicyAllowsRemoteClients({
        limits: { clients: ['desktop', 'local-browser', 'remote'] },
      }),
    ).toBe(true);
    expect(managedPolicyAllowsRemoteClients({ limits: {} })).toBe(true);
    expect(managedPolicyAllowsRemoteClients(null)).toBe(true);

    const status = {
      state: 'loaded',
      source: { kind: 'file', location: '/etc/station/policy.json' },
      digest: `sha256:${'a'.repeat(64)}`,
      summary,
    };
    expect(parseManagedPolicyStatus(status)).toEqual(status);
    // A newer server may enforce a list this build refuses in a document.
    expect(
      parseManagedPolicyStatus({
        ...status,
        summary: { ...summary, limits: { clients: ['desktop'] } },
      }),
    ).not.toBeNull();
    expect(
      parseManagedPolicyStatus({
        ...status,
        summary: { ...summary, limits: { clients: 'remote' } },
      }),
    ).toBeNull();
  });

  test('the denial names the organization and the refusal code is stable', () => {
    expect(
      managedRemoteClientsDenial({
        organization: 'Acme',
        supportUrl: null,
        lockedSettings: [],
        limits: { clients: ['desktop', 'local-browser'] },
      }),
    ).toBe(
      "Acme's policy manages remote access: only this computer can connect to Station. Contact your administrator for help.",
    );
    expect(MANAGED_POLICY_REMOTE_CLIENTS_CODE).toBe(
      'managed-policy-remote-clients',
    );
  });
});

describe('limits.updates (#4522)', () => {
  const withUpdates = (updates: unknown) => ({
    schemaVersion: 1,
    organization: 'Acme',
    limits: { updates },
  });

  test('accepts each key and keeps exactly what was set', () => {
    expect(
      parseManagedPolicyDocument(
        withUpdates({
          mode: 'off',
          feedUrl: 'https://mirror.example/station/t0ken/',
          allowNightly: false,
        }),
      ),
    ).toEqual({
      ok: true,
      document: {
        schemaVersion: 1,
        organization: 'Acme',
        limits: {
          updates: {
            mode: 'off',
            feedUrl: 'https://mirror.example/station/t0ken/',
            allowNightly: false,
          },
        },
      },
    });
    expect(parseManagedPolicyDocument(withUpdates({}))).toEqual({
      ok: true,
      document: {
        schemaVersion: 1,
        organization: 'Acme',
        limits: { updates: {} },
      },
    });
  });

  test('refuses a bad value for each key and any unknown key', () => {
    expect(
      problemsOf(
        withUpdates({
          mode: 'manual',
          feedUrl: 'http://mirror.example/',
          allowNightly: 'no',
          channel: 'stable',
        }),
      ),
    ).toEqual([
      {
        path: 'limits.updates.channel',
        message:
          'unknown key; this version of Station refuses keys it cannot enforce',
      },
      { path: 'limits.updates.mode', message: 'must be "auto" or "off"' },
      { path: 'limits.updates.feedUrl', message: 'must be an https URL' },
      { path: 'limits.updates.allowNightly', message: 'must be true or false' },
    ]);
    expect(problemsOf(withUpdates(false))).toEqual([
      { path: 'limits.updates', message: 'must be an object' },
    ]);
  });

  test.each([
    [
      'https://user:pw@mirror.example/',
      'must not contain a user name or password',
    ],
    [
      'https://mirror.example/?token=1',
      'must not contain a query or fragment; release paths are appended to it',
    ],
    [
      'https://mirror.example/#x',
      'must not contain a query or fragment; release paths are appended to it',
    ],
    ['https://mirror.example/a/../b/', 'must be a plain URL in canonical form'],
    ['https://Mirror.example/', 'must be a plain URL in canonical form'],
    ['not a url', 'must be an https URL'],
    ['', 'must be an https URL'],
    [
      `https://mirror.example/${'a'.repeat(2048)}`,
      'must be at most 2048 characters',
    ],
  ])('refuses the feed URL %s', (feedUrl, message) => {
    expect(problemsOf(withUpdates({ feedUrl }))).toEqual([
      { path: 'limits.updates.feedUrl', message },
    ]);
  });

  test('accepts a feed URL with or without a trailing slash', () => {
    for (const feedUrl of [
      'https://mirror.example',
      'https://mirror.example/a',
    ])
      expect(parseManagedPolicyDocument(withUpdates({ feedUrl })).ok).toBe(
        true,
      );
  });

  test('the client summary says a mirror is set but never carries its URL', () => {
    const parsed = parseManagedPolicyDocument(
      withUpdates({ feedUrl: 'https://mirror.example/secret-token/' }),
    );
    if (!parsed.ok) throw new Error('expected a valid policy');
    const summary = summarizeManagedPolicy(parsed.document);
    expect(summary.limits).toEqual({
      updates: { mode: 'auto', mirror: true, allowNightly: true },
    });
    expect(JSON.stringify(summary)).not.toContain('secret-token');
    const status = {
      state: 'loaded',
      source: { kind: 'file', location: '/etc/station/policy.json' },
      digest: `sha256:${'a'.repeat(64)}`,
      summary,
    };
    expect(parseManagedPolicyStatus(status)).toEqual(status);
    expect(
      parseManagedPolicyStatus({
        ...status,
        summary: { ...summary, limits: { updates: { mode: 'sometimes' } } },
      }),
    ).toBeNull();
  });

  test('maps a default release URL into the mirror and refuses anything else', () => {
    expect(STATION_RELEASE_DOWNLOAD_BASE).toBe(
      'https://github.com/kontourai/station/releases/download/',
    );
    for (const feed of [
      'https://mirror.example/s',
      'https://mirror.example/s/',
    ])
      expect(
        managedUpdateMirrorUrl(
          'https://github.com/kontourai/station/releases/download/nightly-desktop/latest.json',
          feed,
        ),
      ).toBe('https://mirror.example/s/nightly-desktop/latest.json');
    expect(
      managedUpdateMirrorUrl(
        'https://example.com/releases/download/x/y.json',
        'https://mirror.example/',
      ),
    ).toBeNull();
    expect(
      managedUpdateMirrorUrl(
        STATION_RELEASE_DOWNLOAD_BASE,
        'https://mirror.example/',
      ),
    ).toBeNull();
  });

  test('refuses updates when off, and nightly only when nightly is not allowed', () => {
    expect(managedUpdatesRefusal(undefined, 'nightly')).toBeNull();
    expect(managedUpdatesRefusal({ mode: 'auto' }, 'stable')).toBeNull();
    expect(managedUpdatesRefusal({ mode: 'off' }, 'stable')).toBe(
      "This machine's managed policy turns off Station updates",
    );
    expect(managedUpdatesRefusal({ allowNightly: false }, 'nightly')).toBe(
      "This machine's managed policy makes the nightly channel unavailable",
    );
    expect(managedUpdatesRefusal({ allowNightly: false }, 'stable')).toBeNull();
    expect(managedUpdatesRefusal({ allowNightly: true }, 'nightly')).toBeNull();
    expect(MANAGED_POLICY_UPDATES_REFUSED_CODE).toBe(
      'managed-policy-updates-refused',
    );
  });
});
