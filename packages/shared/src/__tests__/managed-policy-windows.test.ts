import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';
import {
  loadManagedPolicyFromSources,
  ManagedPolicyInvalidError,
  managedPolicyFileSource,
  windowsRegistrySource,
} from '../managed-policy.js';
import {
  type RegistryKeySnapshot,
  WINDOWS_POLICY_KEY,
  WINDOWS_POLICY_SUBKEY,
} from '../managed-policy-controls.js';
import {
  securityDescriptorProblem,
  type WindowsSecurityApi,
  windowsKeyChainProblem,
  windowsPathChainProblem,
} from '../managed-policy-windows.js';

const makeTempDir = trackTempDirs();

const TI = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464';
const APP =
  'S-1-15-3-1024-1065365936-1281604716-3511738428-1654721687-432734479-3232135806-4053264122-3456934681';

/*
 * Owner and DACL exactly as Windows 11 (26200) reports them, read on the
 * test host with Get-Acl's GetSecurityDescriptorSddlForm('Owner, Access'),
 * the same form ConvertSecurityDescriptorToStringSecurityDescriptorW gives.
 */
const REAL = {
  driveRoot: `O:${TI}D:PAI(A;;LC;;;AU)(A;OICIIO;SDGXGWGR;;;AU)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)(A;;0x1000a1;;;S-1-15-3-65536-1888954469-739942743-1668119174-2468466756-4239452838-1296943325-355587736-700089176)`,
  programFiles: `O:${TI}D:PAI(A;OICIIO;GA;;;CO)(A;OICIIO;GA;;;SY)(A;;0x1301bf;;;SY)(A;OICIIO;GA;;;BA)(A;;0x1301bf;;;BA)(A;OICIIO;GXGR;;;BU)(A;;0x1200a9;;;BU)(A;CIIO;GA;;;${TI})(A;;FA;;;${TI})(A;;0x1200a9;;;AC)(A;OICIIO;GXGR;;;AC)(A;;0x1200a9;;;S-1-15-2-2)(A;OICIIO;GXGR;;;S-1-15-2-2)`,
  /** A folder an administrator created under Program Files (inherited ACL). */
  installedFolder: `O:BAD:AI(A;ID;FA;;;${TI})(A;CIIOID;GA;;;${TI})(A;ID;FA;;;SY)(A;OICIIOID;GA;;;SY)(A;ID;FA;;;BA)(A;OICIIOID;GA;;;BA)(A;ID;0x1200a9;;;BU)(A;OICIIOID;GXGR;;;BU)(A;OICIIOID;GA;;;CO)(A;ID;0x1200a9;;;AC)(A;OICIIOID;GXGR;;;AC)(A;ID;0x1200a9;;;S-1-15-2-2)(A;OICIIOID;GXGR;;;S-1-15-2-2)`,
  installedFile:
    'O:BAD:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;0x1200a9;;;BU)(A;ID;0x1200a9;;;AC)(A;ID;0x1200a9;;;S-1-15-2-2)',
  /** A user's own %TEMP%: owned and fully controlled by the user. */
  userTemp:
    'O:S-1-5-21-2612459134-1529638752-2094432294-1001D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;S-1-5-21-2612459134-1529638752-2094432294-1001)',
  software: `O:BAD:PAI(A;CI;KA;;;CO)(A;CI;KA;;;SY)(A;CI;KA;;;BA)(A;CI;KR;;;BU)(A;CI;KR;;;AC)(A;CI;KR;;;${APP})`,
  policies: `O:SYD:P(A;OICIIO;GR;;;AU)(A;;KR;;;AU)(A;;KA;;;SY)(A;OICIIO;GA;;;SY)(A;OICIIO;GA;;;BA)(A;;KA;;;BA)(A;;KR;;;AC)(A;OICIIO;GR;;;AC)(A;;KR;;;${APP})(A;OICIIO;GR;;;${APP})`,
  /** A key created under Policies by an administrator (inherited ACL). */
  policyKey: `O:BAD:AI(A;ID;KR;;;AU)(A;OICIIOID;GR;;;AU)(A;ID;KA;;;SY)(A;OICIIOID;GA;;;SY)(A;ID;KA;;;BA)(A;OICIIOID;GA;;;BA)(A;ID;KR;;;AC)(A;OICIIOID;GR;;;AC)`,
};

