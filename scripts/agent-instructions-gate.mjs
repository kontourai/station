import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import {
  dirname,
  isAbsolute,
  posix,
  relative,
  resolve,
  win32,
} from 'node:path';
import { getEncoding } from 'js-tiktoken';
import {
  COMBINED_BUDGET,
  GENERATED_BLOCK_OWNERS,
  GOVERNANCE_BLOCK,
  REQUIRED_INSTRUCTION_FILES,
  ROOT_BUDGET,
  ROOT_UNIVERSAL_MARKERS,
  SCOPE_BUDGET,
  SCOPE_REQUIRED_MARKERS,
  SCOPES,
  scopeForPath,
} from './agent-instructions-manifest.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const IMPORT = /^\s*@([^\s]+)\s*$/gm;
const MARKERS = Object.keys(GENERATED_BLOCK_OWNERS).map((name) =>
  Object.freeze({
    name,
    start: `<!-- station:${name}:start -->`,
    end: `<!-- station:${name}:end -->`,
  }),
);

function byteLength(text) {
  return Buffer.byteLength(text, 'utf8');
}
function lineCount(text) {
  return text === '' ? 0 : text.split(/\r?\n/).length;
}
export function canonicalInstructionPath(value) {
  return value.replaceAll('\\', '/');
}
function repoRelative(root, target) {
  return canonicalInstructionPath(relative(root, target));
}
function budgetErrors(file, text, budget, encoder) {
  const counts = {
    bytes: byteLength(text),
    lines: lineCount(text),
    tokens: encoder.encode(text).length,
  };
  return Object.entries(budget).flatMap(([kind, limit]) =>
    counts[kind] > limit
      ? [`${file} exceeds ${kind} budget (${counts[kind]} > ${limit})`]
      : [],
  );
}
export function escapesRoot(
  root,
  target,
  relativePath = relative(root, target),
) {
  return (
    relativePath === '..' ||
    relativePath.startsWith('../') ||
    relativePath.startsWith('..\\') ||
    isAbsolute(relativePath) ||
    win32.isAbsolute(relativePath)
  );
}
function safeRead(
  root,
  file,
  readFile = readFileSync,
  stat = statSync,
  realpath = realpathSync,
) {
  const target = resolve(root, file);
  if (escapesRoot(root, target))
    throw new Error(`instruction path escapes root: ${file}`);
  const info = stat(target);
  if (!info.isFile())
    throw new Error(`instruction target is not a regular file: ${file}`);
  if (readFile === readFileSync || realpath !== realpathSync) {
    const physicalRoot = realpath(root);
    const physicalTarget = realpath(target);
    if (escapesRoot(physicalRoot, physicalTarget))
      throw new Error(`instruction realpath escapes root: ${file}`);
  }
  const text = readFile(target, 'utf8');
  if (text.trim() === '') throw new Error(`instruction file is empty: ${file}`);
  return text;
}
function importsFor(file, text) {
  return [...text.matchAll(IMPORT)].map((match) => ({
    from: file,
    path: match[1],
  }));
}
/** @param {string} file @param {any} options */
export function resolveClaudeImports(
  file,
  { root = ROOT, readFile, stat, realpath } = {},
) {
  const visited = new Set();
  const files = [];
  function visit(current) {
    if (visited.has(current))
      throw new Error(
        `instruction import cycle: ${[...visited, current].join(' -> ')}`,
      );
    visited.add(current);
    files.push(current);
    const text = safeRead(root, current, readFile, stat, realpath);
    for (const entry of importsFor(current, text)) {
      if (entry.path.startsWith('/') || entry.path.includes('\\'))
        throw new Error(`unsupported instruction import: ${entry.path}`);
      const next = posix.normalize(
        posix.join(posix.dirname(current), entry.path),
      );
      if (entry.path.includes('../') || next === '..' || next.startsWith('../'))
        throw new Error(`instruction import escapes root: ${entry.path}`);
      visit(next);
    }
    visited.delete(current);
  }
  visit(file);
  return files;
}

