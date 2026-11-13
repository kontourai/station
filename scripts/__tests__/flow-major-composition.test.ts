import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { TRUST_ATTACHMENT_REDUCER_VERSION } from '@kontourai/flow';
import { describe, expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const require = createRequire(import.meta.url);
const manifest = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

describe('Flow major composition', () => {
  test('every direct consumer pins the qualified Flow and Flow Agents pair', () => {
    for (const file of [
      'package.json',
      'packages/contracts/package.json',
      'packages/sdk/package.json',
      'examples/builder-delivery-viewer/package.json',
    ]) {
      const deps = manifest(resolve(root, file)).dependencies;
      expect(deps['@kontourai/flow-agents'], file).toBe('11.0.0');
      if (deps['@kontourai/flow']) {
        expect(deps['@kontourai/flow'], file).toBe('6.0.0');
      }
    }
  });

  test('Station and Flow Agents execute the same Flow reader and reducer', () => {
    const agentsManifest = require.resolve(
      '@kontourai/flow-agents/package.json',
    );
    expect(manifest(agentsManifest).dependencies['@kontourai/flow']).toBe(
      '6.0.0',
    );
    const agentsRequire = createRequire(agentsManifest);
    for (const surface of [
      '@kontourai/flow',
      '@kontourai/flow/gate-evaluation-contract',
      '@kontourai/flow/gate-evaluation-reader',
    ]) {
      expect(realpathSync(agentsRequire.resolve(surface))).toBe(
        realpathSync(require.resolve(surface)),
      );
    }
    expect(TRUST_ATTACHMENT_REDUCER_VERSION).toBe('2.0.0');
    for (const workspace of ['packages/contracts', 'packages/sdk']) {
      const consumer = createRequire(resolve(root, workspace, 'package.json'));
      expect(realpathSync(consumer.resolve('@kontourai/flow'))).toBe(
        realpathSync(require.resolve('@kontourai/flow')),
      );
    }
  });
});