describe('securityDescriptorProblem', () => {
  test.each([
    ['C:\\', REAL.driveRoot, 'ancestor-folder'],
    ['C:\\Program Files', REAL.programFiles, 'ancestor-folder'],
    ['C:\\Program Files\\Station', REAL.installedFolder, 'policy-folder'],
    ['C:\\Program Files\\Station\\policy.json', REAL.installedFile, 'file'],
    ['HKLM\\SOFTWARE', REAL.software, 'ancestor-key'],
    ['HKLM\\SOFTWARE\\Policies', REAL.policies, 'ancestor-key'],
    [
      'HKLM\\SOFTWARE\\Policies\\Kontour\\Station',
      REAL.policyKey,
      'policy-key',
    ],
  ] as const)('a stock Windows ACL passes: %s', (target, sddl, role) => {
    expect(securityDescriptorProblem(target, sddl, role)).toBeNull();
  });

  test('a user-owned folder is refused by its owner', () => {
    expect(
      securityDescriptorProblem(
        'C:\\Users\\u\\Temp',
        REAL.userTemp,
        'policy-folder',
      ),
    ).toContain('must be owned by Administrators, SYSTEM or TrustedInstaller');
  });

  test.each([
    ['file', '(A;;FW;;;BU)', 'Users (S-1-5-32-545)'],
    ['file', '(A;ID;0x1301bf;;;AU)', 'Authenticated Users'],
    ['file', '(A;;WD;;;WD)', 'Everyone'],
    ['policy-folder', '(A;;0x2;;;BU)', 'Users'],
    ['ancestor-folder', '(A;;0x40;;;BU)', 'Users'],
    ['ancestor-folder', '(A;;SD;;;S-1-5-21-1-2-3-1001)', 'S-1-5-21-1-2-3-1001'],
    ['policy-key', '(A;;KW;;;BU)', 'Users'],
    ['policy-key', '(A;;0x2;;;AU)', 'Authenticated Users'],
    ['ancestor-key', '(A;;WO;;;BU)', 'Users'],
    // An unrecognized right counts as every right.
    ['file', '(A;;ZZ;;;BU)', 'Users'],
    // Callback and object allow ACEs grant like plain ones.
    ['file', '(XA;;FA;;;BU;(WIN://x))', 'Users'],
  ] as const)(
    '%s: an ACE %s granting write to %s is refused',
    (role, ace, who) => {
      const problem = securityDescriptorProblem(
        'target',
        `O:BAD:AI(A;;FA;;;SY)(A;;FA;;;BA)${ace}`,
        role,
      );
      expect(problem).toContain(who);
      expect(problem).toContain(
        'only Administrators, SYSTEM and TrustedInstaller may',
      );
    },
  );

  test('rights that cannot change the object are allowed for anyone', () => {
    // Read and execute; on an ancestor folder, adding a subfolder (LC on C:\).
    expect(
      securityDescriptorProblem('f', 'O:BAD:(A;;0x1200a9;;;BU)', 'file'),
    ).toBeNull();
    expect(
      securityDescriptorProblem('d', 'O:SYD:(A;;LC;;;AU)', 'ancestor-folder'),
    ).toBeNull();
    expect(
      securityDescriptorProblem('k', 'O:SYD:(A;;KR;;;BU)', 'policy-key'),
    ).toBeNull();
  });

  test('inherit-only and deny ACEs are not grants on the object', () => {
    expect(
      securityDescriptorProblem(
        'f',
        'O:BAD:(A;OICIIO;GA;;;BU)(D;;FA;;;BU)',
        'file',
      ),
    ).toBeNull();
    // "IO" must be the flag token, not two letters straddling others.
    expect(
      securityDescriptorProblem('f', 'O:BAD:(A;CIOI;FW;;;BU)', 'file'),
    ).toContain('Users');
  });

  test('a NULL DACL or an unreadable descriptor is refused', () => {
    expect(
      securityDescriptorProblem('f', 'O:BAD:NO_ACCESS_CONTROL', 'file'),
    ).toContain('no access control list');
    expect(securityDescriptorProblem('f', 'D:(A;;FA;;;SY)', 'file')).toContain(
      'no owner',
    );
    expect(securityDescriptorProblem('f', 'O:BA', 'file')).toContain(
      'no access control list Station can read',
    );
  });
});

