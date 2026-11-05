/**
 * Windows side of the managed policy (#4524): reading
 * `HKLM\SOFTWARE\Policies\Kontour\Station` and checking that only
 * Administrators, SYSTEM or TrustedInstaller can change the policy key, the
 * policy file and the folders above it.
 *
 * Everything goes through the Win32 API in this process (advapi32 through
 * the `koffi` FFI), never through `reg.exe`, `icacls` or PowerShell, which
 * an organization may block for users. Only the 64-bit machine view is read:
 * no HKCU, no WOW6432Node, no registry virtualization.
 *
 * The access rule is evaluated on the SDDL form of each security descriptor
 * by {@link securityDescriptorProblem}, which is pure and tested on every OS;
 * only the reads need Windows.
 */
import { createRequire } from 'node:module';
import { win32 } from 'node:path';
import type {
  RegistryKeySnapshot,
  RegistryValue,
} from './managed-policy-controls.js';

// ---------------------------------------------------------------------------
// Security descriptors (SDDL)
// ---------------------------------------------------------------------------

const SID_SYSTEM = 'S-1-5-18';
const SID_ADMINISTRATORS = 'S-1-5-32-544';
const SID_TRUSTED_INSTALLER =
  'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464';
/** CREATOR OWNER: an effective ACE for it matches no token. */
const SID_CREATOR_OWNER = 'S-1-3-0';
/** OWNER RIGHTS: the object's owner, which must already be trusted. */
const SID_OWNER_RIGHTS = 'S-1-3-4';

/** SDDL SID aliases, as `ConvertSecurityDescriptorToStringSecurityDescriptorW` writes them. */
const SID_ALIASES: Readonly<Record<string, string>> = {
  SY: SID_SYSTEM,
  BA: SID_ADMINISTRATORS,
  CO: SID_CREATOR_OWNER,
  OW: SID_OWNER_RIGHTS,
  BU: 'S-1-5-32-545',
  BG: 'S-1-5-32-546',
  PU: 'S-1-5-32-547',
  AU: 'S-1-5-11',
  WD: 'S-1-1-0',
  IU: 'S-1-5-4',
  NU: 'S-1-5-2',
  SU: 'S-1-5-6',
  AN: 'S-1-5-7',
  NS: 'S-1-5-20',
  LS: 'S-1-5-19',
  PS: 'S-1-5-10',
  RC: 'S-1-5-12',
  AC: 'S-1-15-2-1',
  CG: 'S-1-3-1',
  RD: 'S-1-5-32-555',
  RU: 'S-1-5-32-554',
  LU: 'S-1-5-32-559',
  MU: 'S-1-5-32-558',
  NO: 'S-1-5-32-556',
  SO: 'S-1-5-32-549',
  PO: 'S-1-5-32-550',
  BO: 'S-1-5-32-551',
  RE: 'S-1-5-32-552',
  IS: 'S-1-5-32-568',
  CY: 'S-1-5-32-569',
  ER: 'S-1-5-32-573',
  HA: 'S-1-5-32-578',
  RM: 'S-1-5-32-580',
  WR: 'S-1-5-33',
  UD: 'S-1-5-84-0-0-0-0-0',
};

const TRUSTED_OWNERS = new Set([
  SID_SYSTEM,
  SID_ADMINISTRATORS,
  SID_TRUSTED_INSTALLER,
]);
const TRUSTED_WRITERS = new Set([
  ...TRUSTED_OWNERS,
  SID_CREATOR_OWNER,
  SID_OWNER_RIGHTS,
]);

const PRINCIPAL_NAMES: Readonly<Record<string, string>> = {
  [SID_SYSTEM]: 'SYSTEM',
  [SID_ADMINISTRATORS]: 'Administrators',
  [SID_TRUSTED_INSTALLER]: 'TrustedInstaller',
  'S-1-5-32-545': 'Users',
  'S-1-5-11': 'Authenticated Users',
  'S-1-1-0': 'Everyone',
  'S-1-5-4': 'INTERACTIVE',
  'S-1-15-2-1': 'ALL APPLICATION PACKAGES',
  'S-1-5-32-547': 'Power Users',
};

