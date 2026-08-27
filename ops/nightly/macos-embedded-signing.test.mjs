import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  embeddedMacosMachOPaths,
  sealEmbeddedMacosMachO,
} from './macos-embedded-signing.mjs';

const validAdhocDetails = {
  status: 0,
  stdout: '',
  stderr: 'Signature=adhoc\n',
};
const unsigned = {
  status: 1,
  stdout: '',
  stderr: 'code object is not signed at all',
};
const ok = { status: 0, stdout: '', stderr: '' };
const result = (stdout) => ({ ...ok, stdout });

function fixture({
  details = validAdhocDetails,
  verify = ok,
  entitlement = unsigned,
  sliceUnsigned = unsigned,
} = {}) {
  const calls = [];
  let signed = false;
  const run = (program, args, options) => {
    calls.push([program, args, options]);
    if (program === 'find' && args.includes('l')) return result('');
    if (program === 'find')
      return result(
        '/app/Contents/Resources/node_modules/a.node\0/app/Contents/Resources/node_modules/windows.node\0',
      );
    if (program === 'file')
      return result(
        args[1].endsWith('a.node')
          ? 'Mach-O 64-bit bundle arm64'
          : 'PE32 executable',
      );
    if (program === 'lipo') return result('arm64');
    if (program === 'codesign' && args[0] === '-dvv')
      return verify.status !== 0 ? sliceUnsigned : details;
    if (program === 'codesign' && args.includes('--entitlements'))
      return entitlement;
    if (program === 'codesign' && args.includes('--force')) {
      signed = true;
      return ok;
    }
    if (program === 'codesign' && args.includes('-R'))
      return /Developer ID/.test(`${details.stdout}\n${details.stderr}`)
        ? ok
        : { status: 1, stdout: '', stderr: 'not Developer ID' };
    if (program === 'codesign' && signed) return ok;
    if (
      program === 'codesign' &&
      args[0] === '--verify' &&
      args.includes('--architecture') &&
      verify.status !== 0
    )
      return sliceUnsigned;
    if (
      program === 'codesign' &&
      args[0] === '--verify' &&
      !args.includes('-R')
    )
      return verify;
    return ok;
  };
  return { calls, run };
}

const options = (run, extra = {}) => ({
  run,
  realpath: (path) => path,
  lstat: () => ({ isSymbolicLink: () => false }),
  magic: (path) => path.endsWith('a.node'),
  ...extra,
});

test('pre-filters by Mach-O magic, then confirms only candidates with file', () => {
  const { calls, run } = fixture();
  expect(sealEmbeddedMacosMachO('/app', 'Developer ID', options(run))).toEqual([
    'Contents/Resources/node_modules/a.node',
  ]);
  expect(calls.filter(([program]) => program === 'file')).toHaveLength(2);
  expect(calls.find(([program]) => program === 'find')[2].maxBuffer).toBe(
    64 * 1024 * 1024,
  );
  expect(
    calls.some(
      ([program, args]) => program === 'codesign' && args.includes('--force'),
    ),
  ).toBe(true);
});

test('preserves valid timestamped Developer ID metadata emitted on stderr byte-for-byte', () => {
  const developerMetadata =
    'Authority=Developer ID Application: Anthropic, PBC (Q6L2SF6YDW)\nTimestamp=Aug 5\nRuntime Version=13.0.0\n';
  const { calls, run } = fixture({
    details: { status: 0, stdout: '', stderr: developerMetadata },
  });
  sealEmbeddedMacosMachO('/app', 'Developer ID', options(run));
  expect(
    calls.some(
      ([program, args]) => program === 'codesign' && args.includes('--force'),
    ),
  ).toBe(false);
  expect(
    calls.find(
      ([program, args]) => program === 'codesign' && args[0] === '-dvv',
    ),
  ).toEqual([
    'codesign',
    [
      '-dvv',
      '--architecture',
      'arm64',
      '/app/Contents/Resources/node_modules/a.node',
    ],
    expect.anything(),
  ]);
  expect(
    calls.some(
      ([program, args]) =>
        program === 'codesign' &&
        args.includes('-R') &&
        args[args.indexOf('-R') + 1].startsWith('=anchor apple generic'),
    ),
  ).toBe(true);
});

test('re-signs valid ad-hoc code only after rejecting nonempty entitlements', () => {
  const { calls, run } = fixture({
    entitlement: {
      status: 0,
      stdout: '',
      stderr: '<plist><key>com.apple.security.cs.allow-jit</key></plist>',
    },
  });
  expect(() =>
    sealEmbeddedMacosMachO('/app', 'Developer ID', options(run)),
  ).toThrow(/entitlements/);
  expect(
    calls.some(
      ([program, args]) => program === 'codesign' && args.includes('--force'),
    ),
  ).toBe(false);
});

