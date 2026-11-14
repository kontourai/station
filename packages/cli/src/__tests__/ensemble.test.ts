import { createHash } from 'node:crypto';
import {
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  ENSEMBLE_MAX_BYTES,
  type EnsemblePreset,
} from '@kontourai/station-contracts/ensemble';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';
import { runCli } from '../cli.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

const PRESET: EnsemblePreset = {
  version: 'station.ensemble/v1',
  id: 'review-team',
  name: 'Review café',
  stationmaster: 'coordinator',
  members: [
    {
      id: 'coordinator',
      codename: 'Cedar',
      color: '#Aa7744',
      role: 'Coordinate review',
      engine: 'codex',
      model: 'gpt-6.1-sol',
      reasoning: { option: 'reasoningEffort', value: 'max' },
      options: { serviceTier: 'priority', temperature: 0.25 },
      promptAppends: [' Preserve this authored text.\n'],
    },
    {
      id: 'reviewer',
      codename: 'Birch',
      color: '#445566',
      role: 'Review the implementation',
      engine: 'claude',
      model: 'claude-opus',
      reasoning: { option: 'effort', value: 'max' },
      options: { fastMode: true, thinking: false },
      promptAppends: [],
    },
  ],
};

const makeTempDir = trackTempDirs();
let directory: string;
let originalExitCode: typeof process.exitCode;