/** SDDL access-right letters and their bits. */
const RIGHT_CODES: Readonly<Record<string, number>> = {
  GA: 0x10000000,
  GR: 0x80000000,
  GW: 0x40000000,
  GX: 0x20000000,
  RC: 0x00020000,
  SD: 0x00010000,
  WD: 0x00040000,
  WO: 0x00080000,
  RP: 0x00000010,
  WP: 0x00000020,
  CC: 0x00000001,
  DC: 0x00000002,
  LC: 0x00000004,
  SW: 0x00000008,
  LO: 0x00000080,
  DT: 0x00000040,
  CR: 0x00000100,
  FA: 0x001f01ff,
  FR: 0x00120089,
  FW: 0x00120116,
  FX: 0x001200a0,
  KA: 0x000f003f,
  KR: 0x00020019,
  KW: 0x00020006,
  KX: 0x00020019,
};

const DELETE = 0x10000;
const WRITE_DAC = 0x40000;
const WRITE_OWNER = 0x80000;
const MAXIMUM_ALLOWED = 0x02000000;
const GENERIC_ALL = 0x10000000;
const GENERIC_WRITE = 0x40000000;
const TAKE_OVER =
  DELETE | WRITE_DAC | WRITE_OWNER | MAXIMUM_ALLOWED | GENERIC_ALL;

/**
 * Which rights let a principal change what Station reads. The policy file
 * and its folder: any write. A folder or key above them: anything that
 * would let it remove or re-permission the entry below (delete, delete a
 * child, change the DACL or owner); creating a new entry there changes
 * nothing that exists.
 */
export type SecuredObjectRole =
  | 'file'
  | 'policy-folder'
  | 'ancestor-folder'
  | 'policy-key'
  | 'ancestor-key';

const WRITE_MASKS: Readonly<Record<SecuredObjectRole, number>> = {
  // FILE_WRITE_DATA/ADD_FILE, FILE_APPEND_DATA/ADD_SUBDIRECTORY,
  // FILE_WRITE_EA, FILE_DELETE_CHILD, FILE_WRITE_ATTRIBUTES.
  file: 0x2 | 0x4 | 0x10 | 0x40 | 0x100 | TAKE_OVER | GENERIC_WRITE,
  'policy-folder': 0x2 | 0x4 | 0x10 | 0x40 | 0x100 | TAKE_OVER | GENERIC_WRITE,
  'ancestor-folder': 0x40 | TAKE_OVER,
  // KEY_SET_VALUE, KEY_CREATE_SUB_KEY, KEY_CREATE_LINK.
  'policy-key': 0x2 | 0x4 | 0x20 | TAKE_OVER | GENERIC_WRITE,
  'ancestor-key': 0x20 | TAKE_OVER,
};

function resolveSid(token: string): string {
  return SID_ALIASES[token] ?? token;
}

function principalName(sid: string): string {
  const name = PRINCIPAL_NAMES[sid];
  return name ? `${name} (${sid})` : sid;
}

/** Bits of an SDDL rights field; an unrecognized code counts as every right. */
function rightsMask(field: string): number {
  if (/^0x[0-9a-f]+$/i.test(field)) return Number.parseInt(field, 16);
  if (field.length % 2 !== 0) return 0xffffffff;
  let mask = 0;
  for (let i = 0; i < field.length; i += 2) {
    const bits = RIGHT_CODES[field.slice(i, i + 2)];
    if (bits === undefined) return 0xffffffff;
    mask |= bits;
  }
  return mask >>> 0;
}

/** ACE flags are two-letter tokens (`OICIIO`); compare tokens, not substrings. */
function aceFlagTokens(flags: string): string[] {
  return flags.match(/../g) ?? [];
}

/**
 * The ACE strings of the DACL in `sddl`, `'null'` for a NULL DACL, or
 * `'missing'` when there is none or it cannot be read. ACEs are split on
 * balanced parentheses, because a conditional ACE nests its condition in
 * them; anything unbalanced is unreadable rather than partly read.
 */
