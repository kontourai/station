import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  admitMacosAppBundle,
  assertAcceptedNotaryReceipt,
  createMacosNotarizedArtifacts,
  EMBEDDED_MACHO_COMMAND_TIMEOUT_MS,
  EMBEDDED_TIMESTAMP_SIGNING_TIMEOUT_MS,
  outerAppDesignatedRequirement,
  parseReleaseDeadlineEpoch,
  ReleaseCommandError,
  retryRetryableTransportFailure,
  runBoundedCommand,
} from './macos-notarized-artifacts.mjs';

const requirement =
  'identifier "io.kontourai.station" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = U7KHF2QAC4';
const currentRequirement = `Executable=/app/Station.app/Contents/MacOS/Station\ndesignated => ${requirement}`;

function fixture({
  files = ['Station.app'],
  reject = false,
  app = '/app/Station.app',
  canonicalApp = '/app/Station.app',
  appExists = true,
  appDirectory = true,
  appSymbolicLink = false,
  designatedRequirement = currentRequirement,
  entitlementOutput = {
    status: 0,
    stdout: '',
    stderr: 'Executable=/app/Station.app/Contents/MacOS/station\n',
  },
} = {}) {
  const calls = [];
  const removed = [];
  let signed = false;
  const fs = {
    existsSync: (file) =>
      (appExists && (file === app || file === canonicalApp)) ||
      file === '/key' ||
      (signed && file.endsWith('.sig')),
    lstatSync: () => ({
      isDirectory: () => appDirectory,
      isSymbolicLink: () => appSymbolicLink,
    }),
    mkdirSync() {},
    mkdtempSync: () => '/scratch',
    readdirSync: () => files,
    realpathSync: () => canonicalApp,
    rmSync: (file) => removed.push(file),
  };
  const run = (program, args, options) => {
    calls.push([program, args, options]);
    if (program === 'xcrun' && args[1] === 'submit') {
      return {
        status: 0,
        stdout: JSON.stringify({ status: reject ? 'Invalid' : 'Accepted' }),
        stderr: '',
      };
    }
    if (program === '/usr/libexec/PlistBuddy') {
      return { status: 0, stdout: 'io.kontourai.station', stderr: '' };
    }
    if (program === 'codesign' && args[0] === '-dvv') {
      return {
        status: 0,
        stdout: '',
        stderr:
          'Authority=Developer ID Application: Kontour AI LLC (U7KHF2QAC4)\nTeamIdentifier=U7KHF2QAC4\nTimestamp=now\nCodeDirectory flags=0x10000(runtime)',
      };
    }
    if (program === 'codesign' && args.includes('-r-')) {
      return typeof designatedRequirement === 'string'
        ? { status: 0, stdout: '', stderr: designatedRequirement }
        : designatedRequirement;
    }
    if (program === 'codesign' && args.includes('--entitlements')) {
      return entitlementOutput;
    }
    if (program === 'npx') signed = true;
    return '';
  };
  return {
    calls,
    embeddedMacos: {
      lstat: () => ({ isSymbolicLink: () => false }),
      magic: () => false,
      realpath: (file) => file,
    },
    fs,
    options: {
      app,
      identity: 'Developer ID',
      notaryKey: '/key',
      notaryKeyId: 'key',
      notaryIssuer: 'issuer',
      assetsDir: '/assets',
      releaseTag: 'v1.2.3',
      architecture: 'aarch64',
      bundleId: 'io.kontourai.station',
    },
    removed,
    run,
  };
}

async function rejectsBeforeSubmission({
  designatedRequirement,
  entitlementOutput,
}) {
  const { calls, embeddedMacos, fs, options, run } = fixture({
    designatedRequirement,
    entitlementOutput,
  });
  await expect(
    createMacosNotarizedArtifacts(options, { embeddedMacos, fs, run }),
  ).rejects.toThrow(/designated requirement|unexpected entitlements/i);
  expect(
    calls.some(
      ([program, args]) => program === 'xcrun' && args[1] === 'submit',
    ),
  ).toBe(false);
}

test('normalizes the current canonical and legacy designated-requirement output', () => {
  expect(outerAppDesignatedRequirement(currentRequirement)).toBe(requirement);
  expect(
    outerAppDesignatedRequirement(
      `  Designated Requirement = ${requirement}\r\n`,
    ),
  ).toBe(requirement);
});