const DISCOVERY_IGNORES = new Set(['.git', 'node_modules', 'vendor']);
function isGeneratedDirectory(relativePath) {
  return (
    relativePath === 'src-desktop/gen' ||
    relativePath.startsWith('src-desktop/gen/')
  );
}
/** Recurses the on-disk tree so untracked descendants are part of the contract. */
/** @param {any} options */
export function discoverOnDiskInstructionFiles({
  root = ROOT,
  readDirectory = readdirSync,
} = {}) {
  const found = [];
  function visit(directory, relativeDirectory = '') {
    for (const entry of readDirectory(directory, { withFileTypes: true })) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      if (entry.isSymbolicLink()) {
        let redirected;
        try {
          redirected = statSync(resolve(directory, entry.name));
        } catch {
          redirected = null;
        }
        if (redirected?.isDirectory())
          throw new Error(`redirected instruction directory: ${relativePath}`);
      }
      if (entry.isDirectory()) {
        if (
          !DISCOVERY_IGNORES.has(entry.name) &&
          !isGeneratedDirectory(relativePath)
        )
          visit(resolve(directory, entry.name), relativePath);
      } else if (/^(?:AGENTS(?:\.override)?|CLAUDE)\.md$/.test(entry.name))
        found.push(relativePath);
    }
  }
  visit(root);
  return found.sort();
}

function contents(files, root, options) {
  return files.flatMap((file) => {
    const text = safeRead(
      root,
      file,
      options.readFile,
      options.stat,
      options.realpath,
    );
    if (file.endsWith('CLAUDE.md'))
      return resolveClaudeImports(file, options).map((imported) => ({
        file: imported,
        text: safeRead(
          root,
          imported,
          options.readFile,
          options.stat,
          options.realpath,
        ),
      }));
    return [{ file, text }];
  });
}
/** Filesystem-backed loader conformance: startup differs from explicit routed reads. */
/** @param {any} options */
export function resolveEffectiveInstructions({
  path = '.',
  harness = 'codex',
  cwd = '.',
  root = ROOT,
  ...options
} = {}) {
  const exists = (file) => {
    try {
      return (options.stat ?? statSync)(resolve(root, file)).isFile();
    } catch {
      return false;
    }
  };
  if (harness === 'codex') {
    const startup = resolveCodexStartup({ cwd, exists });
    const routed = [
      'AGENTS.md',
      ...scopeForPath(path).map(({ directory }) => `${directory}/AGENTS.md`),
    ];
    return {
      startup: contents(startup, root, { root, ...options }),
      routed: contents(routed, root, { root, ...options }),
    };
  }
  if (harness === 'claude') {
    const startup = resolveClaudeStartup({ cwd, exists });
    const routed = [
      'CLAUDE.md',
      ...scopeForPath(path).map(({ directory }) => `${directory}/CLAUDE.md`),
    ];
    return {
      startup: contents(startup, root, { root, ...options }),
      routed: contents(routed, root, { root, ...options }),
    };
  }
  throw new Error(`unsupported harness: ${harness}`);
}

function selectedInstruction(directory, exists, fallback = []) {
  for (const name of ['AGENTS.override.md', 'AGENTS.md', ...fallback])
    if (exists(posix.join(directory, name))) return posix.join(directory, name);
  return null;
}
/** Documented Codex startup chain: Git root through the launch CWD, once. */
/** @param {any} options */
export function resolveCodexStartup({
  cwd = '.',
  exists = () => false,
  fallback = [],
} = {}) {
  const segments = cwd === '.' ? [] : cwd.split('/').filter(Boolean);
  const directories = ['.'];
  for (let index = 1; index <= segments.length; index += 1)
    directories.push(segments.slice(0, index).join('/'));
  return directories
    .map((directory) => selectedInstruction(directory, exists, fallback))
    .filter(Boolean);
}
/** Documented Claude startup: ancestor CLAUDE files, with imports expanded on read. */
/** @param {any} options */
export function resolveClaudeStartup({ cwd = '.', exists = () => false } = {}) {
  const segments = cwd === '.' ? [] : cwd.split('/').filter(Boolean);
  const directories = ['.'];
  for (let index = 1; index <= segments.length; index += 1)
    directories.push(segments.slice(0, index).join('/'));
  return directories
    .map((directory) => posix.join(directory, 'CLAUDE.md'))
    .filter(exists);
}

