import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';
import {
  loadManagedPolicyFromSources,
  ManagedPolicyInvalidError,
  macosProfileSource,
  managedPolicyFileSource,
  systemManagedPolicySources,
} from '../managed-policy.js';
import {
  BINARY_PLIST_VISIT_ALLOWANCE,
  BINARY_PLIST_VISITS_PER_OBJECT,
  binaryPlistKeyScanProblem,
  duplicatePlistKeyPath,
  MACOS_MANAGED_PREFERENCES_PATH,
  managedPreferencesDocument,
  type PlistConverter,
  plistKeyScanProblem,
  plutilConverter,
} from '../managed-policy-macos.js';
import { managedPolicyMobileconfig } from '../managed-policy-templates.js';

const makeTempDir = trackTempDirs();
const FIXTURES = join(import.meta.dirname, 'fixtures', 'managed-policy');
const PLUTIL = '/usr/bin/plutil';
const hasPlutil = process.platform === 'darwin' && existsSync(PLUTIL);

/** A converter for hosts without plutil: the fixture's JSON twin. */
const jsonConverter =
  (value: unknown): PlistConverter =>
  () => ({ ok: true, json: JSON.stringify(value) });

describe('managedPreferencesDocument', () => {
  const policy = { schemaVersion: 1, organization: 'Acme' };

  test('drops only the profile metadata macOS writes beside the keys', () => {
    expect(
      managedPreferencesDocument({
        ...policy,
        PayloadUUID: 'X',
        PayloadIdentifier: 'io.kontourai.station.policy.payload',
        _manualProfile: true,
      }),
    ).toEqual(policy);
    // Anything else stays, so the parser refuses it.
    expect(managedPreferencesDocument({ ...policy, PayloadExtra: 1 })).toEqual({
      ...policy,
      PayloadExtra: 1,
    });
  });

  test('unwraps exactly one Forced mcx_preference_settings entry', () => {
    expect(
      managedPreferencesDocument({
        Forced: [{ mcx_preference_settings: policy }],
      }),
    ).toEqual(policy);
    for (const wrapped of [
      { Forced: [{ mcx_preference_settings: policy }], organization: 'X' },
      { Forced: [{ mcx_preference_settings: policy }, {}] },
      { Forced: [{ mcx_preference_settings: policy, mcx_data_timestamp: 1 }] },
      { Set_Once: [{ mcx_preference_settings: policy }] },
    ])
      expect(managedPreferencesDocument(wrapped)).toEqual(wrapped);
  });
});

function profilePath(fixture: string): string {
  const path = join(
    makeTempDir('station-policy-profile-'),
    'io.kontourai.station.plist',
  );
  writeFileSync(path, readFileSync(join(FIXTURES, fixture)));
  return path;
}