test('accepts current, legacy, and split-stream requirements before submitting', async () => {
  for (const designatedRequirement of [
    currentRequirement,
    `Designated Requirement=${requirement}`,
    {
      status: 0,
      stdout: `designated => ${requirement}`,
      stderr: 'Executable=/app/Station.app/Contents/MacOS/Station',
    },
  ]) {
    const { calls, embeddedMacos, fs, options, run } = fixture({
      designatedRequirement,
    });
    await createMacosNotarizedArtifacts(options, { embeddedMacos, fs, run });
    expect(
      calls.some(
        ([program, args]) => program === 'xcrun' && args[1] === 'submit',
      ),
    ).toBe(true);
  }
});

test('uses a visible phase for each injected command and preserves the canonical app path', async () => {
  const { calls, embeddedMacos, fs, options, run } = fixture({
    app: 'src-desktop/target/aarch64-apple-darwin/release/bundle/macos/Station.app',
  });
  await createMacosNotarizedArtifacts(options, {
    fs,
    embeddedMacos,
    run,
    path: { resolve: () => '/app/Station.app' },
  });
  expect(calls).toContainEqual([
    'find',
    [
      '/app/Station.app/Contents/Resources/node_modules',
      '-type',
      'f',
      '-print0',
    ],
    expect.objectContaining({ phase: 'embedded Mach-O inventory file scan' }),
  ]);
  expect(calls.some(([program]) => program === 'node')).toBe(false);
  expect(calls).toContainEqual([
    'codesign',
    ['-d', '--entitlements', '-', '--xml', '/app/Station.app'],
    expect.objectContaining({ phase: 'outer app entitlements' }),
  ]);
});

test('rejects missing, non-app, symlinked, newline, and escaping app paths before signing', async () => {
  const cases = [
    fixture({ app: '/app/missing.app', appExists: false }),
    fixture({
      app: '/app/Station-not-an-app',
      canonicalApp: '/app/Station-not-an-app',
    }),
    fixture({
      app: '/app/Station.app',
      canonicalApp: '/elsewhere/Station.app',
    }),
    fixture({ app: '/app/Station.app', appSymbolicLink: true }),
    fixture({ app: '/app/Station.app\n' }),
  ];
  for (const { calls, embeddedMacos, fs, options, run } of cases) {
    await expect(
      createMacosNotarizedArtifacts(options, { embeddedMacos, fs, run }),
    ).rejects.toThrow(/staged app|application bundle|unambiguous/i);
    expect(calls).toEqual([]);
  }
  expect(() =>
    admitMacosAppBundle(
      '/app/Station.app',
      fixture({ appDirectory: false }).fs,
    ),
  ).toThrow(/application bundle/i);
});

test('fails closed on malformed, oversized, identity-weak, or duplicate designated requirements', async () => {
  const valid = `designated => ${requirement}`;
  const variants = [
    'designated => cdhash H"deadbeef"',
    currentRequirement.replace('anchor apple generic', 'anchor apple'),
    currentRequirement.replace('U7KHF2QAC4', 'NOTKONTOUR'),
    `${currentRequirement}\ndesignated => ${requirement}`,
    {
      status: 0,
      stdout: valid,
      stderr: `Designated Requirement=${requirement}`,
    },
    { status: 0, stdout: `${valid}\n${'x'.repeat(64 * 1024)}`, stderr: '' },
  ];
  for (const designatedRequirement of variants) {
    await rejectsBeforeSubmission({ designatedRequirement });
  }
});

test('fails closed on non-exact outer entitlements before submission', async () => {
  const executable = 'Executable=/app/Station.app/Contents/MacOS/station\n';
  for (const entitlementOutput of [
    { status: 0, stdout: '<plist/>', stderr: executable },
    { status: 0, stdout: '', stderr: `${executable}${executable}` },
    { status: 1, stdout: '', stderr: executable },
  ]) {
    await rejectsBeforeSubmission({ entitlementOutput });
  }
});

test('does not assess Gatekeeper until the accepted app has been stapled', async () => {
  const { calls, embeddedMacos, fs, options, run } = fixture();
  await createMacosNotarizedArtifacts(options, { embeddedMacos, fs, run });
  const submit = calls.findIndex(
    ([program, args]) =>
      program === 'xcrun' &&
      args[1] === 'submit' &&
      args.includes('/scratch/notarization-input.zip'),
  );
  const staple = calls.findIndex(
    ([program, args]) =>
      program === 'xcrun' &&
      args[1] === 'staple' &&
      args.includes('/app/Station.app'),
  );
  const assess = calls.findIndex(
    ([program, args]) =>
      program === 'spctl' &&
      args.includes('execute') &&
      args.includes('/app/Station.app'),
  );
  expect(submit).toBeLessThan(staple);
  expect(staple).toBeLessThan(assess);
});