/** A fake Win32 reader over fixed tables. */
function fakeApi(options: {
  paths?: Record<string, string>;
  reparse?: string[];
  keys?: Record<string, string>;
  snapshot?: RegistryKeySnapshot;
  readError?: Error;
}): WindowsSecurityApi {
  return {
    readMachineKey: (subkey) => {
      expect(subkey).toBe(WINDOWS_POLICY_SUBKEY);
      if (options.readError) throw options.readError;
      return options.snapshot;
    },
    machineKeySddl: (subkey) => options.keys?.[subkey],
    pathSddl: (path) => {
      const sddl = options.paths?.[path];
      if (sddl === undefined) throw new Error(`no such path ${path}`);
      return sddl;
    },
    isReparsePoint: (path) => options.reparse?.includes(path) ?? false,
  };
}

const STOCK_PATHS = {
  'C:\\': REAL.driveRoot,
  'C:\\Program Files': REAL.programFiles,
  'C:\\Program Files\\Station': REAL.installedFolder,
  'C:\\Program Files\\Station\\policy.json': REAL.installedFile,
};
const STOCK_KEYS = {
  SOFTWARE: REAL.software,
  'SOFTWARE\\Policies': REAL.policies,
  'SOFTWARE\\Policies\\Kontour': REAL.policyKey,
  'SOFTWARE\\Policies\\Kontour\\Station': REAL.policyKey,
};
const FILE = 'C:\\Program Files\\Station\\policy.json';

describe('windowsPathChainProblem', () => {
  test('walks the file, its folder and every folder up to the drive', () => {
    const seen: string[] = [];
    const api = fakeApi({ paths: STOCK_PATHS });
    const tracking: WindowsSecurityApi = {
      ...api,
      pathSddl: (path) => {
        seen.push(path);
        return api.pathSddl(path);
      },
    };
    expect(windowsPathChainProblem(FILE, tracking)).toBeNull();
    expect(seen).toEqual([
      FILE,
      'C:\\Program Files\\Station',
      'C:\\Program Files',
      'C:\\',
    ]);
  });

  test('a writable folder anywhere above the file is refused', () => {
    expect(
      windowsPathChainProblem(
        FILE,
        fakeApi({
          paths: {
            ...STOCK_PATHS,
            'C:\\Program Files\\Station': `${REAL.installedFolder}(A;OICI;0x1301bf;;;BU)`,
          },
        }),
      ),
    ).toContain('C:\\Program Files\\Station lets Users');
  });

  test('a reparse point in the chain is refused', () => {
    expect(
      windowsPathChainProblem(
        FILE,
        fakeApi({
          paths: STOCK_PATHS,
          reparse: ['C:\\Program Files\\Station'],
        }),
      ),
    ).toContain('reparse point');
  });

  test('permissions that cannot be read are refused, not skipped', () => {
    expect(windowsPathChainProblem(FILE, fakeApi({ paths: {} }))).toContain(
      'cannot be read',
    );
  });
});

