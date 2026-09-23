import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  buildWindowsTrustCommand,
  ensureWindowsDirectoriesTrusted,
  hardenWindowsPathsTrusted,
  parseWindowsTrustResult,
  type WindowsTrustCommandRunner,
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

  // #2315: every PowerShell start is a cold start that has exceeded its
  // timeout on a loaded hosted Windows runner, so an ensure no longer spawns a
  // second process to verify. The ensure program itself must therefore read
  // every ACL back through the same assertion `verify` runs, after all
  // targets are set, before it prints the trusted result.
  test('an ensure program asserts every ACL it set before reporting trust', () => {
    const program = decodeProgram(
      buildWindowsTrustCommand('ensure', [
        { kind: 'directory', path: 'C:\\Users\\Ada\\runtime' },
      ]),
    );
    const setLoop = program.indexOf('Set-CurrentUserDacl $path $directory');
    const readback = program.indexOf(
      "Assert-CurrentUserDacl ([string]$target.path) ([string]$target.kind -eq 'directory') ([string]$target.policy -eq 'execution-safe')",
    );
    const verdict = program.indexOf(`[Console]::Out.Write('{"trusted":true}')`);
    expect(setLoop).toBeGreaterThan(0);
    expect(readback).toBeGreaterThan(setLoop);
    expect(verdict).toBeGreaterThan(readback);
    expect(
      program.slice(
        program.lastIndexOf("if ($operation -eq 'ensure')"),
        verdict,
      ),
    ).toContain('Assert-CurrentUserDacl');
  });

  describe('on Windows', () => {
    afterEach(() => vi.unstubAllGlobals());
    function onWindows() {
      vi.stubGlobal('process', { ...process, platform: 'win32' });
    }

    test('hardening directories starts exactly one ensure-and-readback process', () => {
      onWindows();
      const run = vi.fn<WindowsTrustCommandRunner>(() => ({
        status: 0,
        stdout: '{"trusted":true}',
      }));
      ensureWindowsDirectoriesTrusted(run, ['C:\\runtime']);
      expect(run.mock.calls).toEqual([
        [
          windowsSystemUtilityPath('powershell'),
          buildWindowsTrustCommand('ensure', [
            { kind: 'directory', path: 'C:\\runtime' },
          ]),
        ],
      ]);
    });

    test('hardening a file starts exactly one ensure-and-readback process', () => {
      onWindows();
      const run = vi.fn<WindowsTrustCommandRunner>(() => ({
        status: 0,
        stdout: '{"trusted":true}',
      }));
      const targets = [
        { kind: 'file' as const, path: 'C:\\runtime\\grant.tmp' },
      ];
      hardenWindowsPathsTrusted(run, targets);
      expect(run.mock.calls).toEqual([
        [
          windowsSystemUtilityPath('powershell'),
          buildWindowsTrustCommand('ensure', targets),
        ],
      ]);
    });

    test('a hardening process that does not confirm the readback fails closed', () => {
      onWindows();
      const run = vi.fn<WindowsTrustCommandRunner>(() => ({
        status: 0,
        stdout: '{"trusted":false}',
      }));
      expect(() =>
        ensureWindowsDirectoriesTrusted(run, ['C:\\runtime']),
      ).toThrow(/did not confirm/);
      const timedOut = vi.fn<WindowsTrustCommandRunner>(() => ({
        status: null,
        error: new Error('spawnSync powershell.exe ETIMEDOUT'),
      }));
      expect(() =>
        hardenWindowsPathsTrusted(timedOut, [
          { kind: 'file', path: 'C:\\runtime\\grant.tmp' },
        ]),
      ).toThrow(/ETIMEDOUT/);
    });
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
