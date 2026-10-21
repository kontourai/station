import { expect, it } from 'vitest';
import { runtimeImportFindings } from '../agent-runtime-import-boundary-gate.mjs';

it('refuses Station coupling and permits public Monument imports', () => {
  const files = ['packages/agent-runtime/src/index.ts'];
  const manifest = JSON.stringify({
    dependencies: { '@kontourai/monument': '0.1.0' },
  });
  const scan = (source: string) =>
    runtimeImportFindings(files, (path: string) =>
      path.endsWith('package.json') ? manifest : source,
    );
  expect(scan("import { x } from '@kontourai/monument';")).toEqual([]);
  expect(scan("import { DatabaseSync } from 'node:sqlite';")).toEqual([]);
  expect(
    scan("import { x } from '@kontourai/station-contracts';"),
  ).toHaveLength(1);
  expect(
    scan("import { x } from '../../../src-server/runtime/types.js';"),
  ).toHaveLength(1);
  expect(scan('await import(somePath);')).toHaveLength(1);
});
