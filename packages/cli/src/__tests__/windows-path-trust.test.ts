import { describe, expect, test } from 'vitest';
import {
  buildWindowsTrustCommand,
  parseWindowsTrustResult,
  windowsSystemUtilityPath,
} from '../commands/windows-path-trust.js';

describe('Windows current-user path trust', () => {
  function decodeProgram(args: string[]): string {
    return Buffer.from(args[3]!, 'base64').toString('utf16le');
  }

  test('uses a fixed encoded PowerShell/.NET ACL program with a payload', () => {
    const path = 'C:\\Users\\Ada\\Station & name\\config';
    const args = buildWindowsTrustCommand('ensure', [
      { kind: 'directory', path },
    ]);
    expect(args).toHaveLength(4);
    expect(args.slice(0, 3)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
    ]);
    expect(decodeProgram(args)).toContain(
      '[Security.Principal.WindowsIdentity]',
    );
    expect(decodeProgram(args)).toContain('ReparsePoint');
    expect(decodeProgram(args)).not.toContain(path);
  });

  test('preserves inherited safe ACLs for command paths without changing them', () => {
    const args = buildWindowsTrustCommand('verify', [
      {
        kind: 'file',
        path: 'C:\\Program Files\\nodejs\\node.exe',
        policy: 'execution-safe',
      },
    ]);
    expect(args).toHaveLength(4);
    expect(decodeProgram(args)).toContain('writable by an unrelated SID');
    expect(decodeProgram(args)).toContain(
      'GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])',
    );
    expect(decodeProgram(args)).not.toContain(
      'C:\\Program Files\\nodejs\\node.exe',
    );
    const writeMask = decodeProgram(args).match(
      /^\s*\$writeMask = (?<rights>.+)$/mu,
    )?.groups?.rights;
    expect(
      [
        ...(writeMask ?? '').matchAll(/FileSystemRights\]::(?<right>\w+)/gu),
      ].map((match) => match.groups?.right),
    ).toEqual([
      'WriteData',
      'AppendData',
      'WriteExtendedAttributes',
      'WriteAttributes',
      'DeleteSubdirectoriesAndFiles',
      'Delete',
      'ChangePermissions',
      'TakeOwnership',
    ]);
  });

  test('accepts only the structured positive ACL verification result', () => {
    expect(parseWindowsTrustResult('{"trusted":true}')).toEqual({
      trusted: true,
    });
    expect(() => parseWindowsTrustResult('{"trusted":false}')).toThrow(
      /did not confirm/,
    );
    expect(() => parseWindowsTrustResult('localized text')).toThrow(/invalid/);
  });

  test('resolves every bootstrap utility to an absolute protected path', () => {
    for (const utility of [
      'cmd',
      'powershell',
      'schtasks',
      'whoami',
    ] as const) {
      const path = windowsSystemUtilityPath(utility);
      expect(path).toMatch(/^[a-z]:\\/iu);
      expect(path).toContain('\\System32\\');
      expect(path).toMatch(/\.exe$/iu);
      expect(path).not.toBe(utility);
    }
  });
});
