import {
  MANAGED_POLICY_ENFORCED_LIMIT_KEYS,
  MANAGED_POLICY_RESERVED_LIMIT_KEYS,
  type ManagedPolicyDocument,
} from '@kontourai/station-contracts/managed-policy';
import { describe, expect, test } from 'vitest';
import { EVERY_KEY_LIMITS } from '../../../contracts/src/__tests__/managed-policy-every-key.fixture.js';
import { decodeManagedPolicy } from '../managed-policy.js';
import {
  MANAGED_POLICY_CONTROLS,
  managedPolicyRegistryValues,
  type RegistryKeySnapshot,
  type RegistryValue,
  registryPolicyInput,
  templateManagedPolicyControls,
  WINDOWS_POLICY_KEY,
} from '../managed-policy-controls.js';

const sz = (name: string, data: string): RegistryValue => ({
  name,
  type: 'REG_SZ',
  data,
});
const dword = (name: string, data: number): RegistryValue => ({
  name,
  type: 'REG_DWORD',
  data,
});
const multi = (name: string, data: string[]): RegistryValue => ({
  name,
  type: 'REG_MULTI_SZ',
  data,
});
const key = (...values: RegistryValue[]): RegistryKeySnapshot => ({
  values,
  subkeys: [],
});

/** Decode a key the way the registry source does, through the real parser. */
function load(snapshot: RegistryKeySnapshot): ManagedPolicyDocument {
  const input = registryPolicyInput(snapshot);
  if (input.kind !== 'text' && input.kind !== 'value')
    throw new Error(`expected a policy, got ${JSON.stringify(input)}`);
  return decodeManagedPolicy(WINDOWS_POLICY_KEY, input);
}

function problem(snapshot: RegistryKeySnapshot): string {
  const input = registryPolicyInput(snapshot);
  if (input.kind !== 'problem')
    throw new Error(`expected a problem, got ${JSON.stringify(input)}`);
  return input.reason;
}

/*
 * The values below are what Group Policy writes for the generated ADMX
 * (`managed-policy-templates.ts`), per the ADMX semantics in [MS-GPREG]:
 *
 * - a policy with `valueName` and enabledValue/disabledValue writes that
 *   REG_DWORD 1 when Enabled and 0 when Disabled;
 * - Enabled writes each element: `text` and `enum` a REG_SZ (an optional box
 *   left blank is an empty REG_SZ), `multiText` a REG_MULTI_SZ, `boolean`
 *   its trueValue/falseValue REG_DWORD;
 * - Disabled deletes the element values (registry.pol `**del.<name>`) and
 *   writes only the policy's disabledValue;
 * - Not Configured removes everything the policy wrote.
 */
