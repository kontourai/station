import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { spawnSyncBounded } from '../lib/bounded-capture.mjs';

const makeTemp = trackTempDirs({ lifetime: 'file' });
const config = resolve('config/code-hygiene.oxlint.json');
const detector = resolve('node_modules/oxlint/bin/oxlint');

function lint(file: string, source: string) {
  const root = makeTemp('station-code-hygiene-');
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
  return spawnSyncBounded(
    process.execPath,
    [detector, '--config', config, '--format', 'json', file],
    { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30_000 },
  );
}

describe('installed Veritas hygiene policy', () => {
  it('rejects unexplained suppressions and permits explained directives or literal examples', () => {
    const bad = lint('src/example.ts', '// @ts-ignore\nconst value = 1;');
    expect(bad.status, bad.stderr).toBe(1);
    expect(bad.stdout).toContain('Say why');
    const biome = lint(
      'src/example.ts',
      '// biome-ignore lint/suspicious/noExplicitAny\nconst value = 1;',
    );
    expect(biome.status, biome.stderr).toBe(1);
    expect(biome.stdout).toContain('Say why');
    const good = lint(
      'src/example.ts',
      '// @ts-expect-error -- Deliberately invalid type fixture.\nconst value: string = 1;\n// biome-ignore lint/suspicious/noExplicitAny: Deliberate provider boundary fixture.\nconst example = "// @ts-ignore";',
    );
    expect(good.status, good.stdout + good.stderr).toBe(0);
  });

  it('rejects real clocks in contract tests while permitting fixed fixtures and integration timing', () => {
    const contract = lint(
      'packages/contracts/src/example.test.ts',
      'Date.now();',
    );
    expect(contract.status, contract.stdout + contract.stderr).toBe(1);
    expect(contract.stdout).toContain('controlled test clock');
    const fixed = lint(
      'packages/contracts/src/example.test.ts',
      'new Date(0);',
    );
    expect(fixed.status, fixed.stdout + fixed.stderr).toBe(0);
    const integration = lint(
      'tests/integration/example.spec.ts',
      'Date.now();',
    );
    expect(integration.status, integration.stdout + integration.stderr).toBe(0);
  });
});