function daclAces(sddl: string): string[] | 'null' | 'missing' {
  const start = sddl.indexOf('D:');
  if (start === -1) return 'missing';
  let i = start + 2;
  const flagsEnd = sddl.indexOf('(', i);
  const flags = sddl.slice(i, flagsEnd === -1 ? undefined : flagsEnd);
  if (flags.includes('NO_ACCESS_CONTROL')) return 'null';
  if (!/^[A-Z_]*$/.test(flags)) return 'missing';
  if (flagsEnd === -1) return [];
  i = flagsEnd;
  const aces: string[] = [];
  while (i < sddl.length && sddl[i] === '(') {
    let depth = 0;
    let j = i;
    for (; j < sddl.length; j++) {
      if (sddl[j] === '(') depth++;
      else if (sddl[j] === ')' && --depth === 0) break;
    }
    if (depth !== 0) return 'missing';
    aces.push(sddl.slice(i + 1, j));
    i = j + 1;
  }
  // Only a SACL may follow the DACL.
  if (i < sddl.length && !sddl.startsWith('S:', i)) return 'missing';
  return aces;
}

/** Allow-type ACEs: plain, object, callback and conditional. */
const ALLOW_ACE_TYPES = new Set(['A', 'OA', 'XA', 'ZA']);

/**
 * Why `sddl` (an owner and DACL in SDDL) lets someone other than SYSTEM,
 * Administrators or TrustedInstaller change `target`, or null when it does
 * not. Inherit-only ACEs are skipped (they apply to children, which are
 * checked themselves) and deny ACEs only remove access, so they are
 * ignored: the rule asks whether any untrusted principal is granted a write
 * right, which is conservative.
 */
