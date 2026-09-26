#!/usr/bin/env node
// Type-laundering gate: blocks NEW `as unknown as T` and `as any` casts in
// production surfaces. Existing sites live in the shrink-only baseline; a
// baseline entry may be removed, never added, and a covered site that
// disappears must drop its entry.
//
//   node scripts/type-laundering-gate.mjs                    # gate (exit 1 on new findings or baseline drift)
//   node scripts/type-laundering-gate.mjs --inventory        # JSON dump of current findings
//   node scripts/type-laundering-gate.mjs --update           # regenerate baseline from current findings
//
// The scan is line-based and deliberately simple: it sees textual casts, not
// every way to launder a type. It is a ratchet, not a type system.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const BASELINE_PATH = 'scripts/type-laundering-baseline.json';
const UPSTREAM_BASELINE_REF = 'origin/main';
const SCAN_ROOTS = [
  'src-shared',
  'src-server',
  'src-ui',
  'packages',
  'scripts',
  'examples',
];
const SKIP_DIR_NAMES = new Set([
  '__tests__',
  '__test-utils__',
  'node_modules',
  'dist',
  'gen',
]);
const RULES = [
  { rule: 'as-unknown', pattern: /\bas\s+unknown\s+as\b/ },
  { rule: 'as-any', pattern: /\bas\s+any\b/ },
];

export function fingerprintFor(rule, lineText) {
  return createHash('sha256')
    .update(`${rule}\n${lineText.trim()}`)
    .digest('hex');
}

function isSkippableLine(trimmed) {
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*')
  );
}

export function scanSource(text) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (isSkippableLine(trimmed)) continue;
    for (const { rule, pattern } of RULES) {
      if (pattern.test(line)) {
        findings.push({
          rule,
          line: index + 1,
          text: trimmed,
          fingerprint: fingerprintFor(rule, trimmed),
        });
      }
    }
  }
  return findings;
}

function isScannedFile(name) {
  return (
    /\.(ts|tsx|mts|mjs|js|jsx)$/.test(name) &&
    !/\.test\.[jt]sx?$/.test(name) &&
    !/\.d\.ts$/.test(name)
  );
}

export function collectFiles(root) {
  const files = [];
  for (const scanRoot of SCAN_ROOTS) {
    const absoluteRoot = join(root, scanRoot);
    if (!existsSync(absoluteRoot)) continue;
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (SKIP_DIR_NAMES.has(entry.name)) continue;
          walk(join(dir, entry.name));
        } else if (entry.isFile() && isScannedFile(entry.name)) {
          files.push(join(dir, entry.name));
        }
      }
    };
    walk(absoluteRoot);
  }
  return files.sort();
}

export function findFindings(root) {
  const findings = [];
  for (const file of collectFiles(root)) {
    const relativePath = relative(root, file).split(sep).join('/');
    for (const finding of scanSource(readFileSync(file, 'utf8'))) {
      findings.push({ file: relativePath, ...finding });
    }
  }
  return findings;
}

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readUpstreamBaseline() {
  try {
    const stdout = execFileSync(
      'git',
      ['show', `${UPSTREAM_BASELINE_REF}:${BASELINE_PATH}`],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    return JSON.parse(stdout);
  } catch {
    // Baseline not on upstream: this change introduces it, so every entry is
    // part of the introduction and none is an addition.
    return null;
  }
}

export function evaluate({ root }) {
  const errors = [];
  const warnings = [];
  const baselinePath = join(root, BASELINE_PATH);
  const current = findFindings(root);
  const baseline = existsSync(baselinePath)
    ? readJsonFile(baselinePath)
    : { version: 1, entries: [] };
  const baselineKeys = new Set(
    baseline.entries.map((entry) => `${entry.file}::${entry.fingerprint}`),
  );
  const upstream = readUpstreamBaseline();
  const upstreamKeys = new Set(
    (upstream?.entries ?? []).map(
      (entry) => `${entry.file}::${entry.fingerprint}`,
    ),
  );

  for (const finding of current) {
    if (baselineKeys.has(`${finding.file}::${finding.fingerprint}`)) continue;
    errors.push(
      `type-laundering: ${finding.rule} at ${finding.file}:${finding.line} is not in the baseline; fix the cast or justify a baseline entry in a reviewed change`,
    );
  }
  for (const entry of baseline.entries) {
    if (
      upstream !== null &&
      !upstreamKeys.has(`${entry.file}::${entry.fingerprint}`)
    ) {
      errors.push(
        `baseline entry cannot be added: ${entry.file} (${entry.rule}); a baseline entry may only shrink`,
      );
    }
    const stillPresent = current.some(
      (finding) =>
        finding.file === entry.file &&
        finding.fingerprint === entry.fingerprint,
    );
    if (!stillPresent) {
      errors.push(
        `stale baseline entry for ${entry.file} (${entry.rule}); remove it from ${BASELINE_PATH}`,
      );
    }
  }
  if (baseline.entries.length === 0 && upstream === null) {
    warnings.push('baseline is empty; this gate currently finds every cast');
  }
  return { errors, warnings, findings: current };
}

function main(argv) {
  const root = process.cwd();
  const flags = new Set(argv);
  const baselinePath = join(root, BASELINE_PATH);
  if (flags.has('--update')) {
    const findings = findFindings(root);
    const entries = findings.map((finding) => ({
      file: finding.file,
      rule: finding.rule,
      fingerprint: finding.fingerprint,
      reason: 'legacy-cast',
    }));
    writeFileSync(
      baselinePath,
      `${JSON.stringify(
        {
          version: 1,
          description:
            'Existing laundered casts. Entries may be removed, never added after this introduction. PASS does not qualify these sites.',
          entries,
        },
        null,
        2,
      )}\n`,
    );
    console.log(
      `[type-laundering] baseline written with ${entries.length} entries`,
    );
    return;
  }
  const result = evaluate({ root });
  if (flags.has('--inventory')) {
    console.log(JSON.stringify(result, null, 2));
  }
  for (const warning of result.warnings) console.warn(`WARN: ${warning}`);
  for (const error of result.errors) console.error(`FAIL: ${error}`);
  console.log(
    `[type-laundering] ${result.errors.length ? 'FAIL' : 'PASS'}; findings=${result.findings.length} errors=${result.errors.length}`,
  );
  if (result.errors.length) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
