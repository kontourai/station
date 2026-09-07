import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const installerPath = resolve(root, 'ops/nightly/install-android.zsh');
const fixtureRoots: string[] = [];

function executable(path: string, source: string) {
  writeFileSync(path, source, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function createFixture() {
  const fixture = mkdtempSync(join(tmpdir(), 'station-android-nightly-'));
  fixtureRoots.push(fixture);
  const bin = join(fixture, 'bin');
  const androidHome = join(fixture, 'android');
  const log = join(fixture, 'adb.log');
  const pidofCount = join(fixture, 'pidof-count');
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(androidHome, 'platform-tools'), { recursive: true });

  executable(
    join(bin, 'git'),
    `#!/bin/sh
if [ "$1" = "rev-parse" ]; then
  if [ "$2" = "--show-toplevel" ]; then printf '%s\\n' "$PWD"; else printf '%s\\n' '0123456789abcdef'; fi
fi
`,
  );
  executable(join(bin, 'node'), '#!/bin/sh\nprintf "24\\n"\n');
  executable(join(bin, 'npm'), '#!/bin/sh\nexit 0\n');
  executable(
    join(bin, 'npx'),
    `#!/bin/sh
if [ "$1 $2 $3" = "tauri android build" ]; then
  apk="$PWD/src-desktop/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk"
  mkdir -p "$(dirname "$apk")"
  : > "$apk"
fi
`,
  );
  executable(join(bin, 'shasum'), '#!/bin/sh\nprintf "%064d  %s\\n" 0 "$3"\n');
  executable(
    join(bin, 'sleep'),
    '#!/bin/sh\nprintf "sleep:%s\\n" "$1" >> "$FAKE_ADB_LOG"\n',
  );
  executable(
    join(androidHome, 'platform-tools', 'adb'),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_ADB_LOG"
if [ "$1" = devices ]; then
  printf 'List of devices attached\\nserial-1\\tdevice\\n'
  exit 0
fi
if [ "$3" = install ]; then
  exit 0
fi
if [ "$3 $4 $5 $6" = "shell cmd package resolve-activity" ]; then
  printf '%s\\n' "\${FAKE_ACTIVITY:-io.kontourai.station.debug/io.kontourai.station.MainActivity}"
  exit 0
fi
if [ "$3 $4 $5" = "shell am start" ]; then
  exit 0
fi
if [ "$3 $4 $5" = "shell pidof io.kontourai.station.debug" ]; then
  count=0
  if [ -f "$FAKE_PIDOF_COUNT" ]; then count=$(cat "$FAKE_PIDOF_COUNT"); fi
  count=$((count + 1))
  printf '%s' "$count" > "$FAKE_PIDOF_COUNT"
  if [ -n "\${FAKE_PIDOF_OUTPUT+x}" ]; then
    printf '%s\\n' "$FAKE_PIDOF_OUTPUT"
    exit "\${FAKE_PIDOF_EXIT:-0}"
  fi
  if [ -n "\${FAKE_PIDOF_STDERR+x}" ]; then
    printf '%s\\n' "$FAKE_PIDOF_STDERR" >&2
    exit "\${FAKE_PIDOF_EXIT:-1}"
  fi
  if [ "$count" -gt "\${FAKE_PIDOF_READY_AFTER:-0}" ]; then
    printf '12345\\n'
    exit 0
  fi
  exit 1
fi
exit 1
`,
  );

  return { androidHome, bin, fixture, log, pidofCount };
}

function runInstaller(
  fixture: ReturnType<typeof createFixture>,
  overrides: Record<string, string> = {},
) {
  const result = spawnSync('/bin/zsh', ['-df', installerPath], {
    cwd: fixture.fixture,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      ANDROID_HOME: fixture.androidHome,
      NDK_HOME: join(fixture.fixture, 'ndk'),
      PATH: `${fixture.bin}:${process.env.PATH}`,
      FAKE_ADB_LOG: fixture.log,
      FAKE_PIDOF_COUNT: fixture.pidofCount,
      ...overrides,
    },
  });
  if (result.error || result.signal) {
    const detail = result.error
      ? `${result.error.name}: ${result.error.message}`
      : `terminated by ${result.signal}`;
    throw new Error(
      `Android nightly installer could not execute /bin/zsh: ${detail}`,
    );
  }
  return result;
}

afterEach(() => {
  for (const fixture of fixtureRoots.splice(0)) {
    rmSync(fixture, { force: true, recursive: true });
  }
});

describe('Android nightly installer', () => {
  it('uses the resolved debug package activity and accepts immediate process readiness without sleeping', () => {
    const fixture = createFixture();
    const result = runInstaller(fixture);

    expect(result.status).toBe(0);
    const calls = readFileSync(fixture.log, 'utf8');
    expect(calls).toContain(
      'shell cmd package resolve-activity --brief io.kontourai.station.debug',
    );
    expect(calls).toContain(
      'shell am start -n io.kontourai.station.debug/io.kontourai.station.MainActivity',
    );
    expect(calls).toContain('shell pidof io.kontourai.station.debug');
    expect(calls).not.toContain('sleep:');
  });

  it('retries process readiness at a bounded cadence before reporting success', () => {
    const fixture = createFixture();
    const result = runInstaller(fixture, { FAKE_PIDOF_READY_AFTER: '2' });

    expect(result.status).toBe(0);
    expect(readFileSync(fixture.pidofCount, 'utf8')).toBe('3');
    expect(readFileSync(fixture.log, 'utf8').match(/sleep:1/g)).toHaveLength(2);
  });

  it('accepts one or more positive decimal pidof results', () => {
    const fixture = createFixture();
    const result = runInstaller(fixture, {
      FAKE_PIDOF_EXIT: '0',
      FAKE_PIDOF_OUTPUT: '123 456',
    });

    expect(result.status).toBe(0);
    expect(readFileSync(fixture.pidofCount, 'utf8')).toBe('1');
    expect(readFileSync(fixture.log, 'utf8')).not.toContain('sleep:');
  });

  it('does not accept numeric pidof output when pidof exits nonzero', () => {
    const fixture = createFixture();
    const result = runInstaller(fixture, {
      FAKE_PIDOF_EXIT: '1',
      FAKE_PIDOF_OUTPUT: '123 456',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'io.kontourai.station.debug is not running within 10s of launch.',
    );
    expect(readFileSync(fixture.pidofCount, 'utf8')).toBe('11');
    expect(readFileSync(fixture.log, 'utf8').match(/sleep:1/g)).toHaveLength(
      10,
    );
  });

  it.each(['  123 456  ', '\r123 456\r'])(
    'normalizes surrounding pidof whitespace before validating: %j',
    (output) => {
      const fixture = createFixture();
      const result = runInstaller(fixture, { FAKE_PIDOF_OUTPUT: output });

      expect(result.status).toBe(0);
      expect(readFileSync(fixture.pidofCount, 'utf8')).toBe('1');
      expect(readFileSync(fixture.log, 'utf8')).not.toContain('sleep:');
    },
  );
  it('fails after the bounded readiness window when the launched package never runs', {
    timeout: 60_000,
  }, () => {
    const fixture = createFixture();
    const result = runInstaller(fixture, { FAKE_PIDOF_READY_AFTER: '100' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'io.kontourai.station.debug is not running within 10s of launch.',
    );
    expect(readFileSync(fixture.pidofCount, 'utf8')).toBe('11');
    expect(readFileSync(fixture.log, 'utf8').match(/sleep:1/g)).toHaveLength(
      10,
    );
  });

  it.each([
    'io.kontourai.station/io.kontourai.station.MainActivity',
    'io.kontourai.station.debug/io.kontourai.station/MainActivity',
    'io.kontourai.station.debug/io.kontourai.station.MainActivity;id',
    'io.kontourai.station.debug/io.kontourai.station.Main$PATH',
    'io.kontourai.station.debug/io.kontourai.station/Main Activity',
    'io.kontourai.station.debug/io.kontourai.station/Main\tActivity',
    'io.kontourai.station.debug/.',
  ])(
    'rejects an invalid resolved activity before launching it: %s',
    (activity) => {
      const fixture = createFixture();
      const result = runInstaller(fixture, {
        FAKE_ACTIVITY: activity,
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'could not resolve a launch activity for io.kontourai.station.debug',
      );
      const calls = readFileSync(fixture.log, 'utf8');
      expect(calls).not.toContain('shell am start');
      expect(calls).not.toContain('shell pidof');
    },
  );

  it.each([
    'not-a-pid',
    '0',
    '-1',
    '123 not-a-pid',
    '123; touch should-not-run',
  ])('does not accept malformed pidof output: %s', (output) => {
    const fixture = createFixture();
    const result = runInstaller(fixture, { FAKE_PIDOF_OUTPUT: output });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'io.kontourai.station.debug is not running within 10s of launch.',
    );
    expect(readFileSync(fixture.pidofCount, 'utf8')).toBe('11');
    expect(readFileSync(fixture.log, 'utf8').match(/sleep:1/g)).toHaveLength(
      10,
    );
  });

  it('fails loud after a bounded retry when pidof reports a transport error', () => {
    const fixture = createFixture();
    const result = runInstaller(fixture, {
      FAKE_PIDOF_STDERR: 'adb transport unavailable',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('adb transport unavailable');
    expect(result.stderr).toContain(
      'io.kontourai.station.debug is not running within 10s of launch.',
    );
    expect(readFileSync(fixture.pidofCount, 'utf8')).toBe('11');
  });
});
