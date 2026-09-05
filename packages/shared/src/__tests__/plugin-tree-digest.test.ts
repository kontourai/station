import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_PLUGIN_MANIFEST_SCHEMA_1_0 as AGENT_PLUGINS_1_0_MANIFEST_SCHEMA_URL } from '@kontourai/station-contracts/agent-plugin';
import * as rootExports from '@kontourai/station-shared';
import { computePluginTreeDigest } from '@kontourai/station-shared/plugin-tree-digest';
import { expect, test } from 'vitest';

test('public Node leaves preserve canonical source bytes and remain absent from the root barrel', () => {
  const directory = mkdtempSync(join(tmpdir(), 'station-author-digest-'));
  try {
    mkdirSync(join(directory, '.git'));
    mkdirSync(join(directory, 'nested'));
    writeFileSync(join(directory, 'nested', 'b.txt'), 'beta');
    writeFileSync(join(directory, 'a.txt'), 'alpha');
    writeFileSync(
      join(directory, '.git', 'metadata'),
      'not executable package content',
    );
    expect(computePluginTreeDigest(directory)).toBe(
      'sha256:29608e269718704332fa9f7c43c7926241bdc418938b32983ee0397e84a60f24',
    );
    writeFileSync(join(directory, '.git', 'metadata'), 'different VCS state');
    expect(computePluginTreeDigest(directory)).toBe(
      'sha256:29608e269718704332fa9f7c43c7926241bdc418938b32983ee0397e84a60f24',
    );
    writeFileSync(join(directory, 'a.txt'), 'changed');
    expect(computePluginTreeDigest(directory)).not.toBe(
      'sha256:29608e269718704332fa9f7c43c7926241bdc418938b32983ee0397e84a60f24',
    );
    expect(computePluginTreeDigest(join(directory, 'missing'))).toBeNull();
    expect('computePluginTreeDigest' in rootExports).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('v2 distinguishes the demonstrated delimiter collision between one binary file and two files', () => {
  const root = mkdtempSync(join(tmpdir(), 'station-tree-framing-'));
  const a = join(root, 'a'),
    b = join(root, 'b');
  mkdirSync(a);
  mkdirSync(b);
  const manifest = Buffer.from(
    JSON.stringify({
      $schema: AGENT_PLUGINS_1_0_MANIFEST_SCHEMA_URL,
      name: 'framing-fixture',
      version: '1.0.0',
    }),
  );
  const first = { a: Buffer.from('x\0b\0file\0y'), 'plugin.json': manifest };
  const second = {
    a: Buffer.from('x'),
    b: Buffer.from('y'),
    'plugin.json': manifest,
  };
  // Unsafe legacy representation is confined to this regression witness.
  const legacy = (files: Record<string, Buffer>) => {
    const hash = createHash('sha256');
    for (const path of Object.keys(files).sort())
      hash.update(path).update('\0file\0').update(files[path]!).update('\0');
    return `sha256:${hash.digest('hex')}`;
  };
  try {
    for (const [path, bytes] of Object.entries(first))
      writeFileSync(join(a, path), bytes);
    for (const [path, bytes] of Object.entries(second))
      writeFileSync(join(b, path), bytes);
    expect(legacy(first)).toBe(legacy(second));
    expect(computePluginTreeDigest(a)).not.toBe(legacy(first));
    expect(computePluginTreeDigest(a)).not.toBe(computePluginTreeDigest(b));
    const empty = join(root, 'empty'),
      withDirectory = join(root, 'with-directory');
    mkdirSync(empty);
    mkdirSync(withDirectory);
    mkdirSync(join(withDirectory, 'child'));
    expect(computePluginTreeDigest(empty)).not.toBe(
      computePluginTreeDigest(withDirectory),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === 'win32')(
  'v2 hashes symlink target bytes without lossy UTF-8 replacement',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'station-tree-link-bytes-'));
    const link = join(root, 'link');
    try {
      symlinkSync(Buffer.from([0xff]), link);
      const firstText = readlinkSync(link),
        firstDigest = computePluginTreeDigest(root);
      expect(firstDigest).not.toBeNull();
      unlinkSync(link);
      symlinkSync(Buffer.from([0xfe]), link);
      expect(readlinkSync(link)).toBe(firstText);
      expect(computePluginTreeDigest(root)).not.toBe(firstDigest);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

// APFS rejects these filenames at creation; exercise raw filename bytes on Linux.
test.skipIf(process.platform !== 'linux')(
  'v2 refuses non-round-trippable filename bytes',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'station-tree-filename-bytes-'));
    const badPath = Buffer.concat([
      Buffer.from(`${root}/bad`),
      Buffer.from([0xff]),
    ]);
    try {
      writeFileSync(badPath, 'hidden');
      writeFileSync(join(root, 'bad\ufffd'), 'replacement');
      expect(computePluginTreeDigest(root)).toBeNull();
    } finally {
      unlinkSync(badPath);
      rmSync(root, { recursive: true, force: true });
    }
  },
);
