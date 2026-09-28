import { describe, expect, test } from 'vitest';
import {
  assertPublishedPluginScaffoldDependencies,
  readPluginScaffoldDependencies,
} from '../plugin-scaffold-public-dependencies.mjs';

describe('plugin scaffold public dependency qualification', () => {
  test('package publishing executes the live public-registry qualification', () => {
    const root = resolve(import.meta.dirname, '..', '..');
    const packageJson = JSON.parse(
      readFileSync(join(root, 'package.json'), 'utf8'),
    );
    expect(packageJson.scripts['plugin-scaffold:public-deps']).toBe(
      'node scripts/plugin-scaffold-public-dependencies.mjs',
    );
    const workflow = readFileSync(
      join(root, '.github', 'workflows', 'publish-packages.yml'),
      'utf8',
    );
    expect(workflow).toContain('run: npm run plugin-scaffold:public-deps');
    expect(workflow.indexOf('run: npm ci')).toBeLessThan(
      workflow.indexOf('run: npm run plugin-scaffold:public-deps'),
    );
    expect(
      workflow.indexOf('run: npm run plugin-scaffold:public-deps'),
    ).toBeLessThan(workflow.indexOf('name: Build shared'));
  });

  test('the checked-in authority names both packages by caret registry range', () => {
    // Which versions exist is registry truth, checked live by the publish
    // step above; this pins only the authority's shape.
    const dependencies = readPluginScaffoldDependencies();
    expect(Object.keys(dependencies).sort()).toEqual([
      '@kontourai/station-sdk',
      '@kontourai/station-shared',
    ]);
    for (const range of Object.values(dependencies))
      expect(range).toMatch(/^\^\d+\.\d+\.\d+$/);
  });

  test('resolves each range to its highest published match', () => {
    expect(
      assertPublishedPluginScaffoldDependencies(
        {
          '@kontourai/station-sdk': '^0.4.0',
          '@kontourai/station-shared': '^0.5.0',
        },
        () => ['0.4.0', '0.4.1', '0.5.0', '0.7.0'],
      ),
    ).toEqual([
      {
        packageName: '@kontourai/station-sdk',
        range: '^0.4.0',
        resolved: '0.4.1',
      },
      {
        packageName: '@kontourai/station-shared',
        range: '^0.5.0',
        resolved: '0.5.0',
      },
    ]);
  });

  test('rejects a workspace range and an unpublished workspace version', () => {
    expect(() =>
      assertPublishedPluginScaffoldDependencies(
        {
          '@kontourai/station-sdk': 'workspace:^',
          '@kontourai/station-shared': '^0.4.0',
        },
        () => ['0.4.1'],
      ),
    ).toThrow(/non-registry scaffold range/);
    expect(() =>
      assertPublishedPluginScaffoldDependencies(
        {
          '@kontourai/station-sdk': '^0.4.2',
          '@kontourai/station-shared': '^0.4.0',
        },
        () => ['0.4.0', '0.4.1'],
      ),
    ).toThrow(/does not resolve to a published npm version/);
  });
});

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