export function securityDescriptorProblem(
  target: string,
  sddl: string,
  role: SecuredObjectRole,
): string | null {
  const owner = /O:([^:()]+?)(?=[GDS]:|$)/.exec(sddl)?.[1];
  if (!owner) return `${target} has no owner Station can read`;
  const ownerSid = resolveSid(owner);
  if (!TRUSTED_OWNERS.has(ownerSid))
    return `${target} must be owned by Administrators, SYSTEM or TrustedInstaller, but is owned by ${principalName(ownerSid)}`;
  const dacl = daclAces(sddl);
  if (dacl === 'missing')
    return `${target} has no access control list Station can read`;
  if (dacl === 'null')
    return `${target} has no access control list, so everyone can change it`;
  const mask = WRITE_MASKS[role];
  for (const ace of dacl) {
    const [type, flags = '', rights = '', , , sid = ''] = ace.split(';');
    if (!ALLOW_ACE_TYPES.has(type)) continue;
    if (aceFlagTokens(flags).includes('IO')) continue;
    const granted = rightsMask(rights) & mask;
    if (granted === 0) continue;
    const principal = resolveSid(sid);
    if (TRUSTED_WRITERS.has(principal)) continue;
    return `${target} lets ${principalName(principal)} change it (rights 0x${(granted >>> 0).toString(16)}); only Administrators, SYSTEM and TrustedInstaller may`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Win32 access
// ---------------------------------------------------------------------------

/** What the checks need from Windows; tests substitute a fake. */
export interface WindowsSecurityApi {
  /** The key's values and subkey names, or undefined when it does not exist. */
  readMachineKey(
    subkey: string,
    maxDataBytes: number,
  ): RegistryKeySnapshot | undefined;
  /** Owner and DACL of an HKLM key (64-bit view) in SDDL; undefined when absent. */
  machineKeySddl(subkey: string): string | undefined;
  /** Owner and DACL of a file or folder in SDDL. */
  pathSddl(path: string): string;
  /** Whether the file or folder is a reparse point of any kind. */
  isReparsePoint(path: string): boolean;
}

/** A Win32 failure, by its error code. */
export class Win32Error extends Error {
  constructor(
    readonly api: string,
    readonly code: number,
  ) {
    super(`${api} failed with Windows error ${code}`);
    this.name = 'Win32Error';
  }
}

const HKEY_LOCAL_MACHINE = -0x7ffffffe; // (HKEY)(LONG)0x80000002, sign-extended
const KEY_READ = 0x20019;
const READ_CONTROL = 0x20000;
const KEY_WOW64_64KEY = 0x100;
const OWNER_SECURITY_INFORMATION = 0x1;
const DACL_SECURITY_INFORMATION = 0x4;
const SECURITY_INFO = OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
const SDDL_REVISION_1 = 1;
const ERROR_SUCCESS = 0;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_MORE_DATA = 234;
const ERROR_NO_MORE_ITEMS = 259;
const INVALID_FILE_ATTRIBUTES = 0xffffffff;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
const REG_SZ = 1;
const REG_DWORD = 4;
const REG_MULTI_SZ = 7;
/** Registry value and key names are at most 16,383 characters. */
const MAX_NAME_CHARS = 16_384;
/** More values than any template writes; a bigger key is refused, not truncated. */
export const MAX_POLICY_VALUES = 256;

function decodeValue(name: string, type: number, data: Buffer): RegistryValue {
  if (type === REG_SZ)
    return {
      name,
      type: 'REG_SZ',
      data: data.toString('utf16le').replace(/\0+$/, ''),
    };
  if (type === REG_MULTI_SZ) {
    const text = data.toString('utf16le').replace(/\0+$/, '');
    return {
      name,
      type: 'REG_MULTI_SZ',
      data: text === '' ? [] : text.split('\0'),
    };
  }
  if (type === REG_DWORD && data.length === 4)
    return { name, type: 'REG_DWORD', data: data.readUInt32LE(0) };
  return { name, type: 'other', typeCode: type };
}

type Koffi = typeof import('koffi');
type KoffiFunction = ReturnType<ReturnType<Koffi['load']>['func']>;

/**
 * The Win32 API through koffi, loaded on first use. A load failure throws:
 * a Station that cannot read the registry cannot tell whether a policy is
 * installed, so the caller fails closed.
 */
export function koffiWindowsSecurityApi(): WindowsSecurityApi {
  let loaded:
    | {
        koffi: Koffi;
        fn: Record<string, KoffiFunction>;
      }
    | undefined;
  const api = () => {
    if (loaded) return loaded;
    if (process.arch !== 'x64' && process.arch !== 'arm64')
      throw new Error(
        `the registry reader does not support ${process.arch} Windows`,
      );
    const koffi = createRequire(import.meta.url)('koffi') as Koffi;
    const advapi32 = koffi.load('advapi32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    const fn: Record<string, KoffiFunction> = {
      RegOpenKeyExW: advapi32.func(
        'long __stdcall RegOpenKeyExW(intptr_t hKey, const char16_t *lpSubKey, uint32_t ulOptions, uint32_t samDesired, _Out_ intptr_t *phkResult)',
      ),
      RegCloseKey: advapi32.func('long __stdcall RegCloseKey(intptr_t hKey)'),
      RegEnumValueW: advapi32.func(
        'long __stdcall RegEnumValueW(intptr_t hKey, uint32_t dwIndex, _Out_ uint8_t *lpValueName, _Inout_ uint32_t *lpcchValueName, void *lpReserved, _Out_ uint32_t *lpType, _Out_ uint8_t *lpData, _Inout_ uint32_t *lpcbData)',
      ),
      RegEnumKeyExW: advapi32.func(
        'long __stdcall RegEnumKeyExW(intptr_t hKey, uint32_t dwIndex, _Out_ uint8_t *lpName, _Inout_ uint32_t *lpcchName, void *lpReserved, void *lpClass, void *lpcchClass, void *lpftLastWriteTime)',
      ),
      RegGetKeySecurity: advapi32.func(
        'long __stdcall RegGetKeySecurity(intptr_t hKey, uint32_t SecurityInformation, _Out_ uint8_t *pSecurityDescriptor, _Inout_ uint32_t *lpcbSecurityDescriptor)',
      ),
      GetFileSecurityW: advapi32.func(
        'int __stdcall GetFileSecurityW(const char16_t *lpFileName, uint32_t RequestedInformation, _Out_ uint8_t *pSecurityDescriptor, uint32_t nLength, _Out_ uint32_t *lpnLengthNeeded)',
      ),
      ConvertSecurityDescriptorToStringSecurityDescriptorW: advapi32.func(
        'int __stdcall ConvertSecurityDescriptorToStringSecurityDescriptorW(const uint8_t *SecurityDescriptor, uint32_t RequestedStringSDRevision, uint32_t SecurityInformation, _Out_ void **StringSecurityDescriptor, _Out_ uint32_t *StringSecurityDescriptorLen)',
      ),
      LocalFree: kernel32.func('intptr_t __stdcall LocalFree(void *hMem)'),
      GetFileAttributesW: kernel32.func(
        'uint32_t __stdcall GetFileAttributesW(const char16_t *lpFileName)',
      ),
      GetLastError: kernel32.func('uint32_t __stdcall GetLastError()'),
    };
    loaded = { koffi, fn };
    return loaded;
  };

  const openKey = (subkey: string, access: number): number | undefined => {
    const { fn } = api();
    const handle = [0];
    const code = fn.RegOpenKeyExW(
      HKEY_LOCAL_MACHINE,
      subkey,
      0,
      access | KEY_WOW64_64KEY,
      handle,
    ) as number;
    if (code === ERROR_FILE_NOT_FOUND) return undefined;
    if (code !== ERROR_SUCCESS) throw new Win32Error('RegOpenKeyExW', code);
    return handle[0];
  };

  const toSddl = (descriptor: Buffer): string => {
    const { koffi, fn } = api();
    const out = [null as unknown];
    const length = [0];
    const ok = fn.ConvertSecurityDescriptorToStringSecurityDescriptorW(
      descriptor,
      SDDL_REVISION_1,
      SECURITY_INFO,
      out,
      length,
    ) as number;
    if (!ok)
      throw new Win32Error(
        'ConvertSecurityDescriptorToStringSecurityDescriptorW',
        fn.GetLastError() as number,
      );
    try {
      return koffi.decode(out[0], 'char16_t', -1) as string;
    } finally {
      fn.LocalFree(out[0]);
    }
  };

  return {
    readMachineKey(subkey, maxDataBytes) {
      const { fn } = api();
      const key = openKey(subkey, KEY_READ);
      if (key === undefined) return undefined;
      try {
        const name = Buffer.alloc(MAX_NAME_CHARS * 2);
        const values: RegistryValue[] = [];
        for (let index = 0; ; index++) {
          if (index > MAX_POLICY_VALUES)
            throw new Error(
              `the key holds more than ${MAX_POLICY_VALUES} values`,
            );
          let data = Buffer.alloc(64 * 1024);
          const chars = [MAX_NAME_CHARS];
          const type = [0];
          const bytes = [data.length];
          let code = fn.RegEnumValueW(
            key,
            index,
            name,
            chars,
            null,
            type,
            data,
            bytes,
          ) as number;
          if (code === ERROR_MORE_DATA) {
            if (bytes[0] > maxDataBytes)
              throw new Error(`a value is larger than ${maxDataBytes} bytes`);
            data = Buffer.alloc(bytes[0]);
            chars[0] = MAX_NAME_CHARS;
            bytes[0] = data.length;
            code = fn.RegEnumValueW(
              key,
              index,
              name,
              chars,
              null,
              type,
              data,
              bytes,
            ) as number;
          }
          if (code === ERROR_NO_MORE_ITEMS) break;
          if (code !== ERROR_SUCCESS)
            throw new Win32Error('RegEnumValueW', code);
          if (bytes[0] > maxDataBytes)
            throw new Error(`a value is larger than ${maxDataBytes} bytes`);
          values.push(
            decodeValue(
              name.subarray(0, chars[0] * 2).toString('utf16le'),
              type[0],
              data.subarray(0, bytes[0]),
            ),
          );
        }
        const subkeys: string[] = [];
        for (let index = 0; ; index++) {
          const chars = [MAX_NAME_CHARS];
          const code = fn.RegEnumKeyExW(
            key,
            index,
            name,
            chars,
            null,
            null,
            null,
            null,
          ) as number;
          if (code === ERROR_NO_MORE_ITEMS) break;
          if (code !== ERROR_SUCCESS)
            throw new Win32Error('RegEnumKeyExW', code);
          subkeys.push(name.subarray(0, chars[0] * 2).toString('utf16le'));
        }
        return { values, subkeys };
      } finally {
        fn.RegCloseKey(key);
      }
    },

    machineKeySddl(subkey) {
      const { fn } = api();
      const key = openKey(subkey, READ_CONTROL);
      if (key === undefined) return undefined;
      try {
        const size = [0];
        let code = fn.RegGetKeySecurity(
          key,
          SECURITY_INFO,
          null,
          size,
        ) as number;
        if (code !== ERROR_INSUFFICIENT_BUFFER)
          throw new Win32Error('RegGetKeySecurity', code);
        const descriptor = Buffer.alloc(size[0]);
        code = fn.RegGetKeySecurity(
          key,
          SECURITY_INFO,
          descriptor,
          size,
        ) as number;
        if (code !== ERROR_SUCCESS)
          throw new Win32Error('RegGetKeySecurity', code);
        return toSddl(descriptor);
      } finally {
        fn.RegCloseKey(key);
      }
    },

    pathSddl(path) {
      const { fn } = api();
      const needed = [0];
      fn.GetFileSecurityW(path, SECURITY_INFO, null, 0, needed);
      if (needed[0] === 0)
        throw new Win32Error('GetFileSecurityW', fn.GetLastError() as number);
      const descriptor = Buffer.alloc(needed[0]);
      if (
        !fn.GetFileSecurityW(
          path,
          SECURITY_INFO,
          descriptor,
          descriptor.length,
          needed,
        )
      )
        throw new Win32Error('GetFileSecurityW', fn.GetLastError() as number);
      return toSddl(descriptor);
    },

    isReparsePoint(path) {
      const { fn } = api();
      const attributes = (fn.GetFileAttributesW(path) as number) >>> 0;
      if (attributes === INVALID_FILE_ATTRIBUTES)
        throw new Win32Error('GetFileAttributesW', fn.GetLastError() as number);
      return (attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Chains
// ---------------------------------------------------------------------------

function failure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Why the file at `path` (an absolute Windows path) or a folder above it
 * could be changed by someone other than Administrators, SYSTEM or
 * TrustedInstaller, or is a reparse point; null when neither.
 */
export function windowsPathChainProblem(
  path: string,
  api: WindowsSecurityApi,
): string | null {
  const entries: Array<[string, SecuredObjectRole]> = [[path, 'file']];
  let current = win32.dirname(path);
  entries.push([current, 'policy-folder']);
  for (;;) {
    const parent = win32.dirname(current);
    if (parent === current) break;
    entries.push([parent, 'ancestor-folder']);
    current = parent;
  }
  for (const [entry, role] of entries) {
    try {
      if (api.isReparsePoint(entry))
        return `${entry} is a symbolic link, junction or other reparse point; install the policy in a real folder`;
      const problem = securityDescriptorProblem(
        entry,
        api.pathSddl(entry),
        role,
      );
      if (problem) return problem;
    } catch (error) {
      return `the permissions of ${entry} cannot be read (${failure(error)})`;
    }
  }
  return null;
}

/**
 * Why the HKLM key `subkey` or a key above it (up to `SOFTWARE`) could be
 * changed by someone other than Administrators, SYSTEM or TrustedInstaller;
 * null when not.
 */
export function windowsKeyChainProblem(
  subkey: string,
  api: WindowsSecurityApi,
): string | null {
  const entries: Array<[string, SecuredObjectRole]> = [[subkey, 'policy-key']];
  let current = subkey;
  for (;;) {
    const parent = win32.dirname(current);
    if (parent === '.' || parent === current) break;
    entries.push([parent, 'ancestor-key']);
    current = parent;
  }
  for (const [entry, role] of entries) {
    const target = `HKLM\\${entry}`;
    try {
      const sddl = api.machineKeySddl(entry);
      if (sddl === undefined)
        return `${target} disappeared while Station was reading it`;
      const problem = securityDescriptorProblem(target, sddl, role);
      if (problem) return problem;
    } catch (error) {
      return `the permissions of ${target} cannot be read (${failure(error)})`;
    }
  }
  return null;
}
