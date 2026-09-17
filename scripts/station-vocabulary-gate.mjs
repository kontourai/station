#!/usr/bin/env node
// Contract-wide vocabulary gate for docs/glossary.md.
//
// This complements noun-consistency-gate.mjs. That gate parses rendered UI
// copy for several older noun migrations; this one checks exact, high-signal
// phrases across every tracked text surface so CLI docs, examples, native
// errors, comments, and machine-readable target output cannot silently drift.
// It intentionally does not ban the word "profile": user profiles, AWS
// profiles, Apple provisioning profiles, SSH profiles, and credential-recovery
// profiles are distinct qualified concepts. It bans only the retired saved-
// Station use and the old target selector, with explicit vendor-tool exceptions.

import { readFileSync } from 'node:fs';
import { gitLsFiles } from './lib/ratchet-utils.mjs';

const SELF = new Set([
  'scripts/station-vocabulary-gate.mjs',
  'scripts/__tests__/station-vocabulary-gate.test.ts',
]);

const TEXT_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.jsonl',
  '.jsx',
  '.md',
  '.mjs',
  '.rs',
  '.sh',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
]);

const EXACT_TEXT_FILES = new Set(['station']);

const RULES = Object.freeze([
  {
    code: 'saved-station-profile',
    pattern: new RegExp(
      `\\b${'station'}(?: (?:active|default|native|pairing|project|saved|selected|shared))? profiles?\\b`,
      'gi',
    ),
    replacement: 'Station or saved Station',
  },
  {
    code: 'station-profile-env',
    pattern: new RegExp(`\\b${'STATION'}_${'PROFILE'}\\b`, 'g'),
    replacement: 'STATION_TARGET',
  },
  {
    code: 'layout-profile',
    pattern: new RegExp(`\\bProject ${'layout'} ${'profile'}\\b`, 'gi'),
    replacement: 'Layout sources',
  },
  {
    code: 'workspace-panel',
    pattern: new RegExp(`\\bWorkspace ${'Panels?'}\\b`, 'g'),
    replacement: 'Workspace Pane',
  },
  {
    code: 'layout-panel',
    pattern: new RegExp(`\\b${'Layout'} panels?\\b`, 'gi'),
    replacement: 'Layout Pane, or Panel within a Layout',
  },
  {
    code: 'workspace-pane-layout',
    pattern: new RegExp(`\\bWorkspace ${'Pane'} ${'layout'}\\b`, 'gi'),
    replacement: 'Layout-to-Workspace-Pane, or workspace composition',
  },
  {
    code: 'runtime-pane',
    pattern: new RegExp(`\\b${'Runtime'} panes?\\b`, 'gi'),
    replacement: 'Workspace Pane',
  },
  {
    code: 'legacy-target-flag',
    pattern: new RegExp(`${'--'}${'profile'}(?==|\\s|$)`, 'g'),
    replacement: '--station',
  },
]);

const VENDOR_PROFILE_FLAG_FILES = new Set([
  '.github/workflows/release.yml',
  'scripts/check-ios-store-profile.mjs',
  'scripts/__tests__/release-workflow.test.ts',
]);

function extension(path) {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  return dot > slash ? path.slice(dot) : '';
}

export function isVocabularyTextFile(path) {
  return (
    !SELF.has(path) &&
    path !== 'package-lock.json' &&
    path !== 'pnpm-lock.yaml' &&
    (EXACT_TEXT_FILES.has(path) || TEXT_EXTENSIONS.has(extension(path)))
  );
}

function isQualifiedVendorProfileFlag(file, line) {
  if (VENDOR_PROFILE_FLAG_FILES.has(file)) return true;
  if (
    file === 'docs/guides/mobile-release.md' &&
    (line.includes('node scripts/ios-local-release-preflight.mjs --profile ') ||
      line.includes('node ../scripts/check-ios-store-profile.mjs --profile '))
  )
    return true;
  return (
    file === 'src-server/providers/adapters/bedrock-adapter.ts' &&
    line.includes('aws sso login')
  );
}

export function scanVocabularyContent(file, content) {
  const findings = [];
  const lines = content.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    for (const rule of RULES) {
      rule.pattern.lastIndex = 0;
      if (!rule.pattern.test(line)) continue;
      if (
        rule.code === 'legacy-target-flag' &&
        isQualifiedVendorProfileFlag(file, line)
      ) {
        continue;
      }
      findings.push({
        code: rule.code,
        file,
        line: index + 1,
        replacement: rule.replacement,
        snippet: line.trim(),
      });
    }
  }
  return findings;
}

export function runVocabularyGate({ files, readFile }) {
  const scanned = files.filter(isVocabularyTextFile);
  const findings = scanned.flatMap((file) =>
    scanVocabularyContent(file, readFile(file)),
  );
  return { findings, scanned };
}

function main() {
  const files = gitLsFiles(['.']);
  const { findings, scanned } = runVocabularyGate({
    files,
    readFile: (file) => readFileSync(file, 'utf8'),
  });

  console.log(
    'Station vocabulary gate (Station/saved Station; the shell has regions, a region holds a surface, a surface or a layout holds a pane host, a pane host holds panes, a pane or page may hold panels).\n',
  );
  if (scanned.length === 0) {
    console.error('FAIL: no tracked text files were scanned.');
    return 1;
  }
  if (findings.length > 0) {
    console.error(`FAIL: ${findings.length} retired vocabulary match(es):\n`);
    for (const finding of findings) {
      console.error(
        `  ${finding.file}:${finding.line} [${finding.code}] ${finding.snippet}`,
      );
      console.error(`    use: ${finding.replacement}`);
    }
    console.error(
      '\nQualified user, AWS, Apple provisioning, SSH, and credential-recovery profiles remain valid.',
    );
    return 1;
  }
  console.log(
    `OK: no retired saved-Station or region/surface/layout/pane/panel vocabulary in ${scanned.length} tracked text files.`,
  );
  return 0;
}

if (process.argv[1]?.endsWith('station-vocabulary-gate.mjs')) {
  process.exit(main());
}
