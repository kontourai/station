/**
 * Validate executable-looking examples in the explicitly admitted public docs.
 *
 * This is deliberately a parser, not a shell runner: product documentation can
 * name mutation-capable commands, but the documentation gate must never invoke
 * them. Each authority is read from its canonical checked-in producer.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadPublicDocs } from './build-github-pages.mjs';
import { parseJustInterface } from './just-interface.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const CLI_COMMAND_ARRAYS = [
  'CORE_COMMANDS',
  'SURFACE_COMMANDS',
  'INDIVIDUAL_COMMANDS',
];
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const SAFE_NPM_COMMANDS = new Set(['ci']);
const ALLOWED_STATION_PLACEHOLDERS = new Set(['"$@"', '$@']);

function read(root, file) {
  return readFileSync(resolve(root, file), 'utf8');
}

function quotedValues(source) {
  return [...source.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

function boundedArray(source, name) {
  const match = source.match(
    new RegExp(`const ${name} = \\[([\\s\\S]*?)\\] as const;`),
  );
  if (!match) throw new Error(`CLI registry array '${name}' is missing.`);
  return quotedValues(match[1]);
}

export function cliAuthority(root = ROOT) {
  const cli = read(root, 'packages/cli/src/cli.ts');
  const help = read(root, 'packages/cli/src/help.ts');
  const registry = new Set(
    CLI_COMMAND_ARRAYS.flatMap((name) => boundedArray(cli, name)),
  );
  const documented = new Set(
    [
      ...help.matchAll(/^ {2}(?:(['"])([a-z][a-z-]*)\1|([a-z][a-z-]*)): \{/gm),
    ].map((match) => match[2] ?? match[3]),
  );
  for (const command of registry) {
    if (!documented.has(command))
      throw new Error(`CLI registry command '${command}' has no help entry.`);
  }
  return registry;
}

export function routeAuthority(root = ROOT) {
  const source = JSON.parse(read(root, 'docs/reference/openapi.json'));
  if (!source?.paths || typeof source.paths !== 'object')
    throw new Error('Generated OpenAPI route inventory is missing paths.');
  const routes = new Set();
  for (const [path, operations] of Object.entries(source.paths)) {
    if (!operations || typeof operations !== 'object') continue;
    for (const method of Object.keys(operations)) {
      const upper = method.toUpperCase();
      if (!HTTP_METHODS.has(upper)) continue;
      routes.add(`${upper} ${path.replaceAll(/\{([^}]+)\}/g, ':$1')}`);
    }
  }
  return routes;
}

function codeLines(text) {
  const lines = [];
  for (const match of text.matchAll(
    /```(?:sh|bash|zsh|bat|cmd)\r?\n([\s\S]*?)```/g,
  )) {
    const body = match[1];
    for (const [index, line] of body.split(/\r?\n/).entries())
      lines.push({ line: index + 1, text: line.trim() });
  }
  return lines;
}

function stationExample(line) {
  const match = line.match(/^(?:\.\/station|station)\s+([a-z][a-z-]*)\b(.*)$/);
  if (!match) return null;
  return { command: match[1], rest: match[2] };
}

function justExample(line) {
  const match = line.match(/^just\s+([a-z][a-z-]*)\b/);
  return match ? match[1] : null;
}

function npmExample(line) {
  const match = line.match(/^npm\s+(ci|run\s+([a-z][a-z0-9:_-]*))\b/);
  if (!match) return null;
  return match[2] ? { kind: 'run', name: match[2] } : { kind: match[1] };
}

function httpExample(line) {
  const match = line.match(/^(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s`]+)/);
  return match ? `${match[1]} ${match[2]}` : null;
}

function stationPlaceholdersAreAllowed(rest) {
  const placeholders =
    rest.match(
      /"\$[A-Za-z_@][A-Za-z0-9_@]*"|\$\{[^}\r\n]+\}|\$[A-Za-z_@][A-Za-z0-9_@]*/g,
    ) ?? [];
  return placeholders.every((placeholder) =>
    ALLOWED_STATION_PLACEHOLDERS.has(placeholder),
  );
}

/**
 * @param {{source: string, text?: string}[]} documents
 * @param {{root?: string}} [options]
 */
export function publicDocContractExampleFindings(
  documents,
  { root = ROOT } = {},
) {
  const findings = [];
  const cli = cliAuthority(root);
  const recipes = new Set(
    parseJustInterface(read(root, 'justfile')).map((recipe) => recipe.name),
  );
  const scripts = JSON.parse(read(root, 'package.json')).scripts;
  const routes = routeAuthority(root);

  for (const document of documents) {
    const text = document.text ?? read(root, `docs/${document.source}`);
    for (const { line, text: example } of codeLines(text)) {
      const location = `${document.source}:${line}`;
      const station = stationExample(example);
      if (station) {
        if (!cli.has(station.command))
          findings.push(
            `${location} unknown Station CLI command '${station.command}'.`,
          );
        if (!stationPlaceholdersAreAllowed(station.rest))
          findings.push(
            `${location} has an unapproved Station shell placeholder.`,
          );
        continue;
      }
      const recipe = justExample(example);
      if (recipe) {
        if (!recipes.has(recipe))
          findings.push(`${location} unknown Just recipe '${recipe}'.`);
        continue;
      }
      const npm = npmExample(example);
      if (npm) {
        if (npm.kind === 'run' && typeof scripts[npm.name] !== 'string')
          findings.push(`${location} unknown npm script '${npm.name}'.`);
        if (npm.kind !== 'run' && !SAFE_NPM_COMMANDS.has(npm.kind))
          findings.push(`${location} unapproved npm command '${npm.kind}'.`);
        continue;
      }
      const route = httpExample(example);
      if (route && !routes.has(route))
        findings.push(`${location} unknown HTTP route '${route}'.`);
    }
  }
  return findings;
}

export async function runPublicDocContractExamples() {
  const documents = await loadPublicDocs();
  const findings = publicDocContractExampleFindings(documents);
  if (findings.length === 0) {
    console.log(
      `Public documentation command and route examples passed for ${documents.length} admitted documents.`,
    );
    return 0;
  }
  console.error(
    `Public documentation command and route examples failed:\n${findings.map((finding) => `- ${finding}`).join('\n')}`,
  );
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`)
  process.exitCode = await runPublicDocContractExamples();