test('accepts unsigned code despite the expected entitlement-display failure and signs it', () => {
  const { calls, run } = fixture({ verify: unsigned, entitlement: unsigned });
  sealEmbeddedMacosMachO('/app', 'Developer ID', options(run));
  expect(
    calls.some(
      ([program, args]) => program === 'codesign' && args.includes('--force'),
    ),
  ).toBe(true);
});

test('accepts only a lipo-confirmed architecture line with an unsigned whole-file diagnostic', () => {
  const file = '/app/Contents/Resources/node_modules/a.node';
  const { calls, run } = fixture({
    verify: {
      status: 1,
      stdout: '',
      stderr: `${file}: code object is not signed at all\nIn architecture: arm64\n`,
    },
    entitlement: unsigned,
    sliceUnsigned: {
      status: 1,
      stdout: '',
      stderr: `${file}: code object is not signed at all\nIn architecture: arm64\n`,
    },
  });
  sealEmbeddedMacosMachO('/app', 'Developer ID', options(run));
  expect(
    calls.some(
      ([program, args]) => program === 'codesign' && args.includes('--force'),
    ),
  ).toBe(true);

  const unknownArchitecture = fixture({
    verify: {
      status: 1,
      stdout: '',
      stderr: `${file}: code object is not signed at all\nIn architecture: not-a-real-slice\n`,
    },
  });
  expect(() =>
    sealEmbeddedMacosMachO(
      '/app',
      'Developer ID',
      options(unknownArchitecture.run),
    ),
  ).toThrow(/invalid integrity/);
});

test('refuses unsigned diagnostics that contain entitlement payload or another error', () => {
  const { calls, run } = fixture({
    verify: unsigned,
    entitlement: {
      status: 1,
      stdout: '<plist><dict><key>unexpected</key></dict></plist>',
      stderr: 'code object is not signed at all\ninvalid entitlement data',
    },
  });
  expect(() =>
    sealEmbeddedMacosMachO('/app', 'Developer ID', options(run)),
  ).toThrow(/Could not inspect/);
  expect(
    calls.some(
      ([program, args]) => program === 'codesign' && args.includes('--force'),
    ),
  ).toBe(false);
});

test('refuses an unexplained whole-file verification failure before any signing', () => {
  const { calls, run } = fixture({
    verify: { status: 1, stdout: '', stderr: '' },
  });
  expect(() =>
    sealEmbeddedMacosMachO('/app', 'Developer ID', options(run)),
  ).toThrow(/invalid integrity/);
  expect(
    calls.some(
      ([program, args]) => program === 'codesign' && args.includes('--force'),
    ),
  ).toBe(false);
});

test('accepts the documented empty-entitlement stderr diagnostic before signing ad-hoc code', () => {
  const { calls, run } = fixture({
    entitlement: {
      status: 0,
      stdout: '',
      stderr: 'Executable=/app/Contents/Resources/node_modules/a.node\n',
    },
  });
  sealEmbeddedMacosMachO('/app', 'Developer ID', options(run));
  expect(
    calls.some(
      ([program, args]) => program === 'codesign' && args.includes('--force'),
    ),
  ).toBe(true);
});

test('requires a timestamp and hardened runtime for every preserved Developer ID executable slice', () => {
  const details = {
    status: 0,
    stdout: '',
    stderr:
      'Timestamp=Aug 5\nCodeDirectory flags=0x10000(runtime)\nAuthority=Developer ID Application: Vendor\n',
  };
  const { run: baseRun } = fixture({ details });
  const run = (program, args, commandOptions) => {
    if (program === 'file' && args[1].endsWith('a.node'))
      return result('Mach-O 64-bit executable arm64');
    if (program === 'lipo') return result('x86_64 arm64');
    if (program === 'codesign' && args[0] === '-dvv' && args.includes('arm64'))
      return {
        ...details,
        stderr:
          'CodeDirectory flags=0x10000(runtime)\nAuthority=Developer ID Application: Vendor\n',
      };
    return baseRun(program, args, commandOptions);
  };
  expect(() =>
    sealEmbeddedMacosMachO('/app', 'Developer ID', options(run)),
  ).toThrow(/lacks a timestamp/);
});

