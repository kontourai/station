import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  createConformanceReport,
  renderConformanceMatrix,
  serializeConformanceReport,
} from '@kontourai/conduit';
import { createStationFrameworkConduitAdapter } from '../src-server/runtime/frameworks/conduit-framework-adapter';

const root = resolve(import.meta.dirname, '..');
const lock = JSON.parse(
  await readFile(resolve(root, 'package-lock.json'), 'utf8'),
);
const installedVersion = (name) => {
  const version = lock.packages?.[`node_modules/${name}`]?.version;
  if (!version) throw new Error(`Missing installed version for ${name}`);
  return version;
};

const conduitVersion = installedVersion('@kontourai/conduit');
const report = await createConformanceReport([
  {
    adapter: createStationFrameworkConduitAdapter('strands'),
    evidenceScope: 'host-bound',
    adapterVersion: conduitVersion,
    hostId: 'station-strands',
    hostVersion: installedVersion('@strands-agents/sdk'),
    limitations: [
      'IAgentHooks does not expose session-start or before-model',
      'message persistence is synchronized after invocation',
      'stop is projected from AfterInvocationEvent',
    ],
  },
  {
    adapter: createStationFrameworkConduitAdapter('voltagent'),
    evidenceScope: 'host-bound',
    adapterVersion: conduitVersion,
    hostId: 'station-voltagent',
    hostVersion: installedVersion('@voltagent/core'),
    limitations: [
      'IAgentHooks does not expose session-start or before-model',
      'stop is projected from the existing onEnd hook',
    ],
  },
]);

const outputs = new Map([
  [
    resolve(root, 'docs/conformance/station-runtime-conformance.json'),
    serializeConformanceReport(report),
  ],
  [
    resolve(root, 'docs/conformance/station-runtime-conformance.md'),
    `${renderConformanceMatrix(report)}\nStation application policy, approvals, memory, orchestration, and canonical events remain outside Conduit.\n`,
  ],
]);
const check = process.argv.includes('--check');
for (const [path, content] of outputs) {
  if (check) {
    const current = await readFile(path, 'utf8').catch(() => '');
    if (current !== content) {
      console.error(
        `${path} is stale; run npm run conduit:conformance:generate`,
      );
      process.exitCode = 1;
    }
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}