describe('the macOS profile source', () => {
  test('is a system source on macOS only, at the device-level path', () => {
    expect(
      systemManagedPolicySources('darwin').map((source) => source.descriptor),
    ).toEqual([
      {
        kind: 'file',
        location: '/Library/Application Support/Station/policy.json',
      },
      { kind: 'macos-profile', location: MACOS_MANAGED_PREFERENCES_PATH },
    ]);
    expect(MACOS_MANAGED_PREFERENCES_PATH).toBe(
      '/Library/Managed Preferences/io.kontourai.station.plist',
    );
    expect(
      systemManagedPolicySources('linux').map(
        (source) => source.descriptor.kind,
      ),
    ).toEqual(['file']);
  });

  test.skipIf(!hasPlutil)(
    'decodes a custom-payload plist, binary or XML, through /usr/bin/plutil',
    () => {
      const xml = profilePath('managed-preferences-custom-payload.plist');
      const binary = profilePath('managed-preferences-custom-payload.plist');
      // macOS stores installed managed preferences as binary property lists.
      execFileSync(PLUTIL, ['-convert', 'binary1', binary]);
      expect(readFileSync(binary).subarray(0, 8).toString()).toBe('bplist00');
      for (const path of [xml, binary]) {
        const loaded = loadManagedPolicyFromSources([
          macosProfileSource(path, null),
        ]);
        expect(loaded?.source).toEqual({
          kind: 'macos-profile',
          location: path,
        });
        expect(loaded?.document).toEqual({
          schemaVersion: 1,
          organization: 'Acme Corp',
          supportUrl: 'https://help.acme.example/station',
          limits: {
            telemetry: false,
            webhookAutomations: false,
            registries: {
              allowedUrls: ['https://plugins.acme.example/catalog'],
              unsignedPackages: false,
            },
          },
        });
      }
    },
  );

  test.skipIf(!hasPlutil)('decodes the MCX Forced shape', () => {
    const loaded = loadManagedPolicyFromSources([
      macosProfileSource(
        profilePath('managed-preferences-mcx-forced.plist'),
        null,
      ),
    ]);
    expect(loaded?.document).toEqual({
      schemaVersion: 1,
      organization: 'Acme Corp',
      limits: { telemetry: false },
    });
  });

  test.skipIf(!hasPlutil)(
    'a plist value with no JSON form (a date) is refused',
    () => {
      const path = join(makeTempDir('station-policy-profile-'), 'p.plist');
      writeFileSync(
        path,
        '<?xml version="1.0"?><plist version="1.0"><dict><key>organization</key><date>2026-01-01T00:00:00Z</date></dict></plist>',
      );
      expect(() =>
        loadManagedPolicyFromSources([macosProfileSource(path, null)]),
      ).toThrow(
        /STATION_MANAGED_POLICY_INVALID.*not a property list Station can read/,
      );
    },
  );

  test('an unknown key in the profile is refused by the same parser', () => {
    const path = profilePath('managed-preferences-mcx-forced.plist');
    expect(() =>
      loadManagedPolicyFromSources([
        macosProfileSource(
          path,
          null,
          jsonConverter({
            schemaVersion: 1,
            organization: 'Acme',
            allowAll: true,
          }),
        ),
      ]),
    ).toThrow('allowAll: unknown key');
  });

  test('a converter that cannot run fails closed', () => {
    const path = profilePath('managed-preferences-mcx-forced.plist');
    expect(() =>
      loadManagedPolicyFromSources([
        macosProfileSource(path, null, plutilConverter('/nonexistent/plutil')),
      ]),
    ).toThrow(
      /STATION_MANAGED_POLICY_INVALID.*\/nonexistent\/plutil could not run \(ENOENT\)/,
    );
  });

  test('the profile gets the policy file checks: a writable folder is refused', () => {
    const path = profilePath('managed-preferences-mcx-forced.plist');
    const dir = join(path, '..');
    chmodSync(dir, 0o777);
    expect(() =>
      loadManagedPolicyFromSources([
        macosProfileSource(
          path,
          { ownerUid: process.getuid?.() ?? 0, trustedRoot: dir },
          jsonConverter({ schemaVersion: 1, organization: 'Acme' }),
        ),
      ]),
    ).toThrow('must not be writable by its group or other users');
  });

  test('a profile and a policy file both present is a startup error', () => {
    const profile = profilePath('managed-preferences-mcx-forced.plist');
    const file = join(makeTempDir('station-policy-file-'), 'policy.json');
    writeFileSync(
      file,
      JSON.stringify({ schemaVersion: 1, organization: 'Acme' }),
    );
    expect(() =>
      loadManagedPolicyFromSources([
        managedPolicyFileSource(file),
        macosProfileSource(
          profile,
          null,
          jsonConverter({ schemaVersion: 1, organization: 'Acme' }),
        ),
      ]),
    ).toThrow(
      `${file} and ${profile}: more than one policy source is installed`,
    );
  });
});

