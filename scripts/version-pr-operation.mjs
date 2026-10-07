#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { invokedDirectly } from './lib/module-entry.mjs';

export function needsVersionPr(changesets, preState) {
  if (!Array.isArray(changesets)) throw new Error('Invalid changeset state');
  for (const entry of changesets) {
    if (
      !entry ||
      typeof entry.id !== 'string' ||
      !Array.isArray(entry.releases)
    )
      throw new Error('Invalid changeset releases');
  }
  const pending =
    preState?.mode === 'pre'
      ? changesets.filter((entry) => !entry.id.startsWith('pre/'))
      : changesets;
  return pending.some((entry) => {
    if (!Array.isArray(entry.releases))
      throw new Error('Invalid changeset releases');
    return entry.releases.length > 0;
  });
}

export async function versionPrOperation(cwd, eventName, ref) {
  if (
    !['push', 'workflow_dispatch'].includes(eventName) ||
    ref !== 'refs/heads/main'
  )
    throw new Error('Version automation requires a trusted main event');
  // Use the installed CLI's declared readers, matching the pinned action's
  // prerelease filtering, rather than inventing file-discovery semantics.
  const require = createRequire(import.meta.url);
  const fromCli = createRequire(
    require.resolve('@changesets/cli/package.json'),
  );
  const [reader, pre] = await Promise.all(
    ['@changesets/read', '@changesets/pre'].map(
      (name) => import(pathToFileURL(fromCli.resolve(name)).href),
    ),
  );
  return needsVersionPr(
    await reader.readChangesets(cwd),
    await pre.readPreState(cwd),
  );
}

if (invokedDirectly(import.meta.url)) {
  try {
    if (!process.env.GITHUB_OUTPUT)
      throw new Error('Missing workflow output path');
    const versionPr = await versionPrOperation(
      process.cwd(),
      process.env.GITHUB_EVENT_NAME,
      process.env.GITHUB_REF,
    );
    appendFileSync(process.env.GITHUB_OUTPUT, `version-pr=${versionPr}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
