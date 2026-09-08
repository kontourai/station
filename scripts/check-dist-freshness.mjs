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
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASIS_MCP_APP_MANIFEST } from './basis-mcp-app-manifest.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';
import {
  formatReport,
  inspectWorkspace,
} from './lib/package-dist-freshness.mjs';

/**
 * Generated build inputs: git-ignored modules that live beside tracked
 * sources and that every typecheck project resolves as ordinary imports. A
 * missing one fails each project with a bare TS2307 naming the *importer*;
 * this names the input and the command instead. Scope is derived from the
 * generator's manifest — an entry present in this tree must have its output
 * beside it — so a tree without the entries (the scratch fixtures, a
 * manifest-only container stage) has nothing to check and says so.
 *
 * @param {{
 *   repoRoot: string,
 *   manifest?: ReadonlyArray<{ id: string, entry: string, output: string }>,
 *   exists?: (path: string) => boolean,
 * }} options
 */
export function inspectGeneratedBuildInputs({
  repoRoot,
  manifest = BASIS_MCP_APP_MANIFEST,
  exists = existsSync,
}) {
  const lines = [];
  const failures = [];
  for (const app of manifest) {
    if (!exists(resolve(repoRoot, app.entry))) {
      lines.push(
        `OK:   ${app.output} — entry ${app.entry} is not in this tree; nothing to generate`,
      );
      continue;
    }
    if (exists(resolve(repoRoot, app.output))) {
      lines.push(`OK:   ${app.output} is present for ${app.entry}`);
      continue;
    }
    failures.push(
      [
        `FAIL: ${app.output} is MISSING; it is generated from ${app.entry}.`,
        '      Every typecheck project that imports it would report TS2307 in the',
        '      importing file rather than here. This is not a source defect.',
        '      Fix: npm run basis:mcp:generate',
        '      (dependencies:ci and station build run it too)',
      ].join('\n'),
    );
  }
  return { lines, failures };
}

export function checkDistFreshness({
  repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  log = console.log,
  logError = console.error,
} = {}) {
  const dist = formatReport(inspectWorkspace(repoRoot));
  const generated = inspectGeneratedBuildInputs({ repoRoot });
  const lines = [...dist.lines, ...generated.lines];
  const failures = [...dist.failures, ...generated.failures];
  for (const line of lines) log(line);
  for (const failure of failures) logError(failure);
  return failures.length === 0;
}

if (invokedDirectly(import.meta.url)) {
  if (!checkDistFreshness()) process.exitCode = 1;
}