describe('a generated .mobileconfig round-trips through the reader', () => {
  const document = {
    schemaVersion: 1 as const,
    organization: 'Acme & Sons <IT>',
    supportUrl: 'https://help.acme.example/station?team=it&x=1',
    settings: {},
    limits: {
      telemetry: false as const,
      webhookAutomations: false as const,
      registries: {
        allowedUrls: ['https://plugins.acme.example/catalog'],
        unsignedPackages: false as const,
        defaultSkillRegistries: false as const,
        acpRegistryInstalls: false as const,
      },
    },
  };

  test('refuses a document holding null, which a plist cannot carry', () => {
    const result = managedPolicyMobileconfig({
      ...document,
      settings: { theme: { value: null, locked: true } },
    });
    expect(result).toEqual({
      ok: false,
      reason:
        'settings.theme.value is null, which a configuration profile cannot hold; deploy this policy as a file instead',
    });
  });

  test.skipIf(!hasPlutil)(
    'profile → installed payload → reader → the same document',
    () => {
      const result = managedPolicyMobileconfig(document);
      if (!result.ok) throw new Error(result.reason);
      const dir = makeTempDir('station-policy-roundtrip-');
      const profile = join(dir, 'station.mobileconfig');
      writeFileSync(profile, result.profile);
      const parsed = JSON.parse(
        execFileSync(PLUTIL, ['-convert', 'json', '-o', '-', profile], {
          encoding: 'utf8',
        }),
      ) as {
        PayloadContent: Array<Record<string, unknown>>;
        PayloadScope: string;
      };
      expect(parsed.PayloadScope).toBe('System');
      expect(parsed.PayloadContent).toHaveLength(1);
      // What macOS installs for a custom payload: its keys, as a binary plist.
      const installed = join(dir, 'io.kontourai.station.plist');
      writeFileSync(installed, JSON.stringify(parsed.PayloadContent[0]));
      execFileSync(PLUTIL, ['-convert', 'binary1', installed]);
      const loaded = loadManagedPolicyFromSources([
        macosProfileSource(installed, null),
      ]);
      expect(loaded?.document).toEqual(document);
    },
  );

  test('regenerating one document yields one profile', () => {
    expect(managedPolicyMobileconfig(document)).toEqual(
      managedPolicyMobileconfig(document),
    );
  });
});

