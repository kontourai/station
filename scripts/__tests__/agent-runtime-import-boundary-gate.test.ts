import { expect, it } from 'vitest';
import {
  runtimeImportFindings,
  stationRuntimeImportFindings,
} from '../agent-runtime-import-boundary-gate.mjs';

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

it('Station consumers use the runtime root for static and dynamic imports', () => {
  const file = 'src-server/runtime/consumer.ts';
  const scan = (source: string) =>
    stationRuntimeImportFindings([file], () => source);
  expect(
    scan("import { createAgentRuntime } from '@kontourai/agent-runtime';"),
  ).toEqual([]);
  expect(scan("await import('@kontourai/agent-runtime');")).toEqual([]);
  expect(
    scan(
      "import { createAgentRuntime } from '@kontourai/agent-runtime/src/turn-runtime';",
    ),
  ).toHaveLength(1);
  expect(
    scan("await import('../../packages/agent-runtime/src/index.js');"),
  ).toHaveLength(1);
});
