#!/usr/bin/env node
// Sweeps EVERY tracked markdown and .jsonl record under docs/ for the privacy
// patterns public-docs-hygiene.mjs already defines (machine paths, tailnet/private
// hostnames, private IPs, personal mailboxes). The public gate scans only the
// nine-document public manifest, so a tailnet FQDN sat in docs/glossary.md
// and a home server's topology in live reference docs with nothing pointed at
// them.
//
// Files with existing findings are allowlisted in
// scripts/docs-hygiene-grandfather.json — this gate exists to stop NEW files
// (or newly leaking files) from joining them, and it is staleness-checked in
// both directions: an entry whose file comes back clean (or leaves the tree)
// must be removed, so the list only ever shrinks.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRIVACY_PATTERNS } from './public-docs-hygiene.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GRANDFATHER_FILE = 'scripts/docs-hygiene-grandfather.json';

export function trackedDocs() {
  return execFileSync(
    'git',
    ['ls-files', '--', 'docs/*.md', 'docs/*.mdx', 'docs/*.jsonl'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
    },
  )
    .split('\n')
    .filter(Boolean);
}

// Repo docs — unlike the public-projection documents — legitimately describe
// a local-first product: loopback endpoints, canonical documentation address
// ranges, generic system paths, and placeholder tailnet names are
// documentation, not disclosure. A REAL machine name, a developer-home path,
// or a routable private address is still a finding. The benign sets are
// explicit and small on purpose: an enumerated placeholder beats a clever
// prefix rule (a hostname merely STARTING with "your" is not a placeholder).
const PLACEHOLDER_HOSTNAME =
  /^(?:localhost|[a-z0-9-]+\.example\.ts\.net|(?:example|examples|tailnet|my-tailnet|your-tailnet|placeholder)(?:[.-][a-z0-9.-]+)?)$/;
function benignForRepoDocs(code, value) {
  const v = value.trim().toLowerCase();
  if (code === 'private-hostname') {
    return PLACEHOLDER_HOSTNAME.test(v);
  }
  if (code === 'private-ip') {
    // The pattern's guard prefix captures one leading non-hex character
    // (backticks, brackets); strip it before comparing, or `::1` in a code
    // span reads as a finding while ` ::1` reads as benign.
    const ip = v.replace(/^[^0-9a-f:]+/, '');
    if (ip.startsWith('127.') || ip === '::1') return true;
    // 192.168.* is the canonical RFC1918 documentation range; the CGNAT range
    // BASE names the whole range (a firewall-rule example), not a node; and
    // link-local fe80:: addresses are interface-scoped, not topology.
    if (ip.startsWith('192.168.')) return true;
    if (ip === '100.64.0.0') return true;
    if (ip.startsWith('fe80:')) return true;
    // A bare "fc"/"fd:" fragment (matched out of ordinary words like "RFD:")
    // is not an address; a real ULA has hex groups after the prefix.
    if (/^(?:fc|fd):?$/.test(ip)) return true;
    return false;
  }
  if (code === 'absolute-developer-path') {
    // Case-sensitive on purpose: `/Users` is a macOS home root, `/users` is a
    // REST route. Only POSIX developer-home shapes are findings; generic
    // system paths (/tmp, /var, /opt, /private) and Windows drive/UNC paths
    // are documentation here — every observed Windows path in docs uses a
    // `<user>` placeholder, and the ecosystem's real leak shape is POSIX.
    return !/(?:\/Users\b|\/home\b)/.test(value);
  }
  return false;
}

export function findingsFor(
  files,
  read = (file) => readFileSync(resolve(repoRoot, file), 'utf8'),
) {
  const byFile = new Map();
  for (const file of files) {
    const text = read(file);
    const findings = [];
    // A private suffix in an explicitly relative JSON filename is not a
    // hostname. Bare names, URLs and hostname-shaped directory components
    // remain subject to the ordinary privacy rule.
    const relativeJsonBasenames = [
      ...text.matchAll(
        /`((?:\.\.?\/|\.[A-Za-z0-9_-]+\/)(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.json)`/g,
      ),
    ].map((entry) => ({
      start: entry.index + 1 + entry[1].lastIndexOf('/') + 1,
      end: entry.index + entry[0].length - 1,
    }));
    for (const [code, pattern] of PRIVACY_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        if (benignForRepoDocs(code, match[0])) continue;
        if (
          code === 'private-hostname' &&
          relativeJsonBasenames.some(
            (range) =>
              match.index >= range.start &&
              match.index + match[0].length <= range.end,
          )
        )
          continue;
        const lineNumber = text.slice(0, match.index).split('\n').length;
        findings.push(`${file}:${lineNumber} ${code}: ${match[0].trim()}`);
      }
    }
    if (findings.length > 0) byFile.set(file, findings);
  }
  return byFile;
}

export function evaluate({ byFile, grandfathered }) {
  // Entries pin a finding COUNT, not just a file: an allowlisted file that
  // grows a new finding fails like any other file (the old file-level skip
  // made 13% of docs permanently invisible to the gate), while line numbers
  // stay out of the pin so ordinary edits do not churn it.
  const pinned = new Map(
    grandfathered.map((entry) => [entry.file, entry.findings]),
  );
  const failures = [];
  const stale = [];
  for (const [file, findings] of byFile) {
    const allowed = pinned.get(file);
    if (allowed === undefined) {
      failures.push(...findings);
    } else if (findings.length > allowed) {
      failures.push(
        `${file}: ${findings.length} finding(s), allowlist pins ${allowed} — the new one(s):`,
        ...findings.map((finding) => `  ${finding}`),
      );
    } else if (findings.length < allowed) {
      stale.push(
        `${file}: pins ${allowed} finding(s) but has ${findings.length} — shrink the entry`,
      );
    }
  }
  for (const entry of pinned.keys()) {
    if (!byFile.has(entry)) {
      stale.push(`${entry}: file is clean or gone — delete the entry`);
    }
  }
  return { failures, stale };
}

export function main() {
  const grandfathered = JSON.parse(
    readFileSync(resolve(repoRoot, GRANDFATHER_FILE), 'utf8'),
  );
  const byFile = findingsFor(trackedDocs());
  const { failures, stale } = evaluate({ byFile, grandfathered });
  if (failures.length === 0 && stale.length === 0) {
    console.log(
      `Repo docs hygiene passed: ${byFile.size} allowlisted file(s), no new findings.`,
    );
    return 0;
  }
  if (failures.length > 0) {
    console.error(
      `FAIL: private detail in docs outside the grandfather list:\n${failures
        .map((finding) => `- ${finding}`)
        .join('\n')}`,
    );
    console.error(
      '\nRemove the detail (preferred); adding a FILE to scripts/docs-hygiene-grandfather.json is reserved for historical records whose text cannot change without falsifying them.',
    );
  }
  if (stale.length > 0) {
    console.error(
      `FAIL: stale grandfather entries:\n${stale
        .map((line) => `- ${line}`)
        .join('\n')}`,
    );
  }
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  process.exitCode = main();