describe('duplicatePlistKeyPath', () => {
  const plist = (body: string) =>
    `<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "x"><plist version="1.0">${body}</plist>`;

  test.each([
    ['<dict><key>limits</key><dict/><key>limits</key><dict/></dict>', 'limits'],
    [
      '<dict><key>limits</key><dict><key>telemetry</key><false/><key>telemetry</key><true/></dict></dict>',
      'limits.telemetry',
    ],
    // Equal after decoding: an entity, CDATA, or a comment inside the key.
    [
      '<dict><key>a&amp;b</key><true/><key><![CDATA[a&b]]></key><true/></dict>',
      'a&b',
    ],
    [
      '<dict><key>limits</key><true/><key>lim<!-- x -->its</key><true/></dict>',
      'limits',
    ],
    [
      '<dict><key>l</key><array><dict><key>x</key><true/><key>x</key><true/></dict></array></dict>',
      'l.x',
    ],
  ])('finds %s', (body, path) => {
    expect(duplicatePlistKeyPath(plist(body))).toBe(path);
  });

  test.each([
    '<dict><key>a</key><dict><key>a</key><true/></dict><key>b</key><true/></dict>',
    '<dict><key>l</key><array><dict><key>x</key><true/></dict><dict><key>x</key><true/></dict></array></dict>',
    '<dict><key>s</key><string><![CDATA[<key>s</key>]]></string><!-- <key>s</key> --></dict>',
  ])('passes distinct keys %s', (body) => {
    expect(duplicatePlistKeyPath(plist(body))).toBeNull();
  });

  // #4515 fix round 1: a key tag in any form plutil reads as a key must be
  // seen by the scan, and markup the scan cannot tokenize refuses the
  // profile rather than being skipped.
  test.each([
    [
      '<dict><key >limits</key><true/><key>limits</key><true/></dict>',
      'limits',
    ],
    [
      '<dict><key>limits</key><true/><key\n\t>limits</key ><true/></dict>',
      'limits',
    ],
  ])(
    'finds a repeat whatever the whitespace in the key tag: %s',
    (body, path) => {
      expect(duplicatePlistKeyPath(plist(body))).toBe(path);
    },
  );

  test.each([
    ['an attribute on a key', '<dict><key id="x">limits</key><true/></dict>'],
    ['an unknown element', '<dict><keys>limits</keys><true/></dict>'],
    ['a namespaced key', '<dict><p:key>limits</p:key><true/></dict>'],
    ['a stray <', '<dict><key>a</key><true/>< key>limits</key><true/></dict>'],
    ['a tag inside a key', '<dict><key>li<string/>mits</key><true/></dict>'],
    ['an unclosed key', '<dict><key>limits'],
  ])('refuses %s instead of skipping it', (_name, body) => {
    expect(plistKeyScanProblem(plist(body))).not.toBeNull();
    expect(duplicatePlistKeyPath(plist(body))).toBeNull();
  });

  test('refuses a DOCTYPE internal subset, which could define entities', () => {
    expect(
      plistKeyScanProblem(
        '<?xml version="1.0"?><!DOCTYPE plist [<!ENTITY l "limits">]><plist version="1.0"><dict/></plist>',
      ),
    ).not.toBeNull();
  });

  test.skipIf(!hasPlutil)(
    'plutil reads <key > as a key and keeps the last one, which is why the scan must see it',
    () => {
      const path = join(makeTempDir('station-policy-plutil-key-'), 'p.plist');
      writeFileSync(
        path,
        plist(
          '<dict><key >limits</key><dict><key>telemetry</key><false/></dict><key>limits</key><dict/></dict>',
        ),
      );
      const json = JSON.parse(
        execFileSync(PLUTIL, ['-convert', 'json', '-o', '-', path], {
          encoding: 'utf8',
        }),
      );
      expect(json).toEqual({ limits: {} });
    },
  );

  test("the reviewer's profile (<key > limits with telemetry off, then a second limits) is refused as invalid", () => {
    const path = join(makeTempDir('station-policy-profile-'), 'p.plist');
    writeFileSync(
      path,
      plist(
        '<dict><key>schemaVersion</key><integer>1</integer><key>organization</key><string>Acme</string><key >limits</key><dict><key>telemetry</key><false/></dict><key>limits</key><dict/></dict>',
      ),
    );
    const load = () =>
      loadManagedPolicyFromSources([
        macosProfileSource(
          path,
          null,
          // The conversion plutil would give: the second `limits` wins.
          hasPlutil
            ? plutilConverter()
            : jsonConverter({
                schemaVersion: 1,
                organization: 'Acme',
                limits: {},
              }),
        ),
      ]);
    expect(load).toThrow(ManagedPolicyInvalidError);
    expect(load).toThrow('duplicate key limits');
  });

  test('a profile that repeats a key is refused before conversion', () => {
    const path = join(makeTempDir('station-policy-profile-'), 'p.plist');
    writeFileSync(
      path,
      plist(
        '<dict><key>schemaVersion</key><integer>1</integer><key>organization</key><string>Acme</string><key>limits</key><dict><key>telemetry</key><false/></dict><key>limits</key><dict/></dict>',
      ),
    );
    expect(() =>
      loadManagedPolicyFromSources([
        macosProfileSource(
          path,
          null,
          jsonConverter({ schemaVersion: 1, organization: 'Acme' }),
        ),
      ]),
    ).toThrow('duplicate key limits');
  });
});

/**
 * A `bplist00` writer for the shapes these tests need: dicts, arrays, ASCII
 * strings and booleans. Objects are written in order; `ref` is an index.
 */
type BplistObject =
  | { dict: Array<[number, number]> }
  | { array: number[] }
  | { string: string }
  | { utf16: string }
  | { bool: boolean }
  | { int: number };

function bplist(objects: BplistObject[], top = 0): Buffer {
  const lengthBytes = (marker: number, count: number) =>
    count < 15
      ? Buffer.from([marker | count])
      : Buffer.from([marker | 0x0f, 0x10, count]);
  const bodies = objects.map((object) => {
    if ('dict' in object)
      return Buffer.concat([
        lengthBytes(0xd0, object.dict.length),
        Buffer.from(object.dict.map(([key]) => key)),
        Buffer.from(object.dict.map(([, value]) => value)),
      ]);
    if ('array' in object)
      return Buffer.concat([
        lengthBytes(0xa0, object.array.length),
        Buffer.from(object.array),
      ]);
    if ('string' in object)
      return Buffer.concat([
        lengthBytes(0x50, object.string.length),
        Buffer.from(object.string, 'latin1'),
      ]);
    if ('utf16' in object) {
      const raw = Buffer.from(object.utf16, 'utf16le');
      raw.swap16();
      return Buffer.concat([lengthBytes(0x60, object.utf16.length), raw]);
    }
    if ('int' in object) return Buffer.from([0x10, object.int]);
    return Buffer.from([object.bool ? 0x09 : 0x08]);
  });
  const offsets: number[] = [];
  let at = 8;
  for (const body of bodies) {
    offsets.push(at);
    at += body.length;
  }
  const trailer = Buffer.alloc(32);
  trailer[6] = 1; // offset size
  trailer[7] = 1; // object reference size
  trailer.writeBigUInt64BE(BigInt(objects.length), 8);
  trailer.writeBigUInt64BE(BigInt(top), 16);
  trailer.writeBigUInt64BE(BigInt(at), 24);
  return Buffer.concat([
    Buffer.from('bplist00'),
    ...bodies,
    Buffer.from(offsets),
    trailer,
  ]);
}

