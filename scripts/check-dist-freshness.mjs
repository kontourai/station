#!/usr/bin/env node
/**
 * Refuse to typecheck against a stale, untracked package build (station#1813).
 *
 * `npm run typecheck` resolves `@kontourai/station-connect` through
 * `packages/connect/dist/*.d.ts`. That directory is gitignored, so it is never
 * part of a checkout and nothing in the `typecheck` script rebuilds it. A merge
 * touching `packages/connect/src` therefore invalidates every worktree's local
 * `dist` — and the resulting type error names a *consumer* file the merger has
 * never opened (`ConnectionBannerSource.tsx`, `OnboardingGate.tsx` in the
 * live instance), which reads as "main is broken".
 *
 * This gate runs before the typecheck projects and fails with the actual cause:
 * the build directory is stale, and here is the command that fixes it. A
 * guardrail whose diagnostic points at the wrong file is worse than none.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { invokedDirectly } from './lib/module-entry.mjs';
import {
  formatReport,
  inspectWorkspace,
} from './lib/package-dist-freshness.mjs';

export function checkDistFreshness({
  repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  log = console.log,
  logError = console.error,
} = {}) {
  const { lines, failures } = formatReport(inspectWorkspace(repoRoot));
  for (const line of lines) log(line);
  for (const failure of failures) logError(failure);
  return failures.length === 0;
}

if (invokedDirectly(import.meta.url)) {
  if (!checkDistFreshness()) process.exitCode = 1;
}
