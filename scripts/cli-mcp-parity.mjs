#!/usr/bin/env node
// Every Station Control tool and every `station` CLI action is classified in
// scripts/cli-mcp-parity.json: a counterpart on the other side, a deliberate
// exemption, or a gap tracked by an issue. Before this check, the two
// surfaces were mapped once by hand and nothing noticed a new tool shipping
// with no CLI action, or a CLI verb no agent could reach.
//
// The tool list is the authority table (STATION_CONTROL_TOOL_POLICY), the
// CLI list is help.ts's knownCommands()/actionsFor(): the same registries
// the server and the CLI dispatch from, loaded rather than pattern-matched.
//
// The `missing` set may only shrink: an entry classified `missing` that was
// not `missing` at the merge base with origin/main fails. It is keyed by
// name, never counted, so concurrent PRs that close different gaps cannot
// fail each other. The `app` section (capabilities only the web app offers)
// is curated by hand and outside the ratchet, so recording a newly found app
// gap never fails.
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { execFileSyncBounded } from './lib/bounded-capture.mjs';
import { mergeBaseWith } from './lib/git-ref.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFEST_PATH = 'scripts/cli-mcp-parity.json';
const BASE_REF = 'origin/main';

/** Why a capability deliberately has no counterpart. Closed on purpose. */
export const EXEMPT_CATEGORIES = Object.freeze([
  // Acts on the calling agent's own Session or turn; needs a caller.
  'agent-self',
  // An agent proposes; a person completes with the named CLI action.
  'agent-proposal',
  // Drives a person's open UI or the agent's own chat surface.
  'agent-ui',
  // State the CLI keeps on this device (saved Stations, default target).
  'client-local',
  // A TUI or realtime session for a person at a keyboard or microphone.
  'interactive',
  // This machine's install, files, or processes; not a Station API.
  'local-host',
  // A person's credential, consent, sign-in, pairing, inbox, or judgment.
  'person-only',
  // Presentation data for UI chrome.
  'presentation',
]);

const SECTIONS = ['app', 'cli', 'tools'];
const ROUTE = /^(GET|POST|PUT|PATCH|DELETE) \/\S*$/;

async function importTs(path) {
  return tsImport(pathToFileURL(resolve(repoRoot, path)).href, import.meta.url);
}

/** The two real surfaces, from the registries they dispatch from. */
export async function loadSurfaces() {
  const help = await importTs('packages/cli/src/help.ts');
  const policy = await importTs('src-server/tools/station-control-policy.ts');
  const verbs = help.knownCommands();
  const cli = verbs.flatMap(
    (verb) =>
      help.actionsFor(verb)?.map((action) => `${verb} ${action}`) ?? [verb],
  );
  return {
    tools: Object.keys(policy.STATION_CONTROL_TOOL_POLICY),
    cli,
    verbs,
  };
}

function isSingleLine(value) {
  return (
    typeof value === 'string' && value.trim() !== '' && !value.includes('\n')
  );
}

/**
 * Every rule except the ratchet. `surfaces` is `{tools, cli, verbs}`; a CLI
 * counterpart may name an enumerated `verb action` or a bare verb (the bare
 * `station delegate <agent> <message>` form creates).
 */
