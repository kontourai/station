import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { runKontourDependencyDriftGate } from '../../../../scripts/check-kontour-dependency-drift.js';
import {
  formatKontourDependencyState,
  inspectExactKontourDependencyPins,
} from '../lib/kontour-dependency-drift.js';

const roots: string[] = [];

function fixture(manifest: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'station-dependency-drift-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
  return root;
}

function install(root: string, name: string, version: string): void {
  const packageJson = join(
    root,
    'node_modules',
    ...name.split('/'),
    'package.json',
  );
  mkdirSync(dirname(packageJson), { recursive: true });
  writeFileSync(packageJson, JSON.stringify({ name, version }));
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('exact Kontour dependency drift', () => {
  test('checks only exact @kontourai pins across dependency fields', () => {
    const root = fixture({
      dependencies: {
        '@kontourai/flow': '1.3.0',
        '@kontourai/surface': '^2.12.0',
        react: '19.2.0',
      },
      devDependencies: {
        '@kontourai/veritas': '1.5.0-beta.2',
      },
    });
    install(root, '@kontourai/flow', '1.3.0');
    install(root, '@kontourai/veritas', '1.5.0-beta.2');

    expect(inspectExactKontourDependencyPins(root)).toEqual({
      exactPins: [
        { name: '@kontourai/flow', pinned: '1.3.0', installed: '1.3.0' },
        {
          name: '@kontourai/veritas',
          pinned: '1.5.0-beta.2',
          installed: '1.5.0-beta.2',
        },
      ],
      mismatches: [],
    });
  });

  test('reports mismatched, missing, and unreadable installed manifests', () => {
    const root = fixture({
      dependencies: {
        '@kontourai/conduit': '0.2.1',
        '@kontourai/dispatch': '0.2.0',
        '@kontourai/flow-agents': '5.2.0',
      },
    });
    install(root, '@kontourai/conduit', '0.2.0');
    install(root, '@kontourai/dispatch', '0.2.0');
    const unreadable = join(
      root,
      'node_modules',
      '@kontourai',
      'flow-agents',
      'package.json',
    );
    mkdirSync(dirname(unreadable), { recursive: true });
    writeFileSync(unreadable, '{');

    const state = inspectExactKontourDependencyPins(root);

    expect(state.mismatches).toEqual([
      {
        name: '@kontourai/conduit',
        pinned: '0.2.1',
        installed: '0.2.0',
      },
      {
        name: '@kontourai/flow-agents',
        pinned: '5.2.0',
        installed: null,
      },
    ]);
    expect(formatKontourDependencyState(state)).toBe(
      '@kontourai/conduit: pinned 0.2.1, installed 0.2.0; @kontourai/flow-agents: pinned 5.2.0, installed missing',
    );
  });

  test('makes the static gate fail before expensive verification work', () => {
    const root = fixture({
      dependencies: { '@kontourai/flow-agents': '5.2.0' },
    });
    install(root, '@kontourai/flow-agents', '5.1.0');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(runKontourDependencyDriftGate(root)).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(
        '@kontourai/flow-agents: pinned 5.2.0, installed 5.1.0',
      ),
    );
  });
});
