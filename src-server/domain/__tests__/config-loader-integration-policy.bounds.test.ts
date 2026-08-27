// @vitest-environment node

import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { ConfigLoader } from '../config-loader.js';

test('rejects an oversized integration policy before an unbounded descriptor read', async () => {
  const home = fs.mkdtempSync(join(tmpdir(), 'station-policy-bounds-'));
  const integrationId = 'station-control';
  const directory = join(home, 'integrations', integrationId);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    join(directory, 'integration.json'),
    JSON.stringify({
      id: integrationId,
      kind: 'mcp',
      command: 'station-control',
    }) + ' '.repeat(3 * 1024 * 1024),
  );
  const originalRead = fs.readFileSync;
  let oversizedDescriptorReads = 0;
  try {
    fs.readFileSync = ((file, ...args) => {
      if (
        typeof file === 'number' &&
        fs.fstatSync(file).size > 2 * 1024 * 1024
      ) {
        oversizedDescriptorReads += 1;
      }
      return Reflect.apply(originalRead, fs, [file, ...args]);
    }) as typeof fs.readFileSync;
    syncBuiltinESMExports();
    const loader = new ConfigLoader({ projectHomeDir: home });
    expect(
      await loader.captureIntegrationPolicySnapshot(integrationId),
    ).toBeNull();
    expect(oversizedDescriptorReads).toBe(0);
  } finally {
    fs.readFileSync = originalRead;
    syncBuiltinESMExports();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('bounds actual policy reads when the opened inode grows after its size check', async () => {
  const home = fs.mkdtempSync(join(tmpdir(), 'station-policy-growth-'));
  const integrationId = 'station-control';
  const directory = join(home, 'integrations', integrationId);
  const file = join(directory, 'integration.json');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ id: integrationId, kind: 'mcp' }));
  const target = fs.statSync(file);
  const originalStat = fs.fstatSync;
  const originalWholeRead = fs.readFileSync;
  const originalBoundedRead = fs.readSync;
  let grew = false;
  let sourceBytesRead = 0;
  const isTarget = (fd: number) => {
    const actual = originalStat(fd);
    return actual.dev === target.dev && actual.ino === target.ino;
  };
  try {
    fs.fstatSync = ((...args) => {
      const stat = Reflect.apply(originalStat, fs, args);
      if (!grew && isTarget(args[0])) {
        grew = true;
        fs.appendFileSync(file, ' '.repeat(3 * 1024 * 1024));
      }
      return stat;
    }) as typeof fs.fstatSync;
    fs.readFileSync = ((fileOrFd, ...args) => {
      const value = Reflect.apply(originalWholeRead, fs, [fileOrFd, ...args]);
      if (typeof fileOrFd === 'number' && isTarget(fileOrFd)) {
        sourceBytesRead += Buffer.byteLength(value);
      }
      return value;
    }) as typeof fs.readFileSync;
    fs.readSync = ((fd, ...args) => {
      const count = Reflect.apply(originalBoundedRead, fs, [fd, ...args]);
      if (isTarget(fd)) sourceBytesRead += count;
      return count;
    }) as typeof fs.readSync;
    syncBuiltinESMExports();
    const loader = new ConfigLoader({ projectHomeDir: home });
    expect(
      await loader.captureIntegrationPolicySnapshot(integrationId),
    ).toBeNull();
    expect(grew).toBe(true);
    expect(sourceBytesRead).toBeLessThanOrEqual(2 * 1024 * 1024 + 1);
  } finally {
    fs.fstatSync = originalStat;
    fs.readFileSync = originalWholeRead;
    fs.readSync = originalBoundedRead;
    syncBuiltinESMExports();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