describe('windowsKeyChainProblem', () => {
  test('a stock key passes and a writable one is refused', () => {
    expect(
      windowsKeyChainProblem(
        WINDOWS_POLICY_SUBKEY,
        fakeApi({ keys: STOCK_KEYS }),
      ),
    ).toBeNull();
    expect(
      windowsKeyChainProblem(
        WINDOWS_POLICY_SUBKEY,
        fakeApi({
          keys: {
            ...STOCK_KEYS,
            'SOFTWARE\\Policies\\Kontour': `${REAL.policyKey}(A;CI;KA;;;BU)`,
          },
        }),
      ),
    ).toContain('HKLM\\SOFTWARE\\Policies\\Kontour lets Users');
  });
});

describe('windowsRegistrySource', () => {
  const ENABLED = {
    values: [
      { name: 'Organization', type: 'REG_SZ' as const, data: 'Acme' },
      { name: 'Telemetry', type: 'REG_DWORD' as const, data: 0 },
    ],
    subkeys: [],
  };

  test('loads template values from a key only administrators can change', () => {
    const loaded = loadManagedPolicyFromSources([
      windowsRegistrySource(fakeApi({ snapshot: ENABLED, keys: STOCK_KEYS })),
    ]);
    expect(loaded?.source).toEqual({
      kind: 'windows-registry',
      location: WINDOWS_POLICY_KEY,
    });
    expect(loaded?.document.limits).toEqual({ telemetry: false });
  });

  test('a missing or empty key is no policy, and its ACL is not consulted', () => {
    for (const snapshot of [undefined, { values: [], subkeys: [] }])
      expect(
        loadManagedPolicyFromSources([
          windowsRegistrySource(fakeApi({ snapshot, keys: {} })),
        ]),
      ).toBeNull();
  });

  test('a key a user can write is refused', () => {
    expect(() =>
      loadManagedPolicyFromSources([
        windowsRegistrySource(
          fakeApi({
            snapshot: ENABLED,
            keys: {
              ...STOCK_KEYS,
              'SOFTWARE\\Policies\\Kontour\\Station': `${REAL.policyKey}(A;;KW;;;BU)`,
            },
          }),
        ),
      ]),
    ).toThrow(/STATION_MANAGED_POLICY_INVALID.*Kontour\\Station lets Users/);
  });

  test('a registry read failure fails closed', () => {
    expect(() =>
      loadManagedPolicyFromSources([
        windowsRegistrySource(
          fakeApi({ readError: new Error("Cannot find module 'koffi'") }),
        ),
      ]),
    ).toThrow(ManagedPolicyInvalidError);
  });

  test('the registry and a policy file both present is a startup error', () => {
    const dir = makeTempDir('station-policy-win-');
    const file = join(dir, 'policy.json');
    writeFileSync(
      file,
      JSON.stringify({ schemaVersion: 1, organization: 'Acme' }),
    );
    expect(() =>
      loadManagedPolicyFromSources([
        managedPolicyFileSource(file),
        windowsRegistrySource(fakeApi({ snapshot: ENABLED, keys: STOCK_KEYS })),
      ]),
    ).toThrow(
      `${file} and ${WINDOWS_POLICY_KEY}: more than one policy source is installed`,
    );
  });
});

describe('DACL parsing', () => {
  test('a conditional ACE does not hide the ACEs after it', () => {
    expect(
      securityDescriptorProblem(
        'f',
        'O:BAD:(XA;;FR;;;BU;(@User.x == 1))(A;;FW;;;BU)',
        'file',
      ),
    ).toContain('Users');
  });

  test('an unbalanced or trailing-garbage DACL is unreadable, not partly read', () => {
    for (const sddl of [
      'O:BAD:(A;;FA;;;SY',
      'O:BAD:(A;;FA;;;SY)junk(A;;FW;;;BU)',
    ])
      expect(securityDescriptorProblem('f', sddl, 'file')).toContain(
        'no access control list Station can read',
      );
  });
});
