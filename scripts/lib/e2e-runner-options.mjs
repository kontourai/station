import { delimiter, dirname, posix } from 'node:path';

function readOptionValues(argv, name) {
  const flag = `--${name}`;
  const values = [];

  for (const argument of argv) {
    if (argument === flag) {
      throw new Error(`${flag} requires a value.`);
    }
    if (!argument.startsWith(`${flag}=`)) continue;
    const value = argument.slice(flag.length + 1).trim();
    if (!value) {
      throw new Error(`${flag} requires a value.`);
    }
    values.push(value);
  }

  return values;
}

function normalizeSpecPath(spec) {
  const portable = spec.replaceAll('\\', '/').replace(/^\.\//, '');
  return posix.normalize(portable);
}

export function resolveE2ERunnerSelection(argv, suite, suiteSpecs) {
  const requestedSpecs = readOptionValues(argv, 'spec').map(normalizeSpecPath);
  const grepValues = readOptionValues(argv, 'grep');
  if (grepValues.length > 1) {
    throw new Error('--grep may be provided only once.');
  }
  const screensValues = readOptionValues(argv, 'screens');
  if (screensValues.length > 1) {
    throw new Error('--screens may be provided only once.');
  }
  // station#4464: comma-separated STATION_E2E_SCREENS names, forwarded
  // verbatim to the spawned Playwright process as an env var — the spec
  // (tests/screenshots.spec.ts) owns name validation against its own
  // SCREENS list, so this stays a dumb passthrough.
  const screens = screensValues[0]
    ?.split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (screensValues.length === 1 && (!screens || screens.length === 0)) {
    throw new Error('--screens requires at least one screen name.');
  }

  const requested = new Set(requestedSpecs);
  for (const spec of requested) {
    if (!suiteSpecs.includes(spec)) {
      throw new Error(
        `Focused spec '${spec}' is not a member of the ${suite} E2E suite.`,
      );
    }
  }

  return {
    specs:
      requested.size > 0
        ? suiteSpecs.filter((spec) => requested.has(spec))
        : suiteSpecs,
    grep: grepValues[0],
    screens,
  };
}

export function withValidatedNodePath(
  environment = process.env,
  execPath = process.execPath,
) {
  const nodeDirectory = dirname(execPath);
  const existing = (environment.PATH ?? '')
    .split(delimiter)
    .filter((entry) => entry && entry !== nodeDirectory);

  return {
    ...environment,
    PATH: [nodeDirectory, ...existing].join(delimiter),
  };
}