describe('Group Policy template values', () => {
  test('an Enabled organization, Disabled switches and an allow list map to the document', () => {
    const document = load(
      key(
        sz('Organization', 'Acme Corp'),
        sz('SupportUrl', ''),
        dword('Telemetry', 0),
        dword('WebhookAutomations', 0),
        dword('RegistryAllowList', 1),
        multi('RegistryAllowedUrls', [
          'https://plugins.acme.example/catalog',
          '',
          '  https://skills.acme.example  ',
        ]),
        dword('RegistryUnsignedPackages', 0),
        dword('DefaultSkillRegistries', 0),
        dword('AcpRegistryInstalls', 0),
      ),
    );
    expect(document).toEqual({
      schemaVersion: 1,
      organization: 'Acme Corp',
      limits: {
        telemetry: false,
        webhookAutomations: false,
        registries: {
          allowedUrls: [
            'https://plugins.acme.example/catalog',
            'https://skills.acme.example',
          ],
          unsignedPackages: false,
          defaultSkillRegistries: false,
          acpRegistryInstalls: false,
        },
      },
    });
  });

  test('Disabled on an "Allow" switch turns the capability off; Enabled leaves it to users', () => {
    expect(
      load(key(sz('Organization', 'Acme'), dword('Telemetry', 0))).limits,
    ).toEqual({ telemetry: false });
    expect(
      load(key(sz('Organization', 'Acme'), dword('Telemetry', 1))),
    ).toEqual({ schemaVersion: 1, organization: 'Acme' });
  });

  test('Disabled on any other policy is refused, never read as "no restriction"', () => {
    // Disabled writes only the state value; the URL list is deleted.
    expect(
      problem(key(sz('Organization', 'Acme'), dword('RegistryAllowList', 0))),
    ).toContain('"Allowed plugin and skill registries" is set to Disabled');
    expect(
      problem(key(sz('Organization', 'Acme'), dword('ManagedSettings', 0))),
    ).toContain('is set to Disabled');
    // Elements left behind by a hand-edited key do not rescue it.
    expect(
      problem(
        key(
          sz('Organization', 'Acme'),
          dword('RegistryAllowList', 0),
          multi('RegistryAllowedUrls', ['https://x.example']),
        ),
      ),
    ).toContain('Disabled');
  });

  test('Disabled Organization (its text deleted) beside another policy is refused', () => {
    expect(problem(key(dword('Telemetry', 0)))).toContain(
      '"Organization" policy',
    );
    // An "Allow" policy left Enabled is still a configured policy.
    expect(problem(key(dword('Telemetry', 1)))).toContain('"Organization"');
  });

  test('an empty key is no policy', () => {
    expect(registryPolicyInput(key())).toEqual({ kind: 'absent' });
  });

  test('an Enabled allow list with no lines allows no registry', () => {
    expect(
      load(
        key(
          sz('Organization', 'Acme'),
          dword('RegistryAllowList', 1),
          multi('RegistryAllowedUrls', []),
        ),
      ).limits,
    ).toEqual({ registries: { allowedUrls: [] } });
  });

  test('an Enabled policy whose value is missing is refused', () => {
    expect(
      problem(key(sz('Organization', 'Acme'), dword('RegistryAllowList', 1))),
    ).toContain('RegistryAllowedUrls is missing');
  });

  test('managed settings JSON comes from a REG_MULTI_SZ and reaches the parser', () => {
    // This build accepts only an empty settings object (#4517 adds entries).
    expect(
      load(
        key(
          sz('Organization', 'Acme'),
          dword('ManagedSettings', 1),
          multi('ManagedSettingsJson', ['{', '}']),
        ),
      ),
    ).toEqual({ schemaVersion: 1, organization: 'Acme', settings: {} });
    expect(
      problem(
        key(
          sz('Organization', 'Acme'),
          dword('ManagedSettings', 1),
          multi('ManagedSettingsJson', ['{"a": 1, "a": 2}']),
        ),
      ),
    ).toContain('repeats the key a');
    expect(
      problem(
        key(
          sz('Organization', 'Acme'),
          dword('ManagedSettings', 1),
          multi('ManagedSettingsJson', ['[]']),
        ),
      ),
    ).toContain('must hold a JSON object');
  });

  test('value names compare without case, as the registry does', () => {
    expect(
      load(key(sz('organization', 'Acme'), dword('TELEMETRY', 0))).limits,
    ).toEqual({ telemetry: false });
  });

  test.each([
    [dword('Telemetry', 2), 'REG_DWORD of 0 or 1'],
    [sz('Telemetry', '0'), 'REG_DWORD of 0 or 1'],
    [dword('Organization', 1), 'must be a REG_SZ'],
    [
      { name: 'Organization', type: 'other', typeCode: 2 } as RegistryValue,
      'type 2',
    ],
    [sz('RegistryAllowedUrls', 'https://x.example'), 'must be a REG_MULTI_SZ'],
  ])('a value of the wrong type is refused (%j)', (value, message) => {
    const values = [value];
    if (value.name !== 'Organization') values.push(sz('Organization', 'Acme'));
    expect(problem(key(...values))).toContain(message);
  });

  test('an unknown value or subkey is refused: it may be a newer restriction', () => {
    expect(
      problem(key(sz('Organization', 'Acme'), dword('AllowEverything', 1))),
    ).toContain('AllowEverything is not a Station policy value');
    expect(
      problem({ values: [sz('Organization', 'Acme')], subkeys: ['Clients'] }),
    ).toContain(`${WINDOWS_POLICY_KEY}\\Clients is not a Station policy key`);
  });
});

