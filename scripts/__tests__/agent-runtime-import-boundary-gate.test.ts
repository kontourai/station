import { expect, it } from 'vitest';
import {
  durableToolBoundaryFindings,
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

it('Station consumers use only declared root and host integration entry points', () => {
  const file = 'src-server/runtime/consumer.ts';
  const scan = (source: string) =>
    stationRuntimeImportFindings([file], () => source);
  expect(
    scan("import { createAgentRuntime } from '@kontourai/agent-runtime';"),
  ).toEqual([]);
  expect(scan("await import('@kontourai/agent-runtime');")).toEqual([]);
  expect(
    scan("import { agentWire } from '@kontourai/agent-runtime/internal';"),
  ).toEqual([]);
  expect(
    scan(
      "import { createAgentRuntime } from '@kontourai/agent-runtime/src/turn-runtime';",
    ),
  ).toHaveLength(1);
  expect(
    scan("await import('../../packages/agent-runtime/src/index.js');"),
  ).toHaveLength(1);
});

it('both native adapters refuse a raw tool callback outside the execution port', () => {
  for (const file of [
    'src-server/runtime/frameworks/voltagent-adapter.ts',
    'src-server/runtime/frameworks/strands-tool-loader.ts',
  ]) {
    const scan = (source: string) =>
      durableToolBoundaryFindings([file], () => source);
    expect(
      scan('executeDurableTool(input, () => tool.execute(args));'),
    ).toEqual([]);
    expect(scan('tool.execute(args);')).toHaveLength(1);
    expect(
      scan(
        'const original = agent[method]; Reflect.apply(original, agent, [input]);',
      ),
    ).toEqual([]);
    expect(
      scan(
        'const renamed = tool.execute; Reflect.apply(renamed, tool, [args]);',
      ),
    ).toHaveLength(1);
    expect(
      scan(
        'const original = tool.execute; Reflect.apply(original, tool, [args]);',
      ),
    ).toHaveLength(1);
    expect(
      scan(
        'const original = tool.execute; executeDurableTool(input, () => Reflect.apply(original, tool, [args]));',
      ),
    ).toEqual([]);
  }
});
