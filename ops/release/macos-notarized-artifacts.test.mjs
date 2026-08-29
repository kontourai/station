import { expect, test } from 'vitest';
import {
  admitMacosAppBundle,
  assertAcceptedNotaryReceipt,
  createMacosNotarizedArtifacts,
  outerAppDesignatedRequirement,
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
  const { calls, fs, options, run } = fixture({
    designatedRequirement,
    entitlementOutput,
  });
  await expect(
    createMacosNotarizedArtifacts(options, { fs, run }),
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
    const { calls, fs, options, run } = fixture({ designatedRequirement });
    await createMacosNotarizedArtifacts(options, { fs, run });
    expect(
      calls.some(
        ([program, args]) => program === 'xcrun' && args[1] === 'submit',
      ),
    ).toBe(true);
  }
});

test('uses a visible phase for each injected command and preserves the canonical app path', async () => {
  const { calls, fs, options, run } = fixture({
    app: 'src-desktop/target/aarch64-apple-darwin/release/bundle/macos/Station.app',
  });
  await createMacosNotarizedArtifacts(options, {
    fs,
    run,
    path: { resolve: () => '/app/Station.app' },
  });
  expect(calls).toContainEqual([
    'node',
    [
      'ops/nightly/macos-embedded-signing.mjs',
      '/app/Station.app',
      'Developer ID',
    ],
    expect.objectContaining({ phase: 'embedded sealing' }),
  ]);
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
  for (const { calls, fs, options, run } of cases) {
    await expect(
      createMacosNotarizedArtifacts(options, { fs, run }),
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
  const { calls, fs, options, run } = fixture();
  await createMacosNotarizedArtifacts(options, { fs, run });
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

test('terminates a hung release subprocess with its phase and program, never its arguments or output', async () => {
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
        phase: 'outer app signing',
        timeoutMs: 50,
        terminationGraceMs: 50,
        logger: releaseLogger,
      },
    ),
  ).rejects.toMatchObject({
    name: 'ReleaseCommandError',
    phase: 'outer app signing',
    program: process.execPath,
    timedOut: true,
  });
  const progress = releaseLogger.entries.join('\n');
  expect(progress).toContain('outer app signing');
  expect(progress).toContain('timed out');
  expect(progress).not.toContain(secret);
});

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