// #4515 fix round 2: duplicate validation covers every encoding plutil
// accepts, before conversion merges the keys.
describe('every property list encoding is scanned for a repeated key', () => {
  // { schemaVersion: 1, organization: "Acme", limits: { telemetry: false },
  //   limits: {} } in binary: the second limits would erase the first.
  const duplicateLimits = bplist([
    /* 0 */ {
      dict: [
        [1, 2],
        [3, 4],
        [5, 6],
        [5, 8],
      ],
    },
    /* 1 */ { string: 'schemaVersion' },
    /* 2 */ { int: 1 },
    /* 3 */ { string: 'organization' },
    /* 4 */ { string: 'Acme' },
    /* 5 */ { string: 'limits' },
    /* 6 */ { dict: [[7, 9]] },
    /* 7 */ { string: 'telemetry' },
    /* 8 */ { dict: [] },
    /* 9 */ { bool: false },
  ]);

  test('a binary dict that repeats a key is found, at any depth, ASCII or UTF-16', () => {
    expect(binaryPlistKeyScanProblem(duplicateLimits)).toBe(
      'it repeats the key limits',
    );
    const nested = bplist([
      { dict: [[1, 2]] },
      { string: 'limits' },
      {
        dict: [
          [3, 4],
          [5, 4],
        ],
      },
      { string: 'telemetry' },
      { bool: false },
      { utf16: 'telemetry' },
    ]);
    expect(binaryPlistKeyScanProblem(nested)).toBe(
      'it repeats the key limits.telemetry',
    );
    const inArray = bplist([
      { array: [1] },
      {
        dict: [
          [2, 3],
          [2, 3],
        ],
      },
      { string: 'x' },
      { bool: true },
    ]);
    expect(binaryPlistKeyScanProblem(inArray)).toBe('it repeats the key x');
  });

  test('distinct keys pass, and what the scan cannot read is refused', () => {
    expect(
      binaryPlistKeyScanProblem(
        bplist([
          {
            dict: [
              [1, 2],
              [3, 2],
            ],
          },
          { string: 'a' },
          { bool: true },
          { string: 'b' },
        ]),
      ),
    ).toBeNull();
    // A key that is not a string.
    expect(
      binaryPlistKeyScanProblem(bplist([{ dict: [[1, 1]] }, { bool: true }])),
    ).not.toBeNull();
    // A cycle: the dict holds itself.
    expect(
      binaryPlistKeyScanProblem(bplist([{ dict: [[1, 0]] }, { string: 'a' }])),
    ).not.toBeNull();
    // A truncated table.
    expect(
      binaryPlistKeyScanProblem(duplicateLimits.subarray(0, 30)),
    ).not.toBeNull();
  });

  test.skipIf(!hasPlutil)(
    'plutil accepts the binary duplicate without a word and keeps one of the two, which is why the scan must run first',
    () => {
      const path = join(makeTempDir('station-bplist-plutil-'), 'p.plist');
      writeFileSync(path, duplicateLimits);
      const json = JSON.parse(
        execFileSync(PLUTIL, ['-convert', 'json', '-o', '-', path], {
          encoding: 'utf8',
        }),
      );
      // No error, and one `limits` silently gone: which one depends on the
      // order in the file (here the first is kept), so neither is safe.
      expect(Object.keys(json).sort()).toEqual([
        'limits',
        'organization',
        'schemaVersion',
      ]);
      expect([{}, { telemetry: false }]).toContainEqual(json.limits);
    },
  );

  test("the reviewer's binary profile with two limits keys is refused as invalid", () => {
    const path = join(makeTempDir('station-policy-bplist-'), 'p.plist');
    writeFileSync(path, duplicateLimits);
    const load = () =>
      loadManagedPolicyFromSources([
        macosProfileSource(
          path,
          null,
          hasPlutil
            ? plutilConverter()
            : jsonConverter({
                schemaVersion: 1,
                organization: 'Acme',
                limits: {},
              }),
        ),
      ]);
    expect(load).toThrow(ManagedPolicyInvalidError);
    expect(load).toThrow('duplicate key limits');
  });

  test("the reviewer's JSON-form profile is refused: it is not what macOS writes", () => {
    const path = join(makeTempDir('station-policy-jsonform-'), 'p.plist');
    writeFileSync(
      path,
      '{"schemaVersion":1,"organization":"Acme","limits":{"engines":{"allowed":[]}},"limits":{}}',
    );
    const load = () =>
      loadManagedPolicyFromSources([
        macosProfileSource(
          path,
          null,
          hasPlutil
            ? plutilConverter()
            : jsonConverter({
                schemaVersion: 1,
                organization: 'Acme',
                limits: {},
              }),
        ),
      ]);
    expect(load).toThrow(ManagedPolicyInvalidError);
    expect(load).toThrow('it is not an XML or binary property list');
  });
});

