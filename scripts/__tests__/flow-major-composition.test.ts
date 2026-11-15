import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { TRUST_ATTACHMENT_REDUCER_VERSION } from '@kontourai/flow';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import viewerManifest from '../../examples/builder-delivery-viewer/package.json' with {
  type: 'json',
};
import rootManifest from '../../package.json' with { type: 'json' };
import contractsManifest from '../../packages/contracts/package.json' with {
  type: 'json',
};
import sdkManifest from '../../packages/sdk/package.json' with { type: 'json' };

const root = resolve(import.meta.dirname, '../..');
const require = createRequire(import.meta.url);
const manifest = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

describe('Flow major composition', () => {
  test('every direct consumer pins the qualified Flow and Flow Agents pair', () => {
    for (const [name, deps] of [
      ['root', rootManifest.dependencies],
      ['contracts', contractsManifest.dependencies],
      ['sdk', sdkManifest.dependencies],
    ] as const) {
      expect(deps['@kontourai/flow-agents'], name).toBe('11.0.0');
      expect(deps['@kontourai/flow'], name).toBe('6.0.0');
    }
    expect(viewerManifest.dependencies['@kontourai/flow-agents']).toBe(
      '11.0.0',
    );
  });

  test('the lockfile permits only Flow 6 and Console’s type-only Flow 1.4.1', () => {
    const lock = parse(
      readFileSync(new URL('../../pnpm-lock.yaml', import.meta.url), 'utf8'),
    );
    for (const section of ['packages', 'snapshots']) {
      const versions = Object.keys(lock[section]).flatMap((key) => {
        const match = /^@kontourai\/flow@([^ (]+)/.exec(key);
        return match ? [match[1]] : [];
      });
      expect(versions.length, section).toBeGreaterThan(0);
      expect(
        versions.filter(
          (version) => !/^6\./.test(version) && version !== '1.4.1',
        ),
        section,
      ).toEqual([]);
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