function localLinkErrors(file, text, root, exists = statSync) {
  const errors = [];
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].replace(/^<|>$/g, '');
    if (/^(?:https?:|mailto:|#)/.test(target)) continue;
    const [path, fragment] = target.split('#', 2);
    const resolved = resolve(dirname(resolve(root, file)), path);
    let targetExists = false;
    try {
      targetExists = exists(resolved).isFile();
    } catch {
      targetExists = false;
    }
    if (relative(root, resolved).startsWith('..') || !targetExists) {
      errors.push(`${file} has broken instruction link '${target}'`);
      continue;
    }
    if (fragment) {
      const headings =
        readFileSync(resolved, 'utf8').match(/^#+\s+(.+)$/gm) ?? [];
      const slugs = headings.map((heading) =>
        heading
          .replace(/^#+\s+/, '')
          .toLowerCase()
          .replace(/[^\w\s-]/g, '')
          .trim()
          .replace(/\s+/g, '-'),
      );
      if (!slugs.includes(fragment))
        errors.push(`${file} has broken instruction fragment '${target}'`);
    }
  }
  return errors;
}

/** @param {any} options */
export function instructionGateErrors({
  root = ROOT,
  readFile,
  stat,
  realpath,
  trackedFiles,
  instructionFiles,
  encoder = getEncoding('o200k_base'),
} = {}) {
  const errors = [];
  const textByFile = new Map();
  for (const directory of [
    '',
    ...SCOPES.map(({ directory: value }) => value),
  ]) {
    const override = resolve(root, directory, 'AGENTS.override.md');
    try {
      if ((stat ?? statSync)(override).isFile())
        errors.push(
          `unsupported instruction override: ${repoRelative(root, override)}`,
        );
    } catch {
      // Absence is expected; only a concrete override changes the declared topology.
    }
  }
  for (const file of REQUIRED_INSTRUCTION_FILES) {
    try {
      textByFile.set(file, safeRead(root, file, readFile, stat, realpath));
    } catch (error) {
      errors.push(error.message);
    }
  }
  for (const file of REQUIRED_INSTRUCTION_FILES.filter((file) =>
    file.endsWith('/CLAUDE.md'),
  )) {
    const expected = '@AGENTS.md\n';
    if (textByFile.has(file) && textByFile.get(file) !== expected)
      errors.push(`${file} must be the exact @AGENTS.md import`);
  }
  const rootClaude = textByFile.get('CLAUDE.md');
  if (rootClaude && rootClaude !== `@AGENTS.md\n\n${GOVERNANCE_BLOCK}`)
    errors.push(
      'CLAUDE.md must be the root AGENTS wrapper plus the canonical governance block',
    );
  const rootAgents = textByFile.get('AGENTS.md');
  if (
    rootAgents &&
    (!rootAgents.endsWith(GOVERNANCE_BLOCK) ||
      rootAgents.split(GOVERNANCE_BLOCK).length !== 2)
  )
    errors.push('AGENTS.md must retain exactly one canonical governance block');
  for (const [file, text] of textByFile) {
    errors.push(
      ...budgetErrors(
        file,
        text,
        file === 'AGENTS.md' ? ROOT_BUDGET : SCOPE_BUDGET,
        encoder,
      ),
    );
    errors.push(...localLinkErrors(file, text, root));
    if (file.endsWith('/CLAUDE.md') || file === 'CLAUDE.md') {
      try {
        resolveClaudeImports(file, { root, readFile, stat, realpath });
      } catch (error) {
        errors.push(error.message);
      }
    }
    if (file.endsWith('AGENTS.md'))
      for (const marker of MARKERS) {
        if (text.includes(marker.start) || text.includes(marker.end))
          errors.push(`${file} must not own generated ${marker.name} policy`);
      }
    if (file.endsWith('AGENTS.md') && [...text.matchAll(IMPORT)].length > 0)
      errors.push(`${file} must not import instruction scopes`);
  }
  const rootText = textByFile.get('AGENTS.md');
  if (
    rootText &&
    /\b(?:current|active)\s+(?:roadmap|backlog|work)\b|\bstation#\d+\b/i.test(
      rootText,
    )
  )
    errors.push(
      'AGENTS.md must not make roadmap, backlog, or current-state claims',
    );
  if (rootText)
    for (const marker of ROOT_UNIVERSAL_MARKERS)
      if (!rootText.includes(marker))
        errors.push(`AGENTS.md is missing universal conduct '${marker}'`);
  for (const [directory, markers] of Object.entries(SCOPE_REQUIRED_MARKERS)) {
    const text = textByFile.get(`${directory}/AGENTS.md`);
    for (const marker of markers)
      if (!text?.includes(marker))
        errors.push(
          `${directory}/AGENTS.md is missing scoped conduct '${marker}'`,
        );
  }
  for (const scope of SCOPES) {
    const scopeText = textByFile.get(`${scope.directory}/AGENTS.md`);
    if (rootText && scopeText) {
      const combined = `${rootText}\n\n${scopeText}`;
      errors.push(
        ...budgetErrors(
          `AGENTS.md + ${scope.directory}/AGENTS.md`,
          combined,
          COMBINED_BUDGET,
          encoder,
        ),
      );
    }
  }
  for (const marker of MARKERS) {
    const owner = GENERATED_BLOCK_OWNERS[marker.name];
    let ownerText;
    try {
      ownerText = safeRead(root, owner, readFile, stat, realpath);
    } catch (error) {
      errors.push(error.message);
      continue;
    }
    const starts = ownerText.split(marker.start).length - 1;
    const ends = ownerText.split(marker.end).length - 1;
    if (starts !== 1 || ends !== 1)
      errors.push(`${owner} must contain exactly one ${marker.name} block`);
  }
  const tracked =
    trackedFiles ??
    String(
      execFileSync('git', ['ls-files', '-z'], {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
      }),
    )
      .split('\0')
      .filter(Boolean);
  let instructionLike = instructionFiles;
  try {
    instructionLike ??= discoverOnDiskInstructionFiles({ root });
  } catch (error) {
    errors.push(error.message);
    instructionLike = [];
  }
  for (const file of instructionLike)
    if (!REQUIRED_INSTRUCTION_FILES.includes(file))
      errors.push(`unsupported instruction file: ${file}`);
  for (const marker of MARKERS)
    for (const file of [
      ...new Set([
        ...tracked.filter((path) => path.endsWith('.md')),
        ...instructionLike,
      ]),
    ]) {
      if (file === GENERATED_BLOCK_OWNERS[marker.name]) continue;
      try {
        const text = safeRead(root, file, readFile, stat, realpath);
        if (text.includes(marker.start) || text.includes(marker.end))
          errors.push(`${file} must not copy generated ${marker.name} policy`);
      } catch {
        /* tracked unreadable docs fail their own documentation gates */
      }
    }
  encoder.free?.();
  return errors;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const errors = instructionGateErrors();
  if (errors.length) {
    console.error(
      `FAIL: instruction topology\n${errors.map((error) => `- ${error}`).join('\n')}`,
    );
    process.exitCode = 1;
  } else
    console.log(
      `OK: ${REQUIRED_INSTRUCTION_FILES.length} instruction files, ${SCOPES.length} routed scopes, o200k_base budgets enforced.`,
    );
}
