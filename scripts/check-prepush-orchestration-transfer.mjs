import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeMatches } from './check-prepush-ui-bundle.mjs';
import { resolveRef } from './lib/git-ref.mjs';

const BASE_REF = process.env.STATION_BASE_REF ?? 'origin/main';
export const ORCHESTRATION_TRANSFER_INPUT_PREFIXES = Object.freeze([
  'patches/',
  'src-server/routes/orchestration/',
  'src-server/runtime/',
  'src-server/providers/',
  'src-server/services/orchestration/',
  'packages/sdk/src/client/',
  'packages/contracts/src/',
  'src-server/__test-utils__/orchestration-transfer-',
]);
export const ORCHESTRATION_TRANSFER_INPUT_FILES = Object.freeze([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'scripts/orchestration-transfer-capture.ts',
  'scripts/orchestration-transfer-budget.mjs',
  'scripts/orchestration-transfer-gate.mjs',
  'scripts/check-prepush-orchestration-transfer.mjs',
  'scripts/fixtures/orchestration-transfer/budget.json',
  'scripts/fixtures/orchestration-transfer/policy-attribution.json',
  'src-server/__test-utils__/http-transfer-recorder.ts',
]);

export function isOrchestrationTransferInput(path) {
  const normalized = String(path).replaceAll('\\', '/');
  return (
    ORCHESTRATION_TRANSFER_INPUT_FILES.includes(normalized) ||
    ORCHESTRATION_TRANSFER_INPUT_PREFIXES.some((prefix) =>
      normalized.startsWith(prefix),
    )
  );
}

export function decideOrchestrationTransferScope({ baseSha, changedPaths }) {
  if (!baseSha)
    return {
      run: true,
      reason: `${BASE_REF} could not be resolved, so transfer scope is unknown`,
    };
  const matched = changedPaths.filter(isOrchestrationTransferInput);
  return matched.length
    ? {
        run: true,
        reason: `${matched.length} transfer measurement input(s) changed: ${describeMatches(matched)}`,
      }
    : {
        run: false,
        reason: 'this push changes no orchestration transfer input',
      };
}

/** Includes both sides of a rename: deleting a measured input is still scope. */
export function changedTransferPathsSince(base, run = execFileSync) {
  const fields = run('git', ['diff', '--name-status', '-z', `${base}...HEAD`], {
    encoding: 'utf8',
    windowsHide: true,
  })
    .split('\0')
    .filter(Boolean);
  const paths = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++] ?? '';
    if (status.startsWith('R') || status.startsWith('C')) {
      paths.push(fields[index++] ?? '', fields[index++] ?? '');
    } else paths.push(fields[index++] ?? '');
  }
  return paths.filter(Boolean);
}

export function runOrchestrationTransferGate(spawn = spawnSync) {
  const result = spawn(
    process.execPath,
    ['scripts/orchestration-transfer-gate.mjs'],
    {
      stdio: 'inherit',
      windowsHide: true,
    },
  );
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function main() {
  const baseSha = resolveRef(BASE_REF);
  const decision = decideOrchestrationTransferScope({
    baseSha,
    changedPaths: baseSha ? changedTransferPathsSince(BASE_REF) : [],
  });
  if (!decision.run) {
    console.log(`Orchestration transfer: skipped — ${decision.reason}.`);
    return;
  }
  console.log(`Orchestration transfer: required — ${decision.reason}.`);
  const status = runOrchestrationTransferGate();
  if (status !== 0) process.exitCode = status;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main();