beforeEach(async () => {
  const actual =
    await vi.importActual<typeof import('node:fs/promises')>(
      'node:fs/promises',
    );
  vi.mocked(open).mockReset().mockImplementation(actual.open);
  directory = realpathSync(makeTempDir('station-ensemble-cli-'));
  originalExitCode = process.exitCode;
  process.exitCode = undefined;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  process.exitCode = originalExitCode;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function writePreset(
  bytes: string | Uint8Array = JSON.stringify(PRESET),
): string {
  const path = join(directory, 'team.json');
  writeFileSync(path, bytes);
  return path;
}

function stdout(): string {
  return vi
    .mocked(console.log)
    .mock.calls.map((call) => call.join(' '))
    .join('\n');
}

function stderr(): string {
  return vi
    .mocked(console.error)
    .mock.calls.map((call) => call.join(' '))
    .join('\n');
}

describe('station ensemble inspect through the registered CLI', () => {
  test('inspects exact UTF-8 bytes as JSON in the packaged CLI without a host or credential store', async () => {
    const bytes = Buffer.from(`\n${JSON.stringify(PRESET, null, 2)}\n`, 'utf8');
    const path = writePreset(bytes);
    const configureProfileCredentialStore = vi.fn(() => {
      throw new Error('inspection must not open the keyring');
    });
    const fetch = vi.fn(() => {
      throw new Error('inspection must not call a Station');
    });
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('__STATION_CLI_BUNDLE__', {
      version: '0.10.0',
      sourceSha: 'a'.repeat(40),
      channel: 'development',
    });
    vi.stubEnv('STATION_REQUEST_TIMEOUT_MS', 'invalid-for-a-host-request');

    await runCli(['ensemble', 'inspect', path, '--json'], {
      configureProfileCredentialStore,
    });

    const result = JSON.parse(stdout());
    expect(result).toEqual({
      kind: 'station.ensemble.inspection',
      version: 1,
      path,
      bytes: bytes.length,
      sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      preset: PRESET,
      roster: expect.any(String),
    });
    const roster = result.roster.split('\n');
    expect(roster[0]).toBe('Ensemble "Review café" (review-team)');
    expect(roster[1]).toContain('grant no permissions');
    expect(roster.slice(2).map((line: string) => JSON.parse(line))).toEqual([
      {
        id: 'coordinator',
        codename: 'Cedar',
        color: '#Aa7744',
        role: 'Coordinate review',
        engine: 'codex',
        model: 'gpt-6.1-sol',
        reasoning: { option: 'reasoningEffort', value: 'max' },
        stationmaster: true,
      },
      {
        id: 'reviewer',
        codename: 'Birch',
        color: '#445566',
        role: 'Review the implementation',
        engine: 'claude',
        model: 'claude-opus',
        reasoning: { option: 'effort', value: 'max' },
        stationmaster: false,
      },
    ]);
    expect(readFileSync(path)).toEqual(bytes);
    expect(configureProfileCredentialStore).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(stderr()).toBe('');
    expect(process.exitCode).toBeUndefined();
  });

  test('renders terminal-safe authored labels and options while JSON preserves their text', async () => {
    const preset: EnsemblePreset = {
      ...PRESET,
      name: 'Review\u001b[2J\u202e\nforged',
      members: PRESET.members.map((member) => ({
        ...member,
        role: 'Review\u009b\u2028\nrole',
        model: 'model\u202e',
      })),
    };
    const path = writePreset(JSON.stringify(preset));
    await runCli(['ensemble', 'inspect', relative(process.cwd(), path)]);
    const text = stdout();
    expect(text).toContain('Version: station.ensemble/v1');
    expect(text).toContain('Digest: sha256:');
    expect(text).toContain('Inspection only; no members launched.');
    expect(text).toContain('"stationmaster":true');
    expect(text).toContain('Cedar options:');
    expect(text).toContain('"serviceTier": "priority"');
    expect(text).toContain('"fastMode": true');
    for (const character of ['\u001b', '\u009b', '\u202e', '\u2028'])
      expect(text).not.toContain(character);
    vi.mocked(console.log).mockClear();
    await runCli(['ensemble', 'inspect', '--json', path]);
    expect(JSON.parse(stdout()).preset).toEqual(preset);
    for (const character of ['\u001b', '\u009b', '\u202e', '\u2028'])
      expect(stdout()).not.toContain(character);
    expect(process.exitCode).toBeUndefined();
  });

  test('accepts the exact byte limit and changes the digest for formatting alone', async () => {
    const json = JSON.stringify(PRESET);
    const bytes = Buffer.concat([
      Buffer.from(json),
      Buffer.alloc(ENSEMBLE_MAX_BYTES - Buffer.byteLength(json), 0x20),
    ]);
    const path = writePreset(bytes);
    await runCli(['ensemble', 'inspect', path, '--json']);
    const first = JSON.parse(stdout());
    expect(first.bytes).toBe(ENSEMBLE_MAX_BYTES);
    expect(first.sha256).toBe(
      `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    );
    expect(first.preset).toEqual(PRESET);
    vi.mocked(console.log).mockClear();
    writeFileSync(path, json);
    await runCli(['ensemble', 'inspect', path, '--json']);
    const second = JSON.parse(stdout());
    expect(second.sha256).not.toBe(first.sha256);
    expect(second.preset).toEqual(first.preset);
    expect(stderr()).toBe('');
  });

  test('rejects an oversized file before reading any content', async () => {
    const path = writePreset(Buffer.alloc(ENSEMBLE_MAX_BYTES + 1, 0x20));
    const actual =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    const opened = vi.fn();
    const reads = vi.fn();
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const file = await actual.open(...args);
      opened();
      const read = file.read.bind(file);
      vi.spyOn(file, 'read').mockImplementation(async (...readArgs) => {
        reads();
        return read(...readArgs);
      });
      return file;
    });
    await runCli(['ensemble', 'inspect', path, '--json']);
    expect(process.exitCode).toBe(1);
    expect(opened).toHaveBeenCalledOnce();
    expect(reads).not.toHaveBeenCalled();
    expect(stdout()).toBe('');
    expect(JSON.parse(stderr()).error).toContain('byte limit');
  });

  test('rejects a file replaced while its descriptor is being read', async () => {
    const path = writePreset();
    const actual =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    const replaced = vi.fn();
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const file = await actual.open(...args);
      const read = file.read.bind(file);
      vi.spyOn(file, 'read').mockImplementationOnce(async (...readArgs) => {
        rmSync(path);
        writeFileSync(
          path,
          JSON.stringify({ ...PRESET, name: 'Replaced team' }),
        );
        replaced();
        return read(...readArgs);
      });
      return file;
    });
    await runCli(['ensemble', 'inspect', path, '--json']);
    expect(replaced).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
    expect(stdout()).toBe('');
    expect(JSON.parse(stderr()).error).toContain(
      'preset file identity changed',
    );
  });

  test.each([
    [
      'oversize before JSON parsing',
      Buffer.alloc(ENSEMBLE_MAX_BYTES + 1, 0x21),
      'byte limit',
    ],
    [
      'malformed UTF-8 inside a JSON string',
      Buffer.from(JSON.stringify({ ...PRESET, name: '\u007f' })).map((byte) =>
        byte === 0x7f ? 0xff : byte,
      ),
      'invalid UTF-8',
    ],
    [
      'truncated UTF-8',
      Buffer.concat([
        Buffer.from(JSON.stringify(PRESET)),
        Buffer.from([0xe2, 0x82]),
      ]),
      'invalid UTF-8',
    ],
    ['invalid JSON', '{', 'JSON'],
    [
      'unsupported version',
      JSON.stringify({ ...PRESET, version: 'station.ensemble/v2' }),
      'unsupported version',
    ],
    [
      'unknown field',
      JSON.stringify({ ...PRESET, launch: true }),
      'unknown field',
    ],
    [
      'invalid Stationmaster',
      JSON.stringify({ ...PRESET, stationmaster: 'absent' }),
      'Stationmaster',
    ],
    [
      'unsupported model option',
      JSON.stringify({
        ...PRESET,
        members: [{ ...PRESET.members[0], options: { invented: true } }],
      }),
      'unsupported model option',
    ],
  ])(
    'rejects %s without an inspection result',
    async (_name, bytes, message) => {
      const path = writePreset(bytes);
      await runCli(['ensemble', 'inspect', path, '--json']);
      expect(process.exitCode).toBe(1);
      expect(stdout()).toBe('');
      expect(JSON.parse(stderr())).toEqual({
        success: false,
        error: expect.stringContaining(message),
      });
    },
  );

  test.each(['missing', 'directory', 'symlink', 'symlink ancestor'])(
    'rejects a %s file path',
    async (kind) => {
      const source = writePreset();
      let path = join(directory, 'missing.json');
      if (kind === 'directory') path = directory;
      else if (kind === 'symlink') symlinkSync(source, path);
      else if (kind === 'symlink ancestor') {
        const alias = join(directory, 'alias');
        symlinkSync(directory, alias, 'dir');
        path = join(alias, 'team.json');
      }
      await runCli(['ensemble', 'inspect', path, '--json']);
      expect(process.exitCode).toBe(1);
      expect(stdout()).toBe('');
      expect(JSON.parse(stderr())).toEqual({
        success: false,
        error: expect.stringContaining(
          kind === 'missing'
            ? 'ENOENT'
            : kind === 'directory'
              ? 'regular preset file'
              : 'symbolic links',
        ),
      });
      expect(readFileSync(source, 'utf8')).toBe(JSON.stringify(PRESET));
    },
  );

  test('keeps authored file names terminal-safe on text failures', async () => {
    await runCli([
      'ensemble',
      'inspect',
      join(directory, 'missing\u001b\u202e.json'),
    ]);
    expect(process.exitCode).toBe(1);
    expect(stdout()).toBe('');
    expect(stderr()).toContain('ENOENT');
    expect(stderr()).not.toContain('\u001b');
    expect(stderr()).not.toContain('\u202e');
  });

  test.each([
    [],
    ['launch', 'team.json'],
    ['inspect'],
    ['inspect', 'a.json', 'b.json'],
    ['inspect', '--unknown', 'a.json'],
  ])('rejects invalid command arguments %j', async (...args) => {
    await runCli(['ensemble', ...args, '--json']);
    expect(process.exitCode).toBe(1);
    expect(stdout()).toBe('');
    expect(JSON.parse(stderr())).toEqual({
      success: false,
      error: expect.stringContaining('station ensemble --help'),
    });
  });
});
