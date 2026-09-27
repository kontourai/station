import { execFileSync } from 'node:child_process';
import { createHash, type KeyObject, sign } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJson } from './release-manifest-v2.js';

const repoRoot = resolve(import.meta.dirname, '../../..');

/** The ring a version names: X.Y.Z is stable, X.Y.Z-<ring>.N that ring. */
export function ringOf(version: string): string {
  return /-([a-z]+)\.[1-9][0-9]*$/.exec(version)?.[1] ?? 'stable';
}

const RUNTIME_CHANNEL: Record<string, string> = {
  stable: 'stable',
  preview: 'beta',
  nightly: 'nightly',
};

/**
 * This host's archive target, as install.sh derives it from uname (Node's
 * process.platform and process.arch spell the same names on the POSIX hosts
 * the installer supports).
 */
export function hostTarget(): { os: string; arch: string; id: string } {
  const os = process.platform;
  const arch = process.arch;
  return { os, arch, id: `${os}-${arch}` };
}

/**
 * The fake CLI a fixture archive bundles as lib/station-cli.mjs. The real
 * bin/station.mjs imports it for every verb but --version. It appends
 * `<version root>|<argv>` to STATION_FIXTURE_CLI_LOG and models a running
 * Station with a sibling `.running` file, so a test can see which version
 * directory ran which command. The version directory itself is read-only
 * once installed, so nothing is written inside it.
 *
 * `service <status|stop|start> --instance=<id>` model one installed user
 * service per id in `<log>.service-<id>`: `{"active": true|false|null,
 * "present"?: false (the unit is gone), "sha"}`
 * (#2675 slice C). status prints the CLI's `service status --json` fields
 * install.sh reads (unit.active, instance.healthy, instance.sha); start marks
 * the unit active serving this archive's sha (or lib/service-sha's), and
 * fails, with the unit left up and unhealthy, when lib/fail-start exists.
 */
const FAKE_CLI = `import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const log = process.env.STATION_FIXTURE_CLI_LOG;
if (log) {
  appendFileSync(log, \`\${root}|\${args.join(' ')}\\n\`);
  const running = \`\${log}.running\`;
  if (args[0] === 'start') {
    if (existsSync(join(root, 'lib', 'fail-start'))) process.exit(1);
    writeFileSync(running, root);
  }
  if (args[0] === 'stop') rmSync(running, { force: true });
  if (args[0] === 'service') {
    const id = args.find((arg) => arg.startsWith('--instance='))?.slice('--instance='.length);
    const unit = \`\${log}.service-\${id}\`;
    const state = existsSync(unit) ? JSON.parse(readFileSync(unit, 'utf8')) : { active: false };
    if (args[1] === 'status') {
      const healthy = state.active === true && state.sha !== undefined;
      process.stdout.write(JSON.stringify({ healthy, unit: { active: state.active, present: state.present ?? true }, instance: { healthy, sha: state.sha } }) + '\\n');
      process.exit(healthy ? 0 : 1);
    }
    if (args[1] === 'stop') writeFileSync(unit, JSON.stringify({ active: false, present: state.present }));
    if (args[1] === 'start') {
      if (existsSync(join(root, 'lib', 'fail-start'))) {
        writeFileSync(unit, JSON.stringify({ active: true }));
        process.exit(1);
      }
      const sha = existsSync(join(root, 'lib', 'service-sha'))
        ? readFileSync(join(root, 'lib', 'service-sha'), 'utf8').trim()
        : JSON.parse(readFileSync(join(root, '.station-release.json'), 'utf8')).sha;
      writeFileSync(unit, JSON.stringify({ active: true, sha }));
    }
  }
}
`;

/**
 * A `node` that runs the Node.js executing the test, except that it refuses,
 * as some filesystems do (a macOS CI runner did, #2675 B2), to rename a
 * directory whose own write bit is clear. install.sh renames through
 * `node -e '...renameSync(process.argv[1], process.argv[2])' <from> <to>`,
 * so a rename of a sealed archive version fails here as it would there. A
 * symbolic link (the `current` swap) is not a directory being renamed.
 */
export function renameGuardedNode(): string {
  return [
    '#!/bin/sh',
    'if [ "$1" = -e ]; then',
    '  case "$2" in',
    '    *renameSync*)',
    '      if [ -d "$3" ] && [ ! -L "$3" ] && [ ! -w "$3" ]; then',
    '        echo "EACCES: permission denied, rename \'$3\' (test guard: read-only directory)" >&2',
    '        exit 1',
    '      fi',
    '      ;;',
    '  esac',
    'fi',
    `exec '${process.execPath}' "$@"`,
    '',
  ].join('\n');
}

export type PrebuiltArchive = {
  archive: string;
  name: string;
  sha256: string;
  size: number;
  version: string;
};

/**
 * A prebuilt server archive in exactly the layout
 * scripts/lib/portable-server-archive.mjs writes (a single `station/` root
 * with the marker, the provenance, the real packaging launchers, the
 * installer, a CLI bundle and runtime/bin/node), minus the megabytes: the
 * CLI is the fake above and runtime/bin/node is a wrapper that runs the Node
 * executing the test. `variant` gives the same version different bytes.
 */
