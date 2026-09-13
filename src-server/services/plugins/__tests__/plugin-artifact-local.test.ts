import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import {
  captureLocalPluginArtifact,
  materializePluginArtifact,
} from '../plugin-artifact-local.js';
import type {
  PluginArtifactEntry,
  PreparedPluginArtifact,
} from '../plugin-installation-service.js';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'station-artifact-'));
  roots.push(root);
  const source = join(root, 'source'),
    destination = join(root, 'destination');
  mkdirSync(source);
  mkdirSync(destination);
  return { root, source, destination };
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function artifact(entries: PluginArtifactEntry[]): PreparedPluginArtifact {
  return {
    digest: `sha256:${'a'.repeat(64)}`,
    async *readEntries() {
      yield* entries;
    },
  };
}
test('a transferable reader materializes actual bytes and verifies the source digest', async () => {
  const f = fixture();
  writeFileSync(join(f.source, 'plugin.json'), '{"name":"fixture"}');
  await materializePluginArtifact(
    captureLocalPluginArtifact(f.source),
    f.destination,
  );
  expect(readFileSync(join(f.destination, 'plugin.json'), 'utf8')).toBe(
    '{"name":"fixture"}',
  );
});
test('a symlink escape is rejected before publication rather than trusted because its text is hashed', async () => {
  const f = fixture();
  await expect(
    materializePluginArtifact(
      artifact([{ path: 'escape', kind: 'symlink', target: '../outside' }]),
      f.destination,
    ),
  ).rejects.toThrow('outside');
});
test.runIf(process.platform !== 'win32')(
  'contained links survive reader transfer with their exact link text',
  async () => {
    const f = fixture();
    writeFileSync(join(f.source, 'data'), 'bytes');
    symlinkSync('data', join(f.source, 'link'));
    await materializePluginArtifact(
      captureLocalPluginArtifact(f.source),
      f.destination,
    );
    expect(readFileSync(join(f.destination, 'link'), 'utf8')).toBe('bytes');
  },
);
test.runIf(process.platform !== 'win32')(
  'a delayed symlink chain cannot escape through a contained intermediate link',
  async () => {
    const f = fixture();
    writeFileSync(join(f.root, 'outside'), 'must remain');
    mkdirSync(join(f.source, 'dir'));
    writeFileSync(join(f.source, 'dir', 'outside'), 'inside decoy');
    symlinkSync('..', join(f.source, 'dir', 'up'));
    symlinkSync('dir/up/../outside', join(f.source, 'escape'));
    expect(readFileSync(join(f.source, 'escape'), 'utf8')).toBe('must remain');
    expect(realpathSync.native(join(f.source, 'escape'))).toBe(
      realpathSync.native(join(f.root, 'outside')),
    );
    await expect(
      materializePluginArtifact(
        captureLocalPluginArtifact(f.source),
        f.destination,
      ),
    ).rejects.toThrow('chain escapes');
    expect(readFileSync(join(f.root, 'outside'), 'utf8')).toBe('must remain');
  },
);

test.each([
  '../escape',
  '/absolute',
  'directory/../rewritten',
  'directory\\file',
])(
  'rejects invalid artifact entry path %s before treating it as prepared',
  async (path) => {
    const f = fixture();
    await expect(
      materializePluginArtifact(
        artifact([{ path, kind: 'file', bytes: new Uint8Array([1]) }]),
        f.destination,
      ),
    ).rejects.toThrow('path');
  },
);
test
  .runIf(process.platform === 'win32')
  .each([
    'C:/drive',
    'file:stream',
    'trailing.',
    'trailing ',
    'nul',
    'con.txt',
    'COM1.log',
  ])(
  'Windows explicitly refuses unsupported content spelling %s',
  async (path) => {
    const f = fixture();
    await expect(
      materializePluginArtifact(
        artifact([{ path, kind: 'file', bytes: new Uint8Array([1]) }]),
        f.destination,
      ),
    ).rejects.toThrow('unsupported Windows');
  },
);
test.runIf(process.platform === 'win32')(
  'Windows rejects case-colliding parent spellings',
  async () => {
    const f = fixture();
    await expect(
      materializePluginArtifact(
        artifact([
          { path: 'Folder/a', kind: 'file', bytes: new Uint8Array([1]) },
          { path: 'folder/b', kind: 'file', bytes: new Uint8Array([2]) },
        ]),
        f.destination,
      ),
    ).rejects.toThrow('case-colliding');
  },
);
