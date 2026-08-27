#!/usr/bin/env tsx

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  formatKontourDependencyState,
  inspectExactKontourDependencyPins,
} from '../packages/cli/src/lib/kontour-dependency-drift.js';

export function runKontourDependencyDriftGate(
  repoRoot = process.cwd(),
): number {
  const state = inspectExactKontourDependencyPins(repoRoot);
  const detail = formatKontourDependencyState(state);

  if (state.mismatches.length > 0) {
    console.error(`Kontour dependency drift detected: ${detail}`);
    console.error(
      'Run npm install (or npm ci in a fresh worktree) before verification.',
    );
    return 1;
  }

  console.log(`Kontour dependency pins: ${detail}`);
  return 0;
}

const invokedUrl = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (import.meta.url === invokedUrl) {
  try {
    process.exitCode = runKontourDependencyDriftGate();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