export function validateManifest(manifest, surfaces) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return [`${MANIFEST_PATH} must be a JSON object.`];
  }
  const topKeys = Object.keys(manifest);
  if (topKeys.join() !== SECTIONS.join()) {
    errors.push(
      `top-level keys must be exactly ${SECTIONS.join(', ')} in that order; found ${topKeys.join(', ') || 'none'}.`,
    );
  }
  const toolSet = new Set(surfaces.tools);
  const cliSet = new Set(surfaces.cli);
  const cliRefSet = new Set([...surfaces.cli, ...surfaces.verbs]);
  const counterpartRefs = {
    cli: { known: cliRefSet, label: 'CLI action' },
    tools: { known: toolSet, label: 'Station Control tool' },
  };

  const checkRefs = (where, field, refs) => {
    if (!Array.isArray(refs) || refs.length === 0) {
      errors.push(`${where}: "${field}" must be a non-empty array.`);
      return;
    }
    if (new Set(refs).size !== refs.length)
      errors.push(`${where}: "${field}" lists a name twice.`);
    for (const ref of refs) {
      if (!counterpartRefs[field].known.has(ref))
        errors.push(
          `${where}: counterpart ${counterpartRefs[field].label} "${ref}" does not exist.`,
        );
    }
  };

  const checkEntry = (section, name, entry) => {
    const where = `${section} "${name}"`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${where}: entry must be an object.`);
      return;
    }
    const counterpartField = section === 'tools' ? 'cli' : 'tools';
    const allowed = new Set(['exempt', 'reason', 'missing', 'want', 'note']);
    if (section === 'app') {
      allowed.add('route');
      allowed.add('cli');
      allowed.add('tools');
    } else allowed.add(counterpartField);
    for (const key of Object.keys(entry)) {
      if (!allowed.has(key)) errors.push(`${where}: unknown field "${key}".`);
    }
    for (const key of ['note', 'want']) {
      if (key in entry && !isSingleLine(entry[key]))
        errors.push(`${where}: "${key}" must be a non-empty single line.`);
    }
    if (
      section === 'app' &&
      !(typeof entry.route === 'string' && ROUTE.test(entry.route))
    )
      errors.push(`${where}: "route" must read "<METHOD> /path".`);

    const kinds = [];
    if ('exempt' in entry) kinds.push('exempt');
    if ('missing' in entry) kinds.push('missing');
    const counterparts =
      section === 'app'
        ? ['cli', 'tools'].filter((field) => field in entry)
        : counterpartField in entry
          ? [counterpartField]
          : [];
    for (const field of counterparts) checkRefs(where, field, entry[field]);
    // An app capability is covered only once both sides exist; a partial
    // counterpart rides along with its `missing` issue.
    const complete =
      section === 'app' ? counterparts.length === 2 : counterparts.length === 1;
    if (complete) kinds.push('counterpart');
    if (
      section === 'app' &&
      counterparts.length > 0 &&
      kinds.includes('exempt')
    )
      errors.push(`${where}: an exempt capability names no counterpart.`);
    if (kinds.length !== 1) {
      errors.push(
        kinds.length === 0
          ? `${where}: classify it as a counterpart ("${section === 'app' ? 'cli" and "tools' : counterpartField}"), "exempt" with a "reason", or "missing" with a tracking issue number.`
          : `${where}: has more than one classification (${kinds.join(', ')}).`,
      );
      return;
    }
    if (kinds[0] === 'exempt') {
      if (!EXEMPT_CATEGORIES.includes(entry.exempt))
        errors.push(
          `${where}: exempt category "${entry.exempt}" is not one of ${EXEMPT_CATEGORIES.join(', ')}.`,
        );
      if (!isSingleLine(entry.reason))
        errors.push(`${where}: an exemption needs a one-line "reason".`);
    } else if ('reason' in entry) {
      errors.push(`${where}: "reason" belongs only to an exemption.`);
    }
    if (kinds[0] === 'missing') {
      if (!Number.isSafeInteger(entry.missing) || entry.missing <= 0)
        errors.push(
          `${where}: "missing" must be the tracking issue number (a positive integer).`,
        );
    }
  };

  const enumerated = { cli: cliSet, tools: toolSet };
  for (const section of SECTIONS) {
    const entries = manifest[section];
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
      errors.push(`section "${section}" must be an object.`);
      continue;
    }
    const names = Object.keys(entries);
    const sorted = [...names].sort();
    const firstUnsorted = names.findIndex(
      (name, index) => name !== sorted[index],
    );
    if (firstUnsorted !== -1)
      errors.push(
        `section "${section}" keys must be sorted; "${names[firstUnsorted]}" is out of order (expected "${sorted[firstUnsorted]}").`,
      );
    for (const name of names) {
      if (section !== 'app' && !enumerated[section].has(name))
        errors.push(
          `${section} "${name}" is stale: no such ${section === 'cli' ? 'CLI action' : 'Station Control tool'} exists. Remove the entry.`,
        );
      checkEntry(section, name, entries[name]);
    }
    if (section !== 'app') {
      for (const name of enumerated[section]) {
        if (!(name in entries))
          errors.push(
            `${section} "${name}" is unclassified. Add an entry to ${MANIFEST_PATH}.`,
          );
      }
    }
  }
  return errors;
}

/** Ratcheted names: `missing` entries in the enumerated sections. */
export function missingKeys(manifest) {
  const keys = new Set();
  for (const section of ['cli', 'tools']) {
    for (const [name, entry] of Object.entries(manifest?.[section] ?? {})) {
      if (entry && typeof entry === 'object' && 'missing' in entry)
        keys.add(`${section} "${name}"`);
    }
  }
  return keys;
}

/** Names newly classified `missing` since `base` (null: no base manifest). */
export function missingGrowth(manifest, base) {
  if (base === null) return [];
  const before = missingKeys(base);
  return [...missingKeys(manifest)].filter((key) => !before.has(key));
}

function git(args) {
  return execFileSyncBounded('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

/**
 * The manifest at `ref`, or null when the ref exists and the file does not
 * (the change introducing it). An unresolvable ref fails: without a base the
 * ratchet cannot run, and silently skipping it would let the set grow.
 */
export function readBaseManifest(ref) {
  try {
    git(['rev-parse', '--verify', `${ref}^{commit}`]);
  } catch {
    throw new Error(
      `cannot resolve the ratchet base "${ref}". Fetch ${BASE_REF} or pass --base=<ref>.`,
    );
  }
  try {
    git(['cat-file', '-e', `${ref}:${MANIFEST_PATH}`]);
  } catch {
    return null;
  }
  return JSON.parse(git(['show', `${ref}:${MANIFEST_PATH}`]));
}

function parseArgs(argv) {
  const options = {
    manifest: resolve(repoRoot, MANIFEST_PATH),
    base: undefined,
  };
  for (const arg of argv) {
    if (arg.startsWith('--manifest='))
      options.manifest = resolve(arg.slice(11));
    else if (arg.startsWith('--base=') && arg.length > 7)
      options.base = arg.slice(7);
    else
      throw new Error(
        `Usage: node scripts/cli-mcp-parity.mjs [--base=<ref>] [--manifest=<path>]; unknown argument ${arg}`,
      );
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  let manifest;
  try {
    options = parseArgs(argv);
    manifest = JSON.parse(readFileSync(options.manifest, 'utf8'));
  } catch (error) {
    console.error(
      `FAIL: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 2;
  }
  let surfaces;
  try {
    surfaces = await loadSurfaces();
  } catch (error) {
    console.error(
      `FAIL: cannot load the tool or CLI registry: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 2;
  }
  const errors = validateManifest(manifest, surfaces);
  // The merge base, never origin/main's tip: against the tip, a gap main
  // closed after this branch was cut would read as one this branch opened.
  const baseRef =
    options.base ?? mergeBaseWith(BASE_REF, (args) => git(args).trim());
  let base;
  try {
    if (!baseRef)
      throw new Error(
        `cannot find the merge base with ${BASE_REF}. Fetch it with full history or pass --base=<ref>.`,
      );
    base = readBaseManifest(baseRef);
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    return 1;
  }
  for (const key of missingGrowth(manifest, base)) {
    errors.push(
      `${key} is newly classified missing (not missing at ${baseRef}). The missing set may only shrink: build the counterpart, or exempt it with a reason.`,
    );
  }
  const shown = relative(repoRoot, options.manifest) || options.manifest;
  if (errors.length > 0) {
    console.error(
      `FAIL: CLI ↔ Station Control parity (${shown}):\n${errors.map((error) => `- ${error}`).join('\n')}`,
    );
    return 1;
  }
  const missing = missingKeys(manifest).size;
  console.log(
    `CLI ↔ Station Control parity passed: ${surfaces.tools.length} tools and ${surfaces.cli.length} CLI actions classified; ${missing} tracked as missing; ratchet base ${baseRef}${base === null ? ' has no manifest yet, so nothing to ratchet against' : ''}.`,
  );
  return 0;
}

if (invokedDirectly(import.meta.url)) process.exitCode = await main();
