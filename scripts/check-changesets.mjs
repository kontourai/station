#!/usr/bin/env node
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Resolve the CLI's own declared planner dependencies, so this gate uses the
// same package discovery, config and release rules as the installed publisher.
const require = createRequire(import.meta.url);
const fromCli = createRequire(require.resolve('@changesets/cli/package.json'));
const load = (name) => import(pathToFileURL(fromCli.resolve(name)).href);

export async function checkChangesets(cwd = process.cwd()) {
  const [discovery, configuration, reader, pre, planner] = await Promise.all([
    load('@manypkg/get-packages'),
    load('@changesets/config'),
    load('@changesets/read'),
    load('@changesets/pre'),
    load('@changesets/assemble-release-plan'),
  ]);
  const packages = await discovery.getPackages(cwd);
  const { config, errors, warnings } = await configuration.readConfig(
    packages.rootDir,
    packages,
  );
  if (errors?.length) throw new Error(errors.join('\n'));
  for (const warning of warnings ?? []) process.stderr.write(`${warning}\n`);
  const changesets = await reader.readChangesets(packages.rootDir);
  const plan = planner.assembleReleasePlan(
    changesets,
    packages,
    config,
    await pre.readPreState(packages.rootDir),
  );
  return {
    changesets: changesets.length,
    packages: plan.releases.map((release) => release.name),
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const result = await checkChangesets();
    process.stdout.write(
      `PASS: ${result.changesets} changesets form a valid release plan. Packages: ${result.packages.join(', ') || '(none)'}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `FAIL: changeset release plan: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
