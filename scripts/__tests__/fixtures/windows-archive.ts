import { createHash, type KeyObject } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { crc32 } from '../../../packages/shared/src/installer/zip.js';
import { signEnvelope } from './release-manifest-v2.js';

const repoRoot = resolve(import.meta.dirname, '../../..');

export type ZipFixtureEntry = {
  name: string;
  data?: Buffer | string;
  /** Stored (0) or deflated (8, the default for files). */
  method?: number;
  /** The host that made the entry: 3 (Unix, the default) or 0 (MS-DOS). */
  madeBy?: number;
  /** Unix st_mode for a Unix-made entry (0o100644 files, 0o040755 dirs). */
  unixMode?: number;
  /** Extra low (MS-DOS) external attribute bits. */
  dosAttributes?: number;
  flags?: number;
  /** Declares this CRC-32 instead of the real one. */
  crc32?: number;
  /** Declares this uncompressed size instead of the real one. */
  size?: number;
};

/**
 * A zip in the shape bsdtar writes (local headers, central directory, end
 * record; no ZIP64 below 4 GiB), with every field a test needs to forge.
 */
export function writeZip(path: string, entries: ZipFixtureEntry[]): void {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const directory = entry.name.endsWith('/');
    const data = Buffer.from(entry.data ?? '');
    const method = entry.method ?? (directory ? 0 : 8);
    const body = method === 8 ? deflateRawSync(data) : data;
    const name = Buffer.from(entry.name, 'utf8');
    const crc = entry.crc32 ?? crc32(data);
    const size = entry.size ?? data.length;
    const flags = entry.flags ?? 0x0800;
    const madeBy = entry.madeBy ?? 3;
    const mode = entry.unixMode ?? (directory ? 0o040755 : 0o100644);
    const external =
      (madeBy === 3 ? (mode << 16) >>> 0 : 0) |
      (directory ? 0x10 : 0) |
      (entry.dosAttributes ?? 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((madeBy << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(external >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(path, Buffer.concat([...locals, directory, end]));
}

const RUNTIME_CHANNEL: Record<string, string> = {
  stable: 'stable',
  preview: 'beta',
  nightly: 'nightly',
};

export function ringOf(version: string): string {
  return /-([a-z]+)\.[1-9][0-9]*$/.exec(version)?.[1] ?? 'stable';
}

export type WindowsArchive = {
  archive: string;
  name: string;
  sha256: string;
  size: number;
  version: string;
  sha: string;
};

/**
 * The fixture archive's CLI, which bin/station.mjs (the real one) imports.
 * It records each run (its arguments, working directory and the install
 * identity it was given) in STATION_TEST_CLI_LOG, and exits 1 for the verb
 * STATION_TEST_CLI_FAIL names as `<verb>@<version>` for its own version, so
 * a test can make one release's `start` fail. Otherwise it exits 0. With
 * STATION_TEST_CLI_LINGER_MS, `start` leaves a detached process holding its
 * output open, as a started Station does.
 */
const FIXTURE_STATION_CLI = `import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const version = JSON.parse(
  readFileSync(new URL('../.station-release.json', import.meta.url), 'utf8'),
).ref.replace(/^v/, '');
if (process.env.STATION_TEST_CLI_LOG)
  appendFileSync(
    process.env.STATION_TEST_CLI_LOG,
    JSON.stringify({
      version,
      args,
      cwd: process.cwd(),
      channel: process.env.STATION_CHANNEL,
      root: process.env.STATION_ROOT,
      home: process.env.STATION_HOME,
      installRoot: process.env.STATION_INSTALL_ROOT,
    }) + '\\n',
  );
// As a real \`start\` does, leave a detached process behind; this one keeps
// the CLI's stdout and stderr open for STATION_TEST_CLI_LINGER_MS.
if (args[0] === 'start' && process.env.STATION_TEST_CLI_LINGER_MS) {
  const { spawn } = await import('node:child_process');
  spawn(
    process.execPath,
    ['-e', \`setTimeout(() => {}, \${Number(process.env.STATION_TEST_CLI_LINGER_MS)})\`],
    { detached: true, stdio: 'inherit', windowsHide: true },
  ).unref();
}
process.exit(process.env.STATION_TEST_CLI_FAIL === \`\${args[0]}@\${version}\` ? 1 : 0);
`;

/**
 * A prebuilt Windows server archive in the layout
 * scripts/lib/portable-server-archive.mjs writes (one `station/` root with the
 * marker, the provenance, the real bin/station.mjs, install.ps1 and
 * runtime/node.exe), minus the megabytes. runtime/node.exe is a Unix-mode
 * shell wrapper around the Node.js running the test, so the core's
 * `--version` self-check runs for real on a POSIX host.
 */
export function buildWindowsArchive(
  dir: string,
  version: string,
  options: {
    sha?: string;
    variant?: string;
    provenance?: Record<string, unknown>;
    marker?: string | null;
    /** Entries appended after the ordinary layout. */
    extraEntries?: ZipFixtureEntry[];
    /** Replaces the whole entry list (the layout is passed in). */
    edit?: (entries: ZipFixtureEntry[]) => ZipFixtureEntry[];
  } = {},
): WindowsArchive {
  const ring = ringOf(version);
  const sha = options.sha ?? 'a'.repeat(40);
  const provenance = `${JSON.stringify(
    {
      schemaVersion: 2,
      sha,
      ref: `v${version}`,
      createdAt: '2026-09-26T00:00:00.000Z',
      channel: RUNTIME_CHANNEL[ring],
      releaseChannel: ring,
      prerelease: ring !== 'stable',
      ...options.provenance,
    },
    null,
    2,
  )}\n`;
  const bin = join(repoRoot, 'packaging', 'portable-server', 'bin');
  let entries: ZipFixtureEntry[] = [
    { name: 'station/' },
    { name: 'station/.station-release.json', data: provenance },
    ...(options.marker === null
      ? []
      : [
          {
            name: 'station/.station-prebuilt-archive',
            data: options.marker ?? 'station-prebuilt-archive-v1\n',
          },
        ]),
    { name: 'station/bin/' },
    {
      name: 'station/bin/station.mjs',
      data: readFileSync(join(bin, 'station.mjs')),
    },
    {
      name: 'station/bin/station.cmd',
      data: readFileSync(join(bin, 'station.cmd')),
    },
    { name: 'station/lib/' },
    {
      name: 'station/lib/station-cli.mjs',
      data: FIXTURE_STATION_CLI,
    },
    { name: 'station/runtime/' },
    {
      name: 'station/runtime/node.exe',
      data: `#!/bin/sh\nexec '${process.execPath}' "$@"\n`,
      unixMode: 0o100755,
    },
    {
      name: 'station/install.ps1',
      data: readFileSync(join(repoRoot, 'install.ps1')),
    },
    ...(options.variant
      ? [{ name: `station/variant-${options.variant}`, data: options.variant }]
      : []),
    ...(options.extraEntries ?? []),
  ];
  if (options.edit) entries = options.edit(entries);
  const outDir = join(dir, 'archives', `${version}${options.variant ?? ''}`);
  mkdirSync(outDir, { recursive: true });
  const name = 'station-server-win32-x64.zip';
  const archive = join(outDir, name);
  writeZip(archive, entries);
  const bytes = readFileSync(archive);
  return {
    archive,
    name,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    version,
    sha,
  };
}

/**
 * A signed schema 2 manifest publishing `archive` as the win32-x64 artifact
 * at its file: URL; returns the manifest's file: URL.
 */
export function signWindowsManifest(
  dir: string,
  archive: WindowsArchive,
  privateKey: KeyObject,
  keyId: string,
  overrides: {
    payload?: Record<string, unknown>;
    artifact?: Record<string, unknown>;
    name?: string;
  } = {},
): string {
  const payload = {
    schemaVersion: 2,
    channel: ringOf(archive.version),
    version: archive.version,
    releaseTag: `v${archive.version}`,
    sourceSha: archive.sha,
    publishedAt: '2026-09-26T00:00:00.000Z',
    nodeVersion: process.versions.node,
    launcherProtocol: { min: 1, max: 1 },
    artifacts: [
      {
        os: 'win32',
        arch: 'x64',
        name: archive.name,
        url: pathToFileURL(archive.archive).href,
        sha256: archive.sha256,
        size: archive.size,
        format: 'zip',
        ...overrides.artifact,
      },
    ],
    ...overrides.payload,
  };
  const path = join(dir, overrides.name ?? `manifest-${archive.version}.json`);
  writeFileSync(path, JSON.stringify(signEnvelope(payload, keyId, privateKey)));
  return pathToFileURL(path).href;
}

/** install.ps1's generated installer core, decoded into `dir` as a CommonJS file. */
export function extractInstallerCore(dir: string): string {
  const script = readFileSync(join(repoRoot, 'install.ps1'), 'utf8');
  const match = /^\$StationInstallerCore = @'\n([A-Za-z0-9+/=\n]+)\n'@$/m.exec(
    script,
  );
  if (!match) throw new Error('install.ps1 has no installer core block');
  const core = join(dir, 'station-installer-core.cjs');
  writeFileSync(
    core,
    Buffer.from(match[1].replace(/\n/g, ''), 'base64').toString('utf8'),
  );
  return core;
}