test('requires hardened runtime for preserved Developer ID executables but not bundles', () => {
  const details = {
    status: 0,
    stdout: '',
    stderr: 'Timestamp=Aug 5\nAuthority=Developer ID Application: Vendor\n',
  };
  const { run: baseRun } = fixture({ details });
  const executableRun = (program, args, commandOptions) => {
    if (program === 'file' && args[1].endsWith('a.node'))
      return result('Mach-O 64-bit executable arm64');
    return baseRun(program, args, commandOptions);
  };
  expect(() =>
    sealEmbeddedMacosMachO('/app', 'Developer ID', options(executableRun)),
  ).toThrow(/hardened runtime/);
  expect(() =>
    sealEmbeddedMacosMachO('/app', 'Developer ID', options(baseRun)),
  ).not.toThrow();
});

test('re-signs a universal file with only unsigned and ad-hoc slices after entitlement inspection', () => {
  const file = '/app/Contents/Resources/node_modules/a.node';
  const unsignedSlice = {
    status: 1,
    stdout: '',
    stderr: `${file}: code object is not signed at all\n`,
  };
  const adhocSlice = { status: 0, stdout: '', stderr: 'Signature=adhoc\n' };
  const calls = [];
  let signed = false;
  const run = (program, args, commandOptions) => {
    calls.push([program, args, commandOptions]);
    if (program === 'find' && args.includes('l')) return result('');
    if (program === 'find') return result(`${file}\0`);
    if (program === 'file') return result('Mach-O universal binary');
    if (program === 'lipo') return result('x86_64 arm64');
    if (program !== 'codesign') return ok;
    const architecture = args[args.indexOf('--architecture') + 1];
    if (args.includes('--force')) {
      signed = true;
      return ok;
    }
    if (signed) return ok;
    if (args.includes('-R'))
      return { status: 1, stdout: '', stderr: 'not Developer ID' };
    if (args[0] === '--verify' && !args.includes('--architecture'))
      return {
        status: 1,
        stdout: '',
        stderr: `${file}: code object is not signed at all\nIn architecture: x86_64\n`,
      };
    if (args[0] === '--verify' && args.includes('--architecture'))
      return architecture === 'x86_64' ? unsignedSlice : ok;
    if (args[0] === '-dvv')
      return architecture === 'x86_64' ? unsignedSlice : adhocSlice;
    if (args.includes('--entitlements'))
      return architecture === 'x86_64'
        ? unsignedSlice
        : { status: 0, stdout: '', stderr: `Executable=${file}\n` };
    return ok;
  };
  sealEmbeddedMacosMachO('/app', 'Developer ID', options(run));
  expect(
    calls.some(
      ([program, args]) => program === 'codesign' && args.includes('--force'),
    ),
  ).toBe(true);
});

test('refuses a Developer ID slice mixed with unsigned or ad-hoc slices', () => {
  const file = '/app/Contents/Resources/node_modules/a.node';
  const unsignedSlice = {
    status: 1,
    stdout: '',
    stderr: `${file}: code object is not signed at all\n`,
  };
  const developerDetails = {
    status: 0,
    stdout: '',
    stderr: 'Timestamp=Aug 5\nCodeDirectory flags=0x10000(runtime)\n',
  };
  const { run: baseRun } = fixture({
    verify: {
      status: 1,
      stdout: '',
      stderr: `${file}: code object is not signed at all\nIn architecture: x86_64\n`,
    },
    sliceUnsigned: unsignedSlice,
  });
  const run = (program, args, commandOptions) => {
    if (program === 'lipo') return result('x86_64 arm64');
    if (
      program === 'codesign' &&
      args[0] === '--verify' &&
      args.includes('--architecture') &&
      args.includes('arm64')
    )
      return ok;
    if (program === 'codesign' && args[0] === '-dvv' && args.includes('arm64'))
      return developerDetails;
    if (program === 'codesign' && args.includes('-R') && args.includes('arm64'))
      return ok;
    return baseRun(program, args, commandOptions);
  };
  expect(() =>
    sealEmbeddedMacosMachO('/app', 'Developer ID', options(run)),
  ).toThrow(/mixed vendor/);
});

test('fails closed on invalid integrity and unrecognized valid signatures', () => {
  const invalid = fixture({
    verify: {
      status: 1,
      stdout: '',
      stderr: 'a sealed resource is missing or invalid',
    },
  });
  expect(() =>
    sealEmbeddedMacosMachO('/app', 'Developer ID', options(invalid.run)),
  ).toThrow(/invalid integrity/);
  const other = fixture({
    details: {
      status: 0,
      stdout: '',
      stderr: 'Authority=Apple Development: Other\n',
    },
  });
  expect(() =>
    sealEmbeddedMacosMachO('/app', 'Developer ID', options(other.run)),
  ).toThrow(/unrecognized valid signature/);
});

