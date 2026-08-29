import { spawnSync } from 'node:child_process';
import {
  closeSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EMBEDDED_MACHO_FIND_MAX_BUFFER = 64 * 1024 * 1024;
export const EMBEDDED_MACHO_PHASE_LABEL_MAX_LENGTH = 160;
export const EMBEDDED_MACHO_SEALING_DEADLINE_MS = 20 * 60 * 1000;

const DEVELOPER_ID_REQUIREMENT =
  '=anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists';
const MACHO_MAGICS = new Set([
  0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca,
  0xcafebabf, 0xbfbafeca,
]);

function within(parent, child) {
  const path = relative(parent, child);
  return (
    path && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
  );
}

function command(run, program, args, options = {}) {
  const result = run(program, args, {
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
  if (!result || typeof result.status !== 'number')
    throw new Error(`${program} did not return a structured exit status.`);
  return {
    ...result,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function mustSucceed(run, program, args, options) {
  const result = command(run, program, args, options);
  if (result.status !== 0)
    throw new Error(
      `${program} failed for ${args.at(-1)}: ${result.stderr || result.stdout}`,
    );
  return result;
}

function hasMachOMagic(file) {
  const descriptor = openSync(file, 'r');
  try {
    const bytes = Buffer.alloc(4);
    if (readSync(descriptor, bytes, 0, bytes.length, 0) !== bytes.length)
      return false;
    return MACHO_MAGICS.has(bytes.readUInt32BE(0));
  } finally {
    closeSync(descriptor);
  }
}

function isUnsigned(result, file, architecture, architectures = []) {
  const diagnostics = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!diagnostics.length) return false;
  const unsigned = `${file}: code object is not signed at all`;
  if (diagnostics.length === 1)
    return (
      diagnostics[0] === 'code object is not signed at all' ||
      diagnostics[0] === unsigned
    );
  if (architecture)
    return (
      diagnostics.length === 2 &&
      diagnostics[0] === unsigned &&
      diagnostics[1] === `In architecture: ${architecture}`
    );
  if (diagnostics.length % 2 !== 0) return false;
  const seenArchitectures = new Set();
  for (let index = 0; index < diagnostics.length; index += 2) {
    const reportedArchitecture = diagnostics[index + 1].replace(
      'In architecture: ',
      '',
    );
    if (
      diagnostics[index] !== unsigned ||
      diagnostics[index + 1] !== `In architecture: ${reportedArchitecture}` ||
      !architectures.includes(reportedArchitecture) ||
      seenArchitectures.has(reportedArchitecture)
    )
      return false;
    seenArchitectures.add(reportedArchitecture);
  }
  return true;
}

function metadataField(details, name) {
  return `${details.stdout}\n${details.stderr}`
    .split(/\r?\n/)
    .some(
      (line) => line.startsWith(`${name}=`) && line.length > name.length + 1,
    );
}

function machOArchitectures(run, file) {
  const architectures = mustSucceed(run, 'lipo', ['-archs', file])
    .stdout.trim()
    .split(/\s+/);
  if (
    !architectures.length ||
    architectures.some((architecture) => !/^[A-Za-z0-9_]+$/.test(architecture))
  )
    throw new Error('Embedded Mach-O reported invalid architecture names.');
  return architectures;
}

function expectedEntitlementDiagnostics(result, file) {
  return result.stderr
    .split(/\r?\n/)
    .filter(Boolean)
    .every((line) => line === `Executable=${file}`);
}

function reSign(run, file, identity, architectures) {
  for (const architecture of architectures) {
    const entitlements = command(run, 'codesign', [
      '-d',
      '--architecture',
      architecture,
      '--entitlements',
      '-',
      '--xml',
      file,
    ]);
    if (entitlements.status === 0) {
      if (
        entitlements.stdout ||
        !expectedEntitlementDiagnostics(entitlements, file)
      )
        throw new Error(
          'Refusing to re-sign embedded Mach-O with entitlements or invalid entitlement metadata.',
        );
    } else if (!isUnsigned(entitlements, file, architecture)) {
      throw new Error(
        `Could not inspect embedded Mach-O entitlements: ${entitlements.stderr || entitlements.stdout}`,
      );
    }
  }
  mustSucceed(run, 'codesign', [
    '--force',
    '--sign',
    identity,
    '--options',
    'runtime',
    '--timestamp',
    file,
  ]);
  mustSucceed(run, 'codesign', ['--verify', '--strict', '--verbose=2', file]);
}

function captured(value) {
  return typeof value === 'string'
    ? { status: 0, stdout: value, stderr: '' }
    : value;
}

async function boundedCommand(run, phase, program, args, options) {
  const result = captured(await run(phase, program, args, options));
  if (!result || typeof result.status !== 'number')
    throw new Error(`${phase} did not return a structured exit status.`);
  return {
    ...result,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

async function boundedMustSucceed(run, phase, program, args, options) {
  const result = await boundedCommand(run, phase, program, args, options);
  if (result.status !== 0) throw new Error(`${phase} failed.`);
  return result;
}

async function boundedProbe(run, phase, program, args, options) {
  return boundedCommand(run, phase, program, args, {
    ...options,
    allowNonzero: true,
  });
}

function boundedRelativeLabel(canonicalApp, canonicalFile) {
  const label = relative(canonicalApp, canonicalFile).split(sep).join('/');
  if (
    !label ||
    label === '..' ||
    label.startsWith('../') ||
    /[\u0000-\u001f\u007f]/.test(label)
  )
    throw new Error('Embedded Mach-O label escaped the staged candidate.');
  return label.length <= EMBEDDED_MACHO_PHASE_LABEL_MAX_LENGTH
    ? label
    : `${label.slice(0, EMBEDDED_MACHO_PHASE_LABEL_MAX_LENGTH - 1)}…`;
}

async function boundedMachOArchitectures(run, label, file) {
  const architectures = (
    await boundedMustSucceed(
      run,
      `embedded Mach-O ${label}: inspect architectures`,
      'lipo',
      ['-archs', file],
    )
  ).stdout
    .trim()
    .split(/\s+/);
  if (
    !architectures.length ||
    architectures.some((architecture) => !/^[A-Za-z0-9_]+$/.test(architecture))
  )
    throw new Error('Embedded Mach-O reported invalid architecture names.');
  return architectures;
}

async function boundedReSign(
  run,
  sign,
  retrySign,
  label,
  file,
  identity,
  architectures,
) {
  for (const architecture of architectures) {
    const entitlements = await boundedProbe(
      run,
      `embedded Mach-O ${label}: inspect ${architecture} entitlements`,
      'codesign',
      [
        '-d',
        '--architecture',
        architecture,
        '--entitlements',
        '-',
        '--xml',
        file,
      ],
    );
    if (entitlements.status === 0) {
      if (
        entitlements.stdout ||
        !expectedEntitlementDiagnostics(entitlements, file)
      )
        throw new Error(
          'Refusing to re-sign embedded Mach-O with entitlements or invalid entitlement metadata.',
        );
    } else if (!isUnsigned(entitlements, file, architecture)) {
      throw new Error('Could not inspect embedded Mach-O entitlements.');
    }
  }
  const phase = `embedded Mach-O ${label}: signing`;
  const args = [
    '--force',
    '--sign',
    identity,
    '--options',
    'runtime',
    '--timestamp',
    file,
  ];
  await retrySign(phase, args, () =>
    boundedMustSucceed(sign, phase, 'codesign', args),
  );
  await boundedMustSucceed(
    run,
    `embedded Mach-O ${label}: verification`,
    'codesign',
    ['--verify', '--strict', '--verbose=2', file],
  );
}

/**
 * Seal embedded code through a caller-owned bounded command runner. This is
 * deliberately separate from the synchronous CLI helper: hosted release jobs
 * must make every potentially blocking child visible and independently
 * cancellable, while local Nightly installs retain their existing interface.
 */
export async function sealEmbeddedMacosMachOBounded(
  app,
  identity,
  {
    command: run,
    sign = run,
    realpath = realpathSync,
    lstat = lstatSync,
    magic = hasMachOMagic,
    deadlineMs = EMBEDDED_MACHO_SEALING_DEADLINE_MS,
    now = Date.now,
    retrySign = (_phase, _args, operation) => operation(),
  } = {},
) {
  if (typeof run !== 'function')
    throw new Error('A bounded embedded Mach-O command runner is required.');
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0)
    throw new Error('Embedded Mach-O sealing deadline must be a positive bound.');
  const deadlineAt = now() + deadlineMs;
  const withinDeadline = (phase, program, args, options = {}) => {
    const remainingMs = deadlineAt - now();
    if (!Number.isFinite(remainingMs) || remainingMs <= 0)
      throw new Error('Embedded Mach-O sealing exceeded its aggregate deadline.');
    return run(phase, program, args, { ...options, timeoutMs: remainingMs });
  };
  const withinSignDeadline = (phase, program, args, options = {}) => {
    const remainingMs = deadlineAt - now();
    if (!Number.isFinite(remainingMs) || remainingMs <= 0)
      throw new Error('Embedded Mach-O sealing exceeded its aggregate deadline.');
    return sign(phase, program, args, { ...options, timeoutMs: remainingMs });
  };
  const root = resolve(app, 'Contents/Resources/node_modules');
  if (lstat(root).isSymbolicLink())
    throw new Error('Embedded Mach-O dependency root must not be a symlink.');
  const canonicalApp = realpath(app);
  const canonicalRoot = realpath(root);
  if (!within(canonicalApp, canonicalRoot))
    throw new Error('Embedded Mach-O dependency root escaped the staged candidate.');
  const symlinks = (
    await boundedMustSucceed(
      withinDeadline,
      'embedded Mach-O inventory symlink scan',
      'find',
      [root, '-type', 'l', '-print0'],
      { maxOutputBytes: EMBEDDED_MACHO_FIND_MAX_BUFFER },
    )
  ).stdout
    .split('\0')
    .filter(Boolean);
  if (symlinks.length)
    throw new Error('Embedded Mach-O dependency tree contains symlink(s).');
  const inventory = (
    await boundedMustSucceed(
      withinDeadline,
      'embedded Mach-O inventory file scan',
      'find',
      [root, '-type', 'f', '-print0'],
      { maxOutputBytes: EMBEDDED_MACHO_FIND_MAX_BUFFER },
    )
  ).stdout
    .split('\0')
    .filter(Boolean);
  const files = [];
  for (const file of inventory) {
    const canonicalFile = realpath(file);
    if (!within(canonicalRoot, canonicalFile))
      throw new Error('Embedded Mach-O inventory escaped the staged candidate.');
    if (/[\u0000-\u001f\u007f]/.test(canonicalFile))
      throw new Error('Embedded Mach-O path contains a control character.');
    if (!magic(canonicalFile)) continue;
    const label = boundedRelativeLabel(canonicalApp, canonicalFile);
    const kind = await boundedMustSucceed(
      withinDeadline,
      `embedded Mach-O ${label}: inventory`,
      'file',
      ['-b', canonicalFile],
    );
    if (kind.stdout.includes('Mach-O'))
      files.push({ file: canonicalFile, relativeLabel: label });
  }
  for (const [index, entry] of files.entries()) {
    const { file } = entry;
    const label = `${index + 1}/${files.length} ${entry.relativeLabel}`;
    const verified = await boundedProbe(
      withinDeadline,
      `embedded Mach-O ${label}: inspect whole signature`,
      'codesign',
      ['--verify', '--strict', '--verbose=2', file],
    );
    const architectures = await boundedMachOArchitectures(
      withinDeadline,
      label,
      file,
    );
    if (
      verified.status !== 0 &&
      !isUnsigned(verified, file, undefined, architectures)
    )
      throw new Error('Embedded Mach-O has invalid integrity.');
    const executable = (
      await boundedMustSucceed(
        withinDeadline,
        `embedded Mach-O ${label}: inspect file type`,
        'file',
        ['-b', file],
      )
    ).stdout.includes('executable');
    const signatureKinds = [];
    for (const architecture of architectures) {
      const sliceVerified = await boundedProbe(
        withinDeadline,
        `embedded Mach-O ${label}: inspect ${architecture} signature`,
        'codesign',
        [
          '--verify',
          '--strict',
          '--verbose=2',
          '--architecture',
          architecture,
          file,
        ],
      );
      const details = await boundedProbe(
        withinDeadline,
        `embedded Mach-O ${label}: inspect ${architecture} metadata`,
        'codesign',
        ['-dvv', '--architecture', architecture, file],
      );
      if (sliceVerified.status !== 0) {
        if (
          !isUnsigned(sliceVerified, file, architecture) ||
          !isUnsigned(details, file, architecture)
        )
          throw new Error(
            'Embedded Mach-O has invalid integrity in an architecture slice.',
          );
        signatureKinds.push('unsigned');
        continue;
      }
      if (details.status !== 0)
        throw new Error('Could not inspect embedded Mach-O signature metadata.');
      const developerId = await boundedProbe(
        withinDeadline,
        `embedded Mach-O ${label}: inspect ${architecture} Developer ID requirement`,
        'codesign',
        [
          '--verify',
          '--strict',
          '-R',
          DEVELOPER_ID_REQUIREMENT,
          '--architecture',
          architecture,
          file,
        ],
      );
      if (developerId.status === 0) {
        if (!metadataField(details, 'Timestamp'))
          throw new Error(
            'Embedded Mach-O Developer ID signature lacks a timestamp.',
          );
        if (
          executable &&
          !/CodeDirectory .*\(.*\bruntime\b.*\)/.test(
            `${details.stdout}\n${details.stderr}`,
          )
        )
          throw new Error(
            'Embedded Mach-O executable Developer ID signature lacks hardened runtime.',
          );
        signatureKinds.push('developer-id');
        continue;
      }
      if (
        metadataField(details, 'Signature') &&
        /(?:^|\n)Signature=adhoc(?:\n|$)/.test(
          `${details.stdout}\n${details.stderr}`,
        )
      ) {
        signatureKinds.push('adhoc');
        continue;
      }
      throw new Error('Embedded Mach-O has an unrecognized valid signature.');
    }
    if (signatureKinds.every((kind) => kind === 'developer-id')) continue;
    if (signatureKinds.some((kind) => kind === 'developer-id'))
      throw new Error(
        'Embedded Mach-O has mixed vendor and non-vendor signature classes.',
      );
    await boundedReSign(
      withinDeadline,
      withinSignDeadline,
      retrySign,
      label,
      file,
      identity,
      architectures,
    );
  }
  return files.map(({ relativeLabel }) => relativeLabel);
}

export function embeddedMacosMachOPaths(
  app,
  {
    run = spawnSync,
    realpath = realpathSync,
    lstat = lstatSync,
    magic = hasMachOMagic,
  } = {},
) {
  const root = resolve(app, 'Contents/Resources/node_modules');
  if (lstat(root).isSymbolicLink())
    throw new Error('Embedded Mach-O dependency root must not be a symlink.');
  const canonicalApp = realpath(app);
  const canonicalRoot = realpath(root);
  if (!within(canonicalApp, canonicalRoot))
    throw new Error(
      'Embedded Mach-O dependency root escaped the staged candidate.',
    );
  const symlinks = mustSucceed(run, 'find', [root, '-type', 'l', '-print0'], {
    maxBuffer: EMBEDDED_MACHO_FIND_MAX_BUFFER,
  })
    .stdout.split('\0')
    .filter(Boolean);
  if (symlinks.length)
    throw new Error('Embedded Mach-O dependency tree contains symlink(s).');
  const files = mustSucceed(run, 'find', [root, '-type', 'f', '-print0'], {
    maxBuffer: EMBEDDED_MACHO_FIND_MAX_BUFFER,
  })
    .stdout.split('\0')
    .filter(Boolean);
  return files.flatMap((file) => {
    const canonicalFile = realpath(file);
    if (!within(canonicalRoot, canonicalFile))
      throw new Error(
        'Embedded Mach-O inventory escaped the staged candidate.',
      );
    if (/[\u0000-\u001f\u007f]/.test(canonicalFile))
      throw new Error('Embedded Mach-O path contains a control character.');
    return magic(canonicalFile) &&
      mustSucceed(run, 'file', ['-b', canonicalFile], {
        maxBuffer: EMBEDDED_MACHO_FIND_MAX_BUFFER,
      }).stdout.includes('Mach-O')
      ? [canonicalFile]
      : [];
  });
}

export function sealEmbeddedMacosMachO(app, identity, options = {}) {
  const { run = spawnSync, progress } = options;
  const files = embeddedMacosMachOPaths(app, options);
  let processed = 0;
  for (const file of files) {
    // A heartbeat per file: the serial batch can legitimately run for many
    // minutes (network --timestamp per signature), and without it a slow
    // pass is indistinguishable from a hang at the caller's ceiling.
    processed += 1;
    progress?.(`[embedded sealing] ${processed}/${files.length}`);
    const verified = command(run, 'codesign', [
      '--verify',
      '--strict',
      '--verbose=2',
      file,
    ]);
    const architectures = machOArchitectures(run, file);
    if (
      verified.status !== 0 &&
      !isUnsigned(verified, file, undefined, architectures)
    )
      throw new Error(
        `Embedded Mach-O has invalid integrity: ${verified.stderr || verified.stdout}`,
      );
    const executable = mustSucceed(run, 'file', ['-b', file]).stdout.includes(
      'executable',
    );
    const signatureKinds = architectures.map((architecture) => {
      const sliceVerified = command(run, 'codesign', [
        '--verify',
        '--strict',
        '--verbose=2',
        '--architecture',
        architecture,
        file,
      ]);
      const details = command(run, 'codesign', [
        '-dvv',
        '--architecture',
        architecture,
        file,
      ]);
      if (sliceVerified.status !== 0) {
        if (
          !isUnsigned(sliceVerified, file, architecture) ||
          !isUnsigned(details, file, architecture)
        )
          throw new Error(
            'Embedded Mach-O has invalid integrity in an architecture slice.',
          );
        return 'unsigned';
      }
      if (details.status !== 0)
        throw new Error(
          'Could not inspect embedded Mach-O signature metadata.',
        );
      const developerId = command(run, 'codesign', [
        '--verify',
        '--strict',
        '-R',
        DEVELOPER_ID_REQUIREMENT,
        '--architecture',
        architecture,
        file,
      ]);
      if (developerId.status === 0) {
        if (!metadataField(details, 'Timestamp'))
          throw new Error(
            'Embedded Mach-O Developer ID signature lacks a timestamp.',
          );
        if (
          executable &&
          !/CodeDirectory .*\(.*\bruntime\b.*\)/.test(
            `${details.stdout}\n${details.stderr}`,
          )
        )
          throw new Error(
            'Embedded Mach-O executable Developer ID signature lacks hardened runtime.',
          );
        return 'developer-id';
      }
      if (
        metadataField(details, 'Signature') &&
        /(?:^|\n)Signature=adhoc(?:\n|$)/.test(
          `${details.stdout}\n${details.stderr}`,
        )
      )
        return 'adhoc';
      throw new Error('Embedded Mach-O has an unrecognized valid signature.');
    });
    if (signatureKinds.every((kind) => kind === 'developer-id')) continue;
    if (signatureKinds.some((kind) => kind === 'developer-id'))
      throw new Error(
        'Embedded Mach-O has mixed vendor and non-vendor signature classes.',
      );
    reSign(run, file, identity, architectures);
  }
  const canonicalApp = (options.realpath ?? realpathSync)(app);
  return files.map((file) => relative(canonicalApp, file));
}

function isMainModule() {
  try {
    return (
      process.argv[1] &&
      realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
    );
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const [app, identity] = process.argv.slice(2);
  if (!app || !identity)
    throw new Error('Expected <app> <Developer ID identity>.');
  process.stdout.write(
    `${JSON.stringify(
      sealEmbeddedMacosMachO(app, identity, {
        progress: (line) => process.stderr.write(`${line}\n`),
      }),
    )}\n`,
  );
}
