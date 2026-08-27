#!/usr/bin/env node
/**
 * Parse the changesets action's `published-packages` output for the deploy
 * ledger (station#4572).
 *
 * The contract: the changesets action at the SHA pinned in
 * publish-packages.yml (action.yml + src/index.ts:94-97) emits a COMPACT
 * SINGLE-LINE JSON ARRAY — `[{"name":"@scope/pkg","version":"1.2.0"},...]` —
 * never newline-separated `name@version` lines. This branch's review (HIGH-1)
 * proved what happens when that output is parsed as text lines: exactly one
 * row is written, its version field is a fabricated fragment containing
 * quotes, braces and the JSON tail of the other package
 * (`kontourai/station-cli","version":"0.4.1"}]`), and every other package is
 * silently dropped. A ledger whose thesis is "every field validated" cannot
 * record a parse artifact as a version.
 *
 * So the parse lives here, as a unit under test rather than shell in YAML,
 * and it fails loud on anything that is not the documented shape: a workflow
 * that cannot name what it published must be red, not green-with-a-gap.
 *
 * Output protocol: one `name<TAB>version` line per published package on
 * stdout. The tab separator cannot appear in either field (both are validated
 * against patterns that exclude whitespace), so the consumer's `IFS=$'\t'
 * read` cannot split a field in half the way `%@*`/`##*@` splitting can.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEPLOY_LEDGER_VERSION_PATTERN } from '../deploy-ledger.mjs';

/** npm package names: `pkg` or `@scope/pkg`, no whitespace, no shell
 * metacharacters, no JSON punctuation. */
const PACKAGE_NAME_PATTERN =
  /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;

/**
 * Parse the raw `published-packages` value into `{ name, version }` pairs.
 * Throws (with a teaching message) on empty, unparseable, or structurally
 * wrong input; never returns a partial list.
 */
export function parsePublishedPackages(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(
      'published-packages output is empty. A run that reports published == true must name the packages it published; an empty value here means the changesets step\u2019s outputs changed shape and this parse must be updated, not skipped.',
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `published-packages output is not valid JSON: ${raw.slice(0, 120)}${raw.length > 120 ? '\u2026' : ''} \u2014 the changesets action emits a compact single-line JSON array ([{"name":"@scope/pkg","version":"1.2.0"},\u2026]), never newline name@version lines. Parse it as JSON (scripts/lib/parse-published-packages.mjs); text-splitting it fabricates version fields.`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `published-packages output must be a JSON array; got ${typeof parsed}: ${raw.slice(0, 120)}`,
    );
  }
  if (parsed.length === 0) {
    throw new Error(
      'published-packages output is an empty array. A run that reports published == true must have published at least one package.',
    );
  }
  return parsed.map((element, index) => {
    if (
      typeof element !== 'object' ||
      element === null ||
      Array.isArray(element)
    ) {
      throw new Error(
        `published-packages element ${index} must be an object with name and version: ${JSON.stringify(element)}`,
      );
    }
    const { name, version } = element;
    if (typeof name !== 'string' || !PACKAGE_NAME_PATTERN.test(name)) {
      throw new Error(
        `published-packages element ${index} has no valid package name: ${JSON.stringify(name)}`,
      );
    }
    if (
      typeof version !== 'string' ||
      !DEPLOY_LEDGER_VERSION_PATTERN.test(version)
    ) {
      throw new Error(
        `published-packages element ${index} (${name}) has no valid version: ${JSON.stringify(version)} \u2014 versions are alphanumeric plus . + ~ - only`,
      );
    }
    return { name, version };
  });
}

function main(argv) {
  if (argv.length !== 1) {
    console.error(
      'usage: node scripts/lib/parse-published-packages.mjs <published-packages JSON>',
    );
    return 1;
  }
  let packages;
  try {
    packages = parsePublishedPackages(argv[0]);
  } catch (error) {
    console.error(`::error::${error.message}`);
    return 1;
  }
  for (const { name, version } of packages) {
    process.stdout.write(`${name}\t${version}\n`);
  }
  return 0;
}

// realpathSync both sides: an unresolved argv[1] under a symlinked workspace
// makes this compare false, the script imports as a module, and it exits 0
// having recorded nothing — the exact silent-unrecorded-ship gap this
// feature exists to close (delta review LOW-A).
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exit(main(process.argv.slice(2)));
}