test('does not mistake an invalid binary filename for an unsigned diagnostic', () => {
  const { calls, run } = fixture({
    verify: {
      status: 1,
      stdout: '',
      stderr:
        '/app/Contents/Resources/node_modules/code object is not signed at all.node: code or signature modified',
    },
  });
  expect(() =>
    sealEmbeddedMacosMachO('/app', 'Developer ID', options(run)),
  ).toThrow(/invalid integrity/);
  expect(
    calls.some(
      ([program, args]) => program === 'codesign' && args.includes('--force'),
    ),
  ).toBe(false);
});

test('includes FAT64 Mach-O containers in the authoritative file inventory', () => {
  const root = mkdtempSync(join(tmpdir(), 'station-4413-fat64-'));
  const deps = join(root, 'Contents/Resources/node_modules');
  const binary = join(deps, 'fat64.node');
  mkdirSync(deps, { recursive: true });
  writeFileSync(binary, Buffer.from([0xca, 0xfe, 0xba, 0xbf]));
  const files = embeddedMacosMachOPaths(root, {
    run: (program, args) => {
      if (program === 'find' && args.includes('l')) return result('');
      if (program === 'find') return result(`${binary}\0`);
      if (program === 'file') return result('Mach-O universal binary');
      return ok;
    },
  });
  expect(files).toEqual([realpathSync(binary)]);
});

test('returns canonical candidate paths when discovery starts through an aliased parent', () => {
  const app = '/tmp/station-alias/Station Nightly.app';
  const original = `${app}/Contents/Resources/node_modules/vendor/a.node`;
  const canonical = original.replace('/tmp/', '/private/tmp/');
  const paths = embeddedMacosMachOPaths(app, {
    run: (program, args) => {
      if (program === 'find' && args.includes('l')) return result('');
      if (program === 'find') return result(`${original}\0`);
      if (program === 'file') return result('Mach-O 64-bit bundle arm64');
      return ok;
    },
    realpath: (path) => path.replace('/tmp/', '/private/tmp/'),
    lstat: () => ({ isSymbolicLink: () => false }),
    magic: () => true,
  });
  expect(paths).toEqual([canonical]);
});

test('refuses root and canonical file escapes before any codesign call', () => {
  const root = mkdtempSync(join(tmpdir(), 'station-4413-root-link-'));
  const outside = mkdtempSync(join(tmpdir(), 'station-4413-outside-'));
  mkdirSync(join(root, 'Contents/Resources'), { recursive: true });
  symlinkSync(outside, join(root, 'Contents/Resources/node_modules'));
  expect(() => sealEmbeddedMacosMachO(root, 'Developer ID')).toThrow(
    /root must not be a symlink/,
  );

  const { calls, run } = fixture();
  expect(() =>
    sealEmbeddedMacosMachO(
      '/app',
      'Developer ID',
      options(run, {
        realpath: (path) =>
          path.endsWith('a.node') ? '/outside/a.node' : path,
      }),
    ),
  ).toThrow(/inventory escaped/);
  expect(calls.some(([program]) => program === 'codesign')).toBe(false);
});

test('stops immediately when the supplied signing identity fails', () => {
  const { run: baseRun } = fixture();
  let signAttempts = 0;
  const run = (program, args, commandOptions) => {
    if (program === 'codesign' && args.includes('--force')) {
      signAttempts += 1;
      return { status: 1, stdout: '', stderr: 'identity unavailable' };
    }
    return baseRun(program, args, commandOptions);
  };
  expect(() =>
    sealEmbeddedMacosMachO('/app', 'Developer ID', options(run)),
  ).toThrow(/identity unavailable/);
  expect(signAttempts).toBe(1);
});

test('refuses real dependency symlink trees before codesign', () => {
  const root = mkdtempSync(join(tmpdir(), 'station-4413-symlink-'));
  const deps = join(root, 'Contents/Resources/node_modules');
  mkdirSync(deps, { recursive: true });
  symlinkSync(process.execPath, join(deps, 'outside.node'));
  const calls = [];
  const run = (program, args, commandOptions) => {
    if (program === 'codesign') calls.push([program, args]);
    return spawnSync(program, args, commandOptions);
  };
  expect(() => sealEmbeddedMacosMachO(root, 'Developer ID', { run })).toThrow(
    /contains symlink/,
  );
  expect(calls).toEqual([]);
});

test('CLI main guard works through a /tmp symlink and app path containing spaces', () => {
  const root = mkdtempSync(join(tmpdir(), 'station 4413 app '));
  mkdirSync(join(root, 'Contents/Resources/node_modules'), { recursive: true });
  const source = new URL('./macos-embedded-signing.mjs', import.meta.url);
  const link = join(root, 'macos-embedded-signing-link.mjs');
  symlinkSync(source, link);
  const output = execFileSync(process.execPath, [link, root, 'Developer ID'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  expect(output.trim()).toBe('[]');
});
