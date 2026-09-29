import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  INTEGRATION_ICON_MAX_BYTES,
  IntegrationIconAssets,
  isContainedRelativePath,
} from '../integration-icon-assets.js';

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const roots: string[] = [];

async function fixture(icon?: string) {
  const root = await mkdtemp(join(tmpdir(), 'station-icons-'));
  roots.push(root);
  const dir = join(root, 'integrations', 'local');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'integration.json'),
    JSON.stringify({ id: 'local', icon }),
  );
  return { root, dir, assets: new IntegrationIconAssets(root) };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('IntegrationIconAssets', () => {
  test('rejects absolute and Windows cross-volume relative results', () => {
    expect(isContainedRelativePath('local/icon.png')).toBe(true);
    expect(isContainedRelativePath('../outside.png')).toBe(false);
    expect(isContainedRelativePath('..\\outside.png')).toBe(false);
    expect(isContainedRelativePath('/outside.png')).toBe(false);
    expect(isContainedRelativePath('D:\\outside.png')).toBe(false);
  });

  test('serves a signature-valid, bounded declared PNG from the installed integration', async () => {
    const { dir, assets } = await fixture('brand.png');
    await writeFile(join(dir, 'brand.png'), PNG);
    const result = await assets.resolve('local');
    expect(result.status).toBe('found');
    if (result.status === 'found') {
      expect(result.asset.contentType).toBe('image/png');
      expect(result.asset.etag).toMatch(/^"[a-f0-9]{64}"$/);
    }
  });

  test('uses a common local favicon when explicit art is absent', async () => {
    const { dir, assets } = await fixture();
    await writeFile(join(dir, 'favicon.png'), PNG);
    expect((await assets.resolve('local')).status).toBe('found');
  });

  test.each([
    ['https://example.test/mark.png', 'remote URL'],
    ['../outside.png', 'traversal'],
    ['/tmp/mark.png', 'absolute path'],
  ])('rejects %s manifest input (%s)', async (icon) => {
    // A real PNG waits at the traversal target and a favicon in the
    // integration, so an escape would be served rather than merely missing.
    // The filename check and the realpath containment check are redundant
    // layers; this pins the no-escape outcome, not either layer alone.
    const { root, dir, assets } = await fixture(icon);
    await writeFile(
      join(root, 'integrations', 'outside.png'),
      Buffer.concat([PNG, Buffer.from('outside')]),
    );
    const favicon = Buffer.concat([PNG, Buffer.from('favicon')]);
    await writeFile(join(dir, 'favicon.png'), favicon);
    const result = await assets.resolve('local');
    expect(result.status).toBe('found');
    if (result.status === 'found') {
      expect(result.asset.body.equals(favicon)).toBe(true);
    }
  });

  test('rejects forged extensions, oversized files, and symlink escape', async () => {
    const first = await fixture('brand.png');
    await writeFile(
      join(first.dir, 'brand.png'),
      Buffer.from('<svg onload=alert(1)>'),
    );
    expect((await first.assets.resolve('local')).status).toBe('invalid');

    const second = await fixture('brand.png');
    await writeFile(
      join(second.dir, 'brand.png'),
      Buffer.concat([PNG, Buffer.alloc(INTEGRATION_ICON_MAX_BYTES)]),
    );
    expect((await second.assets.resolve('local')).status).toBe('invalid');

    const third = await fixture('brand.png');
    const outside = join(third.root, 'outside.png');
    await writeFile(outside, PNG);
    await symlink(outside, join(third.dir, 'brand.png'));
    expect((await third.assets.resolve('local')).status).toBe('invalid');
  });
});
