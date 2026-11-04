import { describe, expect, test } from 'vitest';
import {
  canonicalManagedPolicyJson,
  duplicateJsonMemberPath,
  MANAGED_POLICY_INVALID_MARKER,
  MANAGED_POLICY_KEY_DISPLAY_MAX_CHARS,
  MANAGED_POLICY_UPDATES_REFUSED_CODE,
  managedByLabel,
  managedPolicyDenial,
  managedUpdateMirrorUrl,
  managedUpdatesRefusal,
  parseManagedPolicyDocument,
  parseManagedPolicyStatus,
  STATION_RELEASE_DOWNLOAD_BASE,
  summarizeManagedPolicy,
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

  test('refuses every limit key and any managed setting until enforcement lands', () => {
    for (const key of [
      'maxApprovalMode',
      'clients',
      'engines',
      'telemetry',
      'webhookAutomations',
      'registries',
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
    expect(
      problemsOf({
        schemaVersion: 1,
        organization: 'Acme',
        settings: { telemetryTier: { value: 'off', locked: true } },
      }),
    ).toEqual([
      {
        path: 'settings.telemetryTier',
        message:
          'managed settings are not supported by this version of Station',
      },
    ]);
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

// The combined-policy round trip: every key this build accepts, set at once,
// must survive the parse, the client summary and the status a client decodes.
// Only `limits.updates` has landed among the limit keys; extend this document
// as each sibling slice lands its key.
describe('a policy setting every landed key at once', () => {
  test('survives into the parsed document, the summary and the status decode', () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      organization: 'Acme',
      supportUrl: 'https://help.example',
      settings: {},
      limits: {
        updates: {
          mode: 'off',
          feedUrl: 'https://mirror.example/station/',
          allowNightly: false,
        },
      },
    });
    const result = parseManagedPolicyDocument(JSON.parse(text));
    if (!result.ok) throw new Error(JSON.stringify(result.problems));
    expect(result.document).toEqual({
      schemaVersion: 1,
      organization: 'Acme',
      supportUrl: 'https://help.example',
      settings: {},
      limits: {
        updates: {
          mode: 'off',
          feedUrl: 'https://mirror.example/station/',
          allowNightly: false,
        },
      },
    });

    const summary = summarizeManagedPolicy(result.document);
    expect(summary).toEqual({
      organization: 'Acme',
      supportUrl: 'https://help.example',
      lockedSettings: [],
      limits: { updates: { mode: 'off', mirror: true, allowNightly: false } },
    });
    expect(JSON.stringify(summary)).not.toContain('mirror.example');

    // What a client receives: the status over the wire, decoded.
    const status = JSON.parse(
      JSON.stringify({
        state: 'loaded',
        source: { kind: 'file', location: '/etc/station/policy.json' },
        digest: `sha256:${'b'.repeat(64)}`,
        summary,
      }),
    );
    expect(parseManagedPolicyStatus(status)).toEqual({
      state: 'loaded',
      source: { kind: 'file', location: '/etc/station/policy.json' },
      digest: `sha256:${'b'.repeat(64)}`,
      summary: {
        organization: 'Acme',
        supportUrl: 'https://help.example',
        lockedSettings: [],
        limits: {
          updates: { mode: 'off', mirror: true, allowNightly: false },
        },
      },
    });
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