describe('the single Policy value', () => {
  const json = JSON.stringify({ schemaVersion: 1, organization: 'Acme' });

  test('holds the whole document as JSON text', () => {
    expect(registryPolicyInput(key(sz('Policy', json)))).toEqual({
      kind: 'text',
      text: json,
    });
    expect(load(key(sz('Policy', json)))).toEqual({
      schemaVersion: 1,
      organization: 'Acme',
    });
  });

  test('beside template values is refused', () => {
    const reason = problem(key(sz('Policy', json), dword('Telemetry', 0)));
    expect(reason).toContain(
      'both a Policy value and Group Policy template values',
    );
    expect(reason).toContain('Telemetry');
  });

  test('must be a REG_SZ', () => {
    expect(problem(key(multi('Policy', [json])))).toContain(
      'must be a REG_SZ holding the policy JSON',
    );
  });
});

describe('the control table and the contract', () => {
  test('every limit this build enforces has a template control', () => {
    const covered = new Set(
      templateManagedPolicyControls().map((control) => control.limitKey),
    );
    const missing = MANAGED_POLICY_ENFORCED_LIMIT_KEYS.filter(
      (limit) => !covered.has(limit),
    );
    expect(missing).toEqual([]);
  });

  test('every control names a limit the contract knows', () => {
    const known = new Set([
      ...MANAGED_POLICY_ENFORCED_LIMIT_KEYS,
      ...MANAGED_POLICY_RESERVED_LIMIT_KEYS,
    ]);
    for (const control of MANAGED_POLICY_CONTROLS)
      if (control.limitKey !== undefined)
        expect(known.has(control.limitKey), control.id).toBe(true);
  });

  test('the template leaves out limits this build does not enforce yet', () => {
    const offered = templateManagedPolicyControls(['telemetry']);
    expect(offered.map((control) => control.limitKey ?? null)).toEqual(
      expect.not.arrayContaining(['clients', 'updates', 'registries']),
    );
    expect(offered.some((control) => control.limitKey === 'telemetry')).toBe(
      true,
    );
  });

  test('later-slice controls map to the document paths their issues define', () => {
    const input = registryPolicyInput(
      key(
        sz('Organization', 'Acme'),
        dword('ApprovalCeiling', 1),
        sz('MaxApprovalMode', 'auto'),
        dword('Updates', 0),
        dword('UpdateMirror', 1),
        sz('UpdateFeedUrl', 'https://mirror.acme.example/station'),
        dword('NightlyChannel', 0),
        dword('AllowedEngines', 1),
        dword('EngineClaude', 0),
        dword('EngineCodex', 1),
        dword('EngineMuse', 0),
        dword('EngineAcp', 1),
        dword('EngineStationAgent', 0),
        dword('AcpRegistryAgents', 0),
        dword('EngineInstances', 1),
        multi('EngineInstancesJson', [
          '{"codex": {"locked": true, "binaryPath": "/opt/acme/bin/codex"}}',
        ]),
      ),
    );
    expect(input).toEqual({
      kind: 'value',
      value: {
        schemaVersion: 1,
        organization: 'Acme',
        limits: {
          maxApprovalMode: 'auto',
          updates: {
            mode: 'off',
            feedUrl: 'https://mirror.acme.example/station',
            allowNightly: false,
          },
          engines: {
            allowed: ['codex', 'acp'],
            acpRegistryAgents: false,
            instances: {
              codex: { locked: true, binaryPath: '/opt/acme/bin/codex' },
            },
          },
        },
      },
    });
    expect(
      problem(
        key(
          sz('Organization', 'Acme'),
          dword('ApprovalCeiling', 1),
          sz('MaxApprovalMode', 'full'),
        ),
      ),
    ).toContain('must be one of "ask", "auto", "never"');
  });

  test('a document with every enforced limit round-trips through the template values', () => {
    const document: ManagedPolicyDocument = {
      schemaVersion: 1,
      organization: 'Acme Corp',
      supportUrl: 'https://help.acme.example/station',
      settings: {},
      // #4515: the combined fixture, every limit this build enforces.
      limits: JSON.parse(JSON.stringify(EVERY_KEY_LIMITS)),
    };
    // The fixture must exercise every enforced limit, or the round trip
    // would prove nothing about a newly enforced one.
    expect(Object.keys(document.limits ?? {}).sort()).toEqual(
      [...MANAGED_POLICY_ENFORCED_LIMIT_KEYS].sort(),
    );
    expect(load(key(...managedPolicyRegistryValues(document)))).toEqual(
      decodeManagedPolicy('fixture', {
        kind: 'text',
        text: JSON.stringify(document),
      }),
    );
  });
});