export function buildPrebuiltArchive(
  dir: string,
  version: string,
  options: {
    variant?: string;
    sha?: string;
    /** Overrides for .station-release.json. */
    provenance?: Record<string, unknown>;
    /** Replaces the marker content, or removes the marker with null. */
    marker?: string | null;
    /** Overrides bin/station (a launcher that misreports, say). */
    launcher?: string;
    installScript?: string;
    /** This archive's CLI fails `start` (other versions' do not). */
    failStart?: boolean;
    /** The sha a service this archive's CLI starts reports, if not its own. */
    serviceSha?: string;
  } = {},
): PrebuiltArchive {
  const ring = ringOf(version);
  const variant = options.variant ?? '';
  const parent = join(dir, 'archive-src', `${version}${variant}`);
  const root = join(parent, 'station');
  rmSync(parent, { recursive: true, force: true });
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(root, 'lib'), { recursive: true });
  mkdirSync(join(root, 'runtime', 'bin'), { recursive: true });
  mkdirSync(join(root, 'dist-server'), { recursive: true });
  // Key order and formatting as createPackagedReleaseManifest and the
  // builder write them.
  writeFileSync(
    join(root, '.station-release.json'),
    `${JSON.stringify(
      {
        schemaVersion: 2,
        sha: options.sha ?? 'a'.repeat(40),
        ref: `v${version}`,
        createdAt: '2026-09-26T00:00:00.000Z',
        channel: RUNTIME_CHANNEL[ring],
        releaseChannel: ring,
        prerelease: ring !== 'stable',
        ...options.provenance,
      },
      null,
      2,
    )}\n`,
  );
  if (options.marker !== null)
    writeFileSync(
      join(root, '.station-prebuilt-archive'),
      options.marker ?? 'station-prebuilt-archive-v1\n',
    );
  const launcherSource = join(repoRoot, 'packaging', 'portable-server', 'bin');
  if (options.launcher)
    writeFileSync(join(root, 'bin', 'station'), options.launcher);
  else
    copyFileSync(join(launcherSource, 'station'), join(root, 'bin', 'station'));
  chmodSync(join(root, 'bin', 'station'), 0o755);
  copyFileSync(
    join(launcherSource, 'station.mjs'),
    join(root, 'bin', 'station.mjs'),
  );
  writeFileSync(join(root, 'lib', 'station-cli.mjs'), FAKE_CLI);
  if (options.failStart) writeFileSync(join(root, 'lib', 'fail-start'), '');
  if (options.serviceSha)
    writeFileSync(join(root, 'lib', 'service-sha'), options.serviceSha);
  writeFileSync(join(root, 'runtime', 'bin', 'node'), renameGuardedNode());
  chmodSync(join(root, 'runtime', 'bin', 'node'), 0o755);
  copyFileSync(
    options.installScript ?? join(repoRoot, 'install.sh'),
    join(root, 'install.sh'),
  );
  chmodSync(join(root, 'install.sh'), 0o755);
  writeFileSync(join(root, 'dist-server', 'station-build.json'), '{}\n');
  if (variant) writeFileSync(join(root, `variant-${variant}`), variant);
  const { id } = hostTarget();
  const name = `station-server-${id}.tar.gz`;
  const outDir = join(dir, 'archives', `${version}${variant}`);
  mkdirSync(outDir, { recursive: true });
  const archive = join(outDir, name);
  execFileSync('tar', ['-czf', archive, '-C', parent, 'station'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
    windowsHide: true,
  });
  const bytes = readFileSync(archive);
  return {
    archive,
    name,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: statSync(archive).size,
    version,
  };
}

/**
 * A signed schema 2 envelope for `archive`, published as this host's
 * artifact. `privateKey` stands in for a pinned key's bytes (through the
 * installer's test-only key override, or a script copy that pins it).
 */
export function signArchiveManifest(
  dir: string,
  archive: PrebuiltArchive,
  privateKey: KeyObject,
  keyId: string,
  overrides: {
    payload?: Record<string, unknown>;
    artifact?: Record<string, unknown>;
    name?: string;
  } = {},
): string {
  const { os, arch } = hostTarget();
  const payload = {
    schemaVersion: 2,
    channel: ringOf(archive.version),
    version: archive.version,
    releaseTag: `v${archive.version}`,
    sourceSha: 'a'.repeat(40),
    publishedAt: '2026-09-26T00:00:00.000Z',
    nodeVersion: process.versions.node,
    launcherProtocol: { min: 1, max: 1 },
    artifacts: [
      {
        os,
        arch,
        name: archive.name,
        url: pathToFileURL(archive.archive).href,
        sha256: archive.sha256,
        size: archive.size,
        format: 'tar.gz',
        ...overrides.artifact,
      },
    ],
    ...overrides.payload,
  };
  const path = join(
    dir,
    overrides.name ??
      `manifest-${archive.version}-${archive.sha256.slice(0, 12)}-${Math.random().toString(36).slice(2)}.json`,
  );
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 1,
      algorithm: 'ed25519',
      keyId,
      payload,
      signature: sign(
        null,
        Buffer.from(canonicalJson(payload)),
        privateKey,
      ).toString('base64'),
    }),
  );
  return path;
}
