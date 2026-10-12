import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { OpenCodeSessionSource } from '../opencode-session-source.js';
import { OpenCodeFixtureWriter } from './opencode-fixture.js';

/**
 * Asks another process, with F_GETLK, whether any process holds a lock on
 * byte 128 of `-shm`: SQLite's DMS lock, which a WAL-index user holds shared
 * for as long as its connection is open. A process that finds it free
 * reinitialises the WAL index under every other mapping of it. The probe
 * runs in a child because closing a descriptor in this process would itself
 * release this process's locks on the file.
 */
const PROBE = `
import fcntl, os, struct, sys
fd = os.open(sys.argv[1], os.O_RDWR)
fmt = '@qqihh' if sys.platform == 'darwin' else '@hhqqi'
if sys.platform == 'darwin':
    request = struct.pack(fmt, 128, 1, 0, fcntl.F_WRLCK, 0)
else:
    request = struct.pack(fmt, fcntl.F_WRLCK, 0, 128, 1, 0)
reply = fcntl.fcntl(fd, fcntl.F_GETLK, request)
fields = struct.unpack(fmt, reply)
l_type = fields[3] if sys.platform == 'darwin' else fields[0]
print('free' if l_type == fcntl.F_UNLCK else 'held')
`;

const probeAvailable =
  (process.platform === 'darwin' || process.platform === 'linux') &&
  spawnSync('python3', ['-c', 'import fcntl'], { windowsHide: true }).status ===
    0;

function dmsLock(shm: string): string {
  const result = spawnSync('python3', ['-c', PROBE, shm], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

const tempDir = trackTempDirs();
let source: OpenCodeSessionSource | undefined;
afterEach(() => {
  source?.close();
  source = undefined;
});

test.skipIf(!probeAvailable)(
  "keeps its connection's WAL-index lock through a full discover and read cycle",
  async () => {
    const dataDir = join(
      realpathSync(tempDir('station-opencode-locks-')),
      'opencode',
    );
    const writer = new OpenCodeFixtureWriter(dataDir);
    writer.session('ses_main', '/workspace/project');
    const user = writer.user('ses_main', ['Hello']);
    const answer = writer.assistant('ses_main', user, { finish: 'stop' });
    writer.text('ses_main', answer, 'Hi.');
    const shm = `${writer.path}-shm`;
    // Leave the source as the only WAL-index user in this process; the
    // committed rows stay in the WAL that its own connection keeps alive.
    source = new OpenCodeSessionSource({ dataDir });
    const session = (await source.discover()).sessions[0]!;
    writer.close();
    expect(dmsLock(shm)).toBe('held');

    for (let poll = 0; poll < 3; poll += 1) {
      await source.discover();
      const read = await source.read(session);
      expect(read.outcome).toBe('ok');
      expect(dmsLock(shm)).toBe('held');
    }
  },
);