test('cleans scratch state on terminal notary rejection and rejects an unexpected DMG root', async () => {
  const rejected = fixture({ reject: true });
  await expect(
    createMacosNotarizedArtifacts(rejected.options, rejected),
  ).rejects.toThrow(/rejected/);
  expect(rejected.removed).toContain('/scratch');
  const wrongDmg = fixture({ files: ['Contents'] });
  await expect(
    createMacosNotarizedArtifacts(wrongDmg.options, wrongDmg),
  ).rejects.toThrow(/exactly/);
});

function logger() {
  const entries = [];
  return {
    entries,
    log: (message) => entries.push(message),
    warn: (message) => entries.push(message),
    error: (message) => entries.push(message),
  };
}

test('drains a real updater-sized tar listing without retaining its path output', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'station-updater-listing-'));
  const payload = join(directory, 'payload');
  const archive = join(directory, 'updater.tar.gz');
  try {
    mkdirSync(payload);
    for (let index = 0; index < 1_500; index += 1) {
      writeFileSync(
        join(
          payload,
          `entry-${String(index).padStart(4, '0')}-${'x'.repeat(64)}`,
        ),
        '',
      );
    }
    await runBoundedCommand('tar', ['-C', payload, '-czf', archive, '.'], {
      phase: 'updater archive fixture creation',
    });
    await expect(
      runBoundedCommand('tar', ['-tzf', archive], {
        phase: 'updater archive validation',
        stdoutMode: 'discard',
      }),
    ).resolves.toMatchObject({ status: 0, stderr: '', stdout: '' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('keeps default output overflow terminal while discard retains only bounded stderr', async () => {
  const oversized = "process.stdout.write('x'.repeat(65537));";
  await expect(
    runBoundedCommand(process.execPath, ['-e', oversized], {
      maxOutputBytes: 64 * 1024,
      phase: 'default output cap',
    }),
  ).rejects.toMatchObject({
    name: 'ReleaseCommandError',
    outputTruncated: true,
  });
  await expect(
    runBoundedCommand(
      process.execPath,
      [
        '-e',
        "process.stdout.write('x'.repeat(65537)); process.stderr.write('warning');",
      ],
      {
        maxOutputBytes: 64 * 1024,
        phase: 'discarded output success',
        stdoutMode: 'discard',
      },
    ),
  ).resolves.toMatchObject({ status: 0, stderr: 'warning', stdout: '' });
  const releaseLogger = logger();
  const failure = await runBoundedCommand(
    process.execPath,
    [
      '-e',
      "process.stdout.write('x'.repeat(65537)); process.stderr.write('e'.repeat(32)); process.exit(1);",
    ],
    {
      maxOutputBytes: 8,
      phase: 'discarded output failure',
      stdoutMode: 'discard',
      logger: releaseLogger,
    },
  ).catch((error) => error);
  expect(failure).toMatchObject({
    name: 'ReleaseCommandError',
    outputTruncated: true,
    stderr: 'e'.repeat(8),
    stdout: '',
  });
  expect(releaseLogger.entries.join('\n')).not.toContain('x'.repeat(64));
  expect(releaseLogger.entries.join('\n')).not.toContain('e'.repeat(8));
  expect(() =>
    runBoundedCommand(process.execPath, ['-e', ''], {
      phase: 'invalid stdout mode',
      stdoutMode: 'truncate',
    }),
  ).toThrow(/stdout mode/);
});

test('derives, validates, then signs the updater with literal tar operands', async () => {
  const release = fixture();
  await createMacosNotarizedArtifacts(release.options, release);
  const derivation = release.calls.find(
    ([program, _args, options]) =>
      program === 'tar' && options.phase === 'updater archive derivation',
  );
  const validation = release.calls.find(
    ([program, _args, options]) =>
      program === 'tar' && options.phase === 'updater archive validation',
  );
  const signer = release.calls.find(
    ([program, _args, options]) =>
      program === 'npx' && options.phase === 'updater signature derivation',
  );
  expect(derivation[1]).toEqual([
    '-C',
    '/app',
    '-czf',
    '/assets/station-v1.2.3-macos-aarch64.app.tar.gz',
    '--',
    'Station.app',
  ]);
  expect(validation[1]).toEqual([
    '-tzf',
    '/assets/station-v1.2.3-macos-aarch64.app.tar.gz',
  ]);
  expect(validation[2]).toMatchObject({ stdoutMode: 'discard' });
  expect(release.calls.indexOf(validation)).toBeLessThan(
    release.calls.indexOf(signer),
  );
});

test('refuses corrupt or truncated updater archives before invoking the signer', async () => {
  for (const diagnostics of ['archive damaged', 'unexpected end of file']) {
    const release = fixture();
    const baseRun = release.run;
    release.run = (program, args, options) => {
      if (program === 'tar' && args[0] === '-tzf') {
        throw new ReleaseCommandError({
          phase: options.phase,
          program,
          status: 1,
          stderr: diagnostics,
        });
      }
      return baseRun(program, args, options);
    };
    await expect(
      createMacosNotarizedArtifacts(release.options, release),
    ).rejects.toBeInstanceOf(ReleaseCommandError);
    expect(
      release.calls.some(
        ([program, _args, options]) =>
          program === 'npx' && options.phase === 'updater signature derivation',
      ),
    ).toBe(false);
  }
});

test('tracks the DMG mount lifecycle without premature or duplicate cleanup', async () => {
  const beforeMount = fixture();
  const beforeMountRun = beforeMount.run;
  beforeMount.run = (program, args, options) => {
    if (options.phase === 'DMG Gatekeeper assessment')
      throw new Error('primary before mount');
    return beforeMountRun(program, args, options);
  };
  await expect(
    createMacosNotarizedArtifacts(beforeMount.options, beforeMount),
  ).rejects.toThrow('primary before mount');
  expect(
    beforeMount.calls.some(([_program, _args, options]) =>
      options.phase.includes('detach cleanup'),
    ),
  ).toBe(false);

  const success = fixture();
  await createMacosNotarizedArtifacts(success.options, success);
  expect(
    success.calls.filter(([_program, _args, options]) =>
      options.phase.includes('detach'),
    ),
  ).toHaveLength(1);
  expect(
    success.calls.find(([_program, _args, options]) =>
      options.phase.includes('detach'),
    )[2].phase,
  ).toBe('DMG detach');

  const afterMount = fixture();
  const afterMountRun = afterMount.run;
  afterMount.run = (program, args, options) => {
    if (options.phase === 'mounted app signature verification')
      throw new Error('primary after mount');
    return afterMountRun(program, args, options);
  };
  await expect(
    createMacosNotarizedArtifacts(afterMount.options, afterMount),
  ).rejects.toThrow('primary after mount');
  expect(
    afterMount.calls.filter(([_program, _args, options]) =>
      options.phase.includes('detach'),
    ),
  ).toHaveLength(1);
  expect(
    afterMount.calls.find(([_program, _args, options]) =>
      options.phase.includes('detach'),
    )[2].phase,
  ).toBe('DMG detach cleanup');
});

test('does not replace a primary mounted-artifact failure when cleanup also fails', async () => {
  const release = fixture();
  const baseRun = release.run;
  release.run = (program, args, options) => {
    if (options.phase === 'mounted app signature verification')
      throw new Error('primary mounted failure');
    if (options.phase === 'DMG detach cleanup') {
      release.calls.push([program, args, options]);
      throw new Error('cleanup failure');
    }
    return baseRun(program, args, options);
  };
  await expect(
    createMacosNotarizedArtifacts(release.options, release),
  ).rejects.toThrow('primary mounted failure');
  expect(
    release.calls.filter(([_program, _args, options]) =>
      options.phase.includes('detach'),
    ),
  ).toHaveLength(1);
  expect(release.removed).toContain('/scratch');
});

test('terminates a hung embedded signing subprocess with its phase and program, never its arguments or output', async () => {
  const releaseLogger = logger();
  const secret = 'not-a-real-notary-secret';
  await expect(
    runBoundedCommand(
      process.execPath,
      [
        '-e',
        `process.stderr.write(${JSON.stringify(secret)}); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`,
      ],
      {
        phase: 'embedded Mach-O 1/1 node_modules/vendor/a.node: signing',
        timeoutMs: 50,
        terminationGraceMs: 50,
        logger: releaseLogger,
      },
    ),
  ).rejects.toMatchObject({
    name: 'ReleaseCommandError',
    phase: 'embedded Mach-O 1/1 node_modules/vendor/a.node: signing',
    program: process.execPath,
    timedOut: true,
  });
  const progress = releaseLogger.entries.join('\n');
  expect(progress).toContain(
    'embedded Mach-O 1/1 node_modules/vendor/a.node: signing',
  );
  expect(progress).toContain('timed out');
  expect(progress).not.toContain(secret);
});

test('retries a bounded embedded timestamp signing failure once without rewrapping the full inventory', async () => {
  const release = fixture();
  const file = '/app/Station.app/Contents/Resources/node_modules/vendor/a.node';
  const baseRun = release.run;
  let embeddedSignAttempts = 0;
  release.embeddedMacos = {
    lstat: () => ({ isSymbolicLink: () => false }),
    magic: (candidate) => candidate === file,
    realpath: (candidate) => candidate,
  };
  release.run = (program, args, commandOptions) => {
    if (program === 'find' && args.includes('l'))
      return { status: 0, stdout: '', stderr: '' };
    if (program === 'find')
      return { status: 0, stdout: `${file}\0`, stderr: '' };
    if (program === 'file' && args.at(-1) === file)
      return { status: 0, stdout: 'Mach-O 64-bit bundle arm64', stderr: '' };
    if (program === 'lipo') return { status: 0, stdout: 'arm64', stderr: '' };
    if (program === 'codesign' && args[0] === '-dvv' && args.at(-1) === file)
      return { status: 0, stdout: '', stderr: 'Signature=adhoc\n' };
    if (program === 'codesign' && args.includes('-R') && args.at(-1) === file)
      return { status: 1, stdout: '', stderr: 'not Developer ID' };
    if (
      program === 'codesign' &&
      args.includes('--entitlements') &&
      args.at(-1) === file
    )
      return {
        status: 1,
        stdout: '',
        stderr: 'code object is not signed at all',
      };
    if (
      program === 'codesign' &&
      args.includes('--force') &&
      args.at(-1) === file
    ) {
      release.calls.push([program, args, commandOptions]);
      embeddedSignAttempts += 1;
      if (embeddedSignAttempts === 1)
        throw new ReleaseCommandError({
          phase: commandOptions.phase,
          program: 'codesign',
          timedOut: true,
        });
      return { status: 0, stdout: '', stderr: '' };
    }
    return baseRun(program, args, commandOptions);
  };
  await expect(
    createMacosNotarizedArtifacts(release.options, release),
  ).resolves.toBeDefined();
  expect(embeddedSignAttempts).toBe(2);
  expect(
    release.calls.find(
      ([program, args]) =>
        program === 'codesign' &&
        args[0] === '--verify' &&
        args.includes('--architecture') &&
        args.at(-1) === file,
    )?.[2].timeoutMs,
  ).toBe(EMBEDDED_MACHO_COMMAND_TIMEOUT_MS);
  expect(
    release.calls.find(
      ([program, args]) =>
        program === 'codesign' &&
        args.includes('--force') &&
        args.at(-1) === file,
    )?.[2].timeoutMs,
  ).toBe(EMBEDDED_TIMESTAMP_SIGNING_TIMEOUT_MS);
  expect(
    release.calls.some(
      ([program, args]) =>
        program === 'node' && args.includes('macos-embedded-signing.mjs'),
    ),
  ).toBe(false);
});

test('validates absolute release epochs and reserves process-group cleanup grace after delayed setup', async () => {
  expect(parseReleaseDeadlineEpoch('1700006300')).toBe(1_700_006_300_000);
  expect(() => parseReleaseDeadlineEpoch('not-an-epoch')).toThrow(
    /Unix timestamp/,
  );
  const release = fixture();
  const deadlineAt = 1_700_006_300_000;
  let now = deadlineAt - 25_000;
  const baseRun = release.run;
  release.run = (program, args, commandOptions) => {
    now = deadlineAt - 9_000;
    return baseRun(program, args, commandOptions);
  };
  await expect(
    createMacosNotarizedArtifacts(
      { ...release.options, deadlineEpoch: '1700006300' },
      {
        ...release,
        embeddedMacos: { ...release.embeddedMacos, now: () => now },
        now: () => now,
      },
    ),
  ).rejects.toThrow(/deadline/);
  expect(release.calls).toHaveLength(1);
  expect(release.calls[0][2].timeoutMs).toBe(15_000);

  const expired = fixture();
  await expect(
    createMacosNotarizedArtifacts(
      { ...expired.options, deadlineEpoch: '1700006300' },
      { ...expired, now: () => deadlineAt - 10_000 },
    ),
  ).rejects.toThrow(/cleanup grace/);
  expect(expired.calls).toEqual([]);
});

test.skipIf(process.platform === 'win32')(
  'kills a TERM-ignoring descendant after its leader closes before retry can proceed',
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'station-notary-descendant-'));
    const ready = join(directory, 'ready');
    const survived = join(directory, 'survived');
    const descendant = `
    const fs = require('node:fs');
    const [ready, survived] = process.argv.slice(1);
    process.on('SIGTERM', () => {
      setTimeout(() => fs.writeFileSync(survived, 'still alive'), 150);
    });
    fs.writeFileSync(ready, 'ready');
    setInterval(() => {}, 1000);
  `;
    const leader = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}, ${JSON.stringify(ready)}, ${JSON.stringify(survived)}], { stdio: 'ignore' });
    process.on('SIGTERM', () => process.exit(0));
    setInterval(() => {}, 1000);
  `;
    try {
      await expect(
        runBoundedCommand(process.execPath, ['-e', leader], {
          phase: 'application notarization',
          timeoutMs: 400,
          terminationGraceMs: 50,
          logger: logger(),
        }),
      ).rejects.toMatchObject({ timedOut: true });
      expect(existsSync(ready)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 225));
      expect(existsSync(survived)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'retains ownership when a leader exits before timeout but its descendant ignores TERM',
  async () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'station-notary-pretimeout-descendant-'),
    );
    const ready = join(directory, 'ready');
    const survived = join(directory, 'survived');
    const descendant = `
      const fs = require('node:fs');
      const [ready, survived] = process.argv.slice(1);
      process.on('SIGTERM', () => {
        setTimeout(() => fs.writeFileSync(survived, 'still alive'), 150);
      });
      fs.writeFileSync(ready, 'ready');
      setInterval(() => {}, 1000);
    `;
    const leader = `
      const { spawn } = require('node:child_process');
      spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}, ${JSON.stringify(ready)}, ${JSON.stringify(survived)}], { stdio: 'inherit' });
      setTimeout(() => process.exit(0), 50);
    `;
    try {
      await expect(
        runBoundedCommand(process.execPath, ['-e', leader], {
          phase: 'DMG notarization',
          timeoutMs: 400,
          terminationGraceMs: 50,
          logger: logger(),
        }),
      ).rejects.toMatchObject({ timedOut: true });
      expect(existsSync(ready)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 225));
      expect(existsSync(survived)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test('retries exactly once for timestamp transport failures and never for identity failures', async () => {
  const releaseLogger = logger();
  const args = ['--force', '--timestamp', '/tmp/Station.app'];
  const transportFailure = new ReleaseCommandError({
    phase: 'outer app signing',
    program: 'codesign',
    status: 1,
    stderr: 'The timestamp service is temporarily unavailable.',
  });
  let attempts = 0;
  await expect(
    retryRetryableTransportFailure(
      'outer app signing',
      args,
      () => {
        attempts += 1;
        if (attempts === 1) throw transportFailure;
        return 'signed';
      },
      releaseLogger,
    ),
  ).resolves.toBe('signed');
  expect(attempts).toBe(2);
  const identityFailure = new ReleaseCommandError({
    phase: 'outer app signing',
    program: 'codesign',
    status: 1,
    stderr: 'errSecInternalComponent',
  });
  attempts = 0;
  await expect(
    retryRetryableTransportFailure(
      'outer app signing',
      args,
      () => {
        attempts += 1;
        throw identityFailure;
      },
      releaseLogger,
    ),
  ).rejects.toBe(identityFailure);
  expect(attempts).toBe(1);
});

test('keeps notary rejection terminal and fail-closed', () => {
  expect(() =>
    assertAcceptedNotaryReceipt(
      JSON.stringify({ status: 'Invalid', id: 'notary-request-id' }),
      '/tmp/Station.app.zip',
    ),
  ).toThrow('notarytool rejected Station.app.zip.');
  expect(() => assertAcceptedNotaryReceipt('{', '/tmp/Station.dmg')).toThrow(
    'notarytool did not return JSON.',
  );
});