// #4515 fix round 3: shared references in a binary plist must not make the
// startup scan exponential. The reviewer's 273-byte profile: 34 nested arrays,
// each referencing the next twice (under the size and depth bounds), ran past
// 12 seconds and had to be killed.
describe('a binary plist that shares references is scanned in bounded work', () => {
  const shared = (levels: number) =>
    bplist([
      ...Array.from({ length: levels }, (_, i) => ({ array: [i + 1, i + 1] })),
      { bool: true },
    ]);

  test("the reviewer's 34-level shape finishes in well under a second", () => {
    const bytes = shared(34);
    // The reported structure (34 arrays, each referencing the next twice:
    // 2^34 paths), in this builder's narrowest encoding.
    expect(bytes.length).toBeLessThan(1024);
    const started = performance.now();
    expect(binaryPlistKeyScanProblem(bytes)).toBeNull();
    expect(performance.now() - started).toBeLessThan(500);
  }, 5_000);

  test('a profile whose references exceed the visit budget is refused', () => {
    // Pinned beside the constants under test.
    expect(BINARY_PLIST_VISITS_PER_OBJECT).toBe(4);
    expect(BINARY_PLIST_VISIT_ALLOWANCE).toBe(256);
    // 20 arrays of 200 references to one string: 22 objects (a budget of
    // 344 visits) and 4021 visits, each array expanded only once.
    const top = { array: Array.from({ length: 20 }, (_, i) => i + 1) };
    const arrays = Array.from({ length: 20 }, () => ({
      array: Array.from({ length: 200 }, () => 21),
    }));
    const bytes = bplist([top, ...arrays, { string: 'x' }]);
    expect(binaryPlistKeyScanProblem(bytes)).toBe(
      'it is a binary property list Station cannot read',
    );
    // At the profile source, before conversion: the invalid-policy error,
    // and the converter is never asked.
    const path = join(makeTempDir('station-policy-budget-'), 'p.plist');
    writeFileSync(path, bytes);
    let converted = false;
    const load = () =>
      loadManagedPolicyFromSources([
        macosProfileSource(path, null, () => {
          converted = true;
          return { ok: true, json: '{}' };
        }),
      ]);
    expect(load).toThrow(ManagedPolicyInvalidError);
    expect(load).toThrow('it is a binary property list Station cannot read');
    expect(converted).toBe(false);
    // Just inside the budget: one array of 200 references to one string
    // (3 objects, 268 allowed, 201 visits) is read.
    expect(
      binaryPlistKeyScanProblem(
        bplist([
          { array: [1] },
          { array: Array.from({ length: 200 }, () => 2) },
          { string: 'x' },
        ]),
      ),
    ).toBeNull();
  });
});
