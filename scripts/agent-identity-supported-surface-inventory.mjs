#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INVENTORY_PATH = join(
  ROOT,
  'docs/plans/agent-identity-supported-surface-inventory.md',
);
const ROOTS = [
  'packages',
  'src-server',
  'src-ui',
  'src-desktop',
  'schemas',
  'tests',
];
const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
]);
const LEGACY_LITERAL_PATTERN = /__agent:|__acp:/g;
const CONSTRUCTED_LEGACY_LITERAL_PATTERN =
  /(?:['"]__(?:agent|acp)['"]\s*\+\s*['"]:['"]|\[\s*['"]__(?:agent|acp)['"]\s*,\s*['"]:['"]\s*\]\.join\s*\()/g;
const SYNTHETIC_AGENT_LITERAL_PATTERN =
  /\bslug\s*:\s*(?:`acp:\$\{|['"]acp:[^'"]+['"])/g;
const COLON_AGENT_PARSER_PATTERN =
  /\b(?:agent\.slug|agentId|agentSlug|selectedSlug|slug)\s*\.\s*(?:includes|split)\(\s*['"]:['"]|\.endsWith\(\s*`:\$\{(?:agentId|agentSlug|slug)\}`\s*\)/g;
const PLUGIN_AGENT_CONSTRUCTION_PATTERN =
  /`\$\{(?:manifest\.name|pluginName)\}:\$\{agent\.slug\}`/g;
const LEGACY_SYMBOLS = [
  'ACP_AGENT_SLUG_PREFIX',
  'AGENT_RUNTIME_SLUG_PREFIX',
  'AgentSlugAlias',
  'AgentSlugAliasMap',
  'AgentSlugAliasRecord',
  'AgentAliasLockOutcome',
  'acquireAgentAliasLockOnce',
  'acpIdFromSlug',
  'agentSlugAliases',
  'agentSlugsMatch',
  'canonicalAgentSlug',
  'clearAliasTombstone',
  'isAcpAgentSlug',
  'isRuntimeAgentSlug',
  'liveAgentAliases',
  'loadAgentAliasMap',
  'markAliasDeleted',
  'migrateLegacyAgentSpec',
  'onACPConnectionsSettled',
  'parseAgentSlug',
  'releaseAgentAliasLock',
  'resolveAgentName',
  'runDefaultAgentPromotionMigration',
  'runtimeIdFromSlug',
  'saveAgentAliasMap',
  'toAcpAgentSlug',
  'toRuntimeAgentSlug',
  'withAgentAliasLockAsync',
  '_setLayoutContextResolver',
  'agentDirName',
  'useResolveAgent',
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

function codeWithoutCommentsOrStrings(source) {
  return withoutComments(source).replace(
    /(['"])(?:\\.|(?!\1)[^\\\n])*\1/g,
    ' ',
  );
}

function legacyMatches(content, exemptLiteral) {
  const withoutSourceComments = withoutComments(content);
  const code = codeWithoutCommentsOrStrings(content);
  const literals = exemptLiteral
    ? []
    : [
        ...withoutSourceComments.matchAll(LEGACY_LITERAL_PATTERN),
        ...withoutSourceComments.matchAll(CONSTRUCTED_LEGACY_LITERAL_PATTERN),
        ...withoutSourceComments.matchAll(SYNTHETIC_AGENT_LITERAL_PATTERN),
        ...withoutSourceComments.matchAll(COLON_AGENT_PARSER_PATTERN),
        ...withoutSourceComments.matchAll(PLUGIN_AGENT_CONSTRUCTION_PATTERN),
      ];
  const symbolReferences = LEGACY_SYMBOLS.filter((symbol) =>
    new RegExp(`\\b${escapeRegExp(symbol)}\\b`).test(code),
  );
  return literals.length + symbolReferences.length;
}

export function parseInventory(markdown) {
  const match = markdown.match(
    /<!-- agent-identity-supported-surfaces:start -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- agent-identity-supported-surfaces:end -->/,
  );
  if (!match)
    throw new Error('Supported-surface inventory JSON block is missing.');

  const parsed = JSON.parse(match[1]);
  const entries = parsed.classifications ?? parsed;
  const classifications = new Map();
  for (const [classification, paths] of Object.entries(entries)) {
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new Error(
        `Inventory classification '${classification}' has no paths.`,
      );
    }
    for (const path of paths) {
      if (typeof path !== 'string' || !path) {
        throw new Error(
          `Inventory classification '${classification}' has an invalid path.`,
        );
      }
      if (classifications.has(path)) {
        throw new Error(`Inventory path is classified twice: ${path}`);
      }
      classifications.set(path, classification);
    }
  }
  const exemptions = new Map();
  for (const [path, reason] of Object.entries(parsed.exemptions ?? {})) {
    if (typeof reason !== 'string' || !reason.trim()) {
      throw new Error(`Inventory exemption '${path}' has no reason.`);
    }
    exemptions.set(path, reason);
  }
  return { classifications, exemptions };
}

async function sourceFiles(directory) {
  if (!existsSync(directory)) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (
      SOURCE_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.')))
    ) {
      files.push(path);
    }
  }
  return files;
}

export function analyzeInventory(
  classifications,
  files,
  exemptions = new Map(),
) {
  const seen = new Set();
  const unclassified = [];
  const findings = [];

  for (const { path, content } of files) {
    const matches = legacyMatches(content, exemptions.has(path));
    if (matches === 0) continue;
    const classification = classifications.get(path);
    if (!classification) {
      unclassified.push(path);
      continue;
    }
    seen.add(path);
    findings.push({ path, classification, matches });
  }

  return {
    findings: findings.sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
    stale: [...classifications.keys()].filter((path) => !seen.has(path)).sort(),
    unclassified: [...new Set(unclassified)].sort(),
    exemptions: [...exemptions.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  };
}

async function loadSourceFiles() {
  const paths = (
    await Promise.all(ROOTS.map((root) => sourceFiles(join(ROOT, root))))
  ).flat();
  return Promise.all(
    paths.map(async (path) => ({
      path: relative(ROOT, path),
      content: await readFile(path, 'utf8'),
    })),
  );
}

async function main() {
  const requireZero = process.argv.includes('--require-zero');
  const inventory = parseInventory(await readFile(INVENTORY_PATH, 'utf8'));
  const report = analyzeInventory(
    inventory.classifications,
    await loadSourceFiles(),
    inventory.exemptions,
  );

  for (const finding of report.findings) {
    console.log(
      `CLASSIFIED ${finding.classification} ${finding.path} (${finding.matches})`,
    );
  }
  for (const path of report.unclassified) console.error(`UNCLASSIFIED ${path}`);
  for (const path of report.stale) console.error(`STALE ${path}`);
  for (const [path, reason] of report.exemptions) {
    console.log(`EXEMPT ${path}: ${reason}`);
  }

  const classificationOk =
    report.unclassified.length === 0 && report.stale.length === 0;
  console.log(
    `CLASSIFICATION ${classificationOk ? 'GREEN' : 'RED'}: ${report.findings.length} classified, ${report.unclassified.length} unclassified, ${report.stale.length} stale`,
  );
  console.log(
    `CUTOVER ${report.findings.length === 0 ? 'GREEN' : 'RED'}: ${report.findings.length} remaining supported legacy paths`,
  );

  if (requireZero) {
    const finalZero =
      report.findings.length === 0 &&
      report.unclassified.length === 0 &&
      report.stale.length === 0;
    console.log(
      `FINAL ZERO ${finalZero ? 'GREEN' : 'RED'}: ${report.findings.length} findings, ${report.unclassified.length} unclassified, ${report.stale.length} stale`,
    );
  }

  if (!classificationOk || (requireZero && report.findings.length > 0)) {
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
