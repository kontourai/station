#!/usr/bin/env node
// Zero-tolerance gate for #2648 (self-hosted UI fonts). The web UI used to
// load its faces from the Google Fonts css2 endpoint on every boot — a
// local-first violation (typography breaks offline, every boot leaks to a
// third party, first paint waits on a remote stylesheet). The faces are now
// vendored under src-ui/public/fonts/ with @font-face rules in
// src-ui/src/fonts.css, and the desktop CSP no longer allowlists the remote
// font origins. This gate keeps it that way: any reappearance of an external
// FONT origin (the Google Fonts stylesheet or font-file CDN hosts) in the UI
// source or the desktop CSP fails verify:static. It is deliberately narrow —
// external font origins only, not a general external-origin scanner.
//
// Follows the established ratchet family (pure exported functions + a
// `main()` gated behind `import.meta.url === file://process.argv[1]`,
// `git ls-files`-scoped). Zero-tolerance like rename-inventory, not a
// counted-baseline ratchet: the correct number of external font origins is 0.
//
// Scope-integrity note (station#1559 class): a pathspec that silently stops
// matching would turn this gate into a vacuous green, so SCOPE_SENTINELS pins
// the exact files where the regression class lives — each one held a live
// external-font reference when this gate was introduced — and the gate fails
// if any of them falls out of the scanned list.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SCAN_PATHSPECS = [
  'src-ui/index.html',
  'src-ui/src',
  'src-desktop/tauri.conf.json',
  // The CLI's web-serving securityHeaders CSP — the other place a remote
  // font origin allowlist could silently regress.
  'packages/cli/src/commands/lifecycle.ts',
];

const SCOPE_SENTINELS = [
  'src-ui/index.html',
  'src-ui/src/index.css',
  'src-desktop/tauri.conf.json',
  'packages/cli/src/commands/lifecycle.ts',
];

const EXTERNAL_FONT_ORIGIN = /fonts\.googleapis\.com|fonts\.gstatic\.com/i;

export function findExternalFontOrigins(content, file) {
  const findings = [];
  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (EXTERNAL_FONT_ORIGIN.test(lines[index])) {
      findings.push({ file, line: index + 1, text: lines[index].trim() });
    }
  }
  return findings;
}

export function assertScanScope(files) {
  const missing = SCOPE_SENTINELS.filter(
    (sentinel) => !files.includes(sentinel),
  );
  if (missing.length > 0) {
    throw new Error(
      `font-origin scan scope is broken — sentinel file(s) not in the scanned list: ${missing.join(', ')}. ` +
        'Fix SCAN_PATHSPECS/SCOPE_SENTINELS together; do not let the gate go vacuously green.',
    );
  }
}

export function inspectFiles(files, readFile) {
  return files.flatMap((file) => findExternalFontOrigins(readFile(file), file));
}

function main() {
  const files = execFileSync('git', ['ls-files', '--', ...SCAN_PATHSPECS], {
    encoding: 'utf8',
    windowsHide: true,
  })
    .trim()
    .split('\n')
    .filter(Boolean);
  assertScanScope(files);
  const findings = inspectFiles(files, (file) => readFileSync(file, 'utf8'));
  if (findings.length > 0) {
    for (const finding of findings) {
      process.stderr.write(
        `[font-origin] external font origin: ${finding.file}:${finding.line}: ${finding.text}\n`,
      );
    }
    throw new Error(
      `font-origin gate failed: ${findings.length} external font origin reference(s) in UI source/CSP ` +
        '(fonts are self-hosted under src-ui/public/fonts/ — see src-ui/src/fonts.css, #2648)',
    );
  }
  process.stdout.write(
    `[font-origin] OK: 0 external font origin references across ${files.length} scanned file(s)\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
