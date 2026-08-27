#!/usr/bin/env node
// Builds the dogfood receipts archive (station#4043): every evidence artifact
// under docs/strategy/dogfood/*/evidence/ is packed into one tar.gz destined
// for a GitHub Release asset, and docs/strategy/dogfood/evidence-archive.json
// records the archive identity plus one entry per artifact. The retention
// test then resolves committed report digests against retained local bytes OR
// this manifest OR the unrecoverable ledger — so the bytes can leave the
// working tree without a single receipt going dark. (They remain reachable
// from this repository's history; a fresh-history mirror is where they leave
// the record entirely.)
//
// Build refuses to archive a lie: each artifact's bytes must hash to a digest
// its run's report actually cites (per-run manifest.json sidecars are packed
// as provenance without that requirement, and recorded with their own
// digests).
//
//   node scripts/build-evidence-archive.mjs --out=<dir>       # build
//   node scripts/build-evidence-archive.mjs --verify=<tar.gz> # check a
//     downloaded asset against the committed manifest
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DOGFOOD_ROOT = 'docs/strategy/dogfood';
export const MANIFEST_PATH = `${DOGFOOD_ROOT}/evidence-archive.json`;
export const ARCHIVE_NAME = 'dogfood-evidence-archive.tar.gz';

const EVIDENCE_LINE =
  /^- (ev\.[0-9.]+): (\S+) for (\S+) \(([a-f0-9]{64})\)\s*$/gm;

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function collectEntries(root = resolve(repoRoot, DOGFOOD_ROOT)) {
  const entries = [];
  const problems = [];
  for (const run of readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()) {
    const evidenceDir = join(root, run, 'evidence');
    if (!existsSync(evidenceDir)) continue;
    const reportPath = join(root, run, 'report.md');
    const cited = new Map();
    if (existsSync(reportPath)) {
      const report = readFileSync(reportPath, 'utf8');
      for (const match of report.matchAll(EVIDENCE_LINE)) {
        cited.set(match[1], match[4]);
      }
    }
    for (const file of readdirSync(evidenceDir).sort()) {
      const path = join(evidenceDir, file);
      const digest = sha256(readFileSync(path));
      const member = `${run}/evidence/${file}`;
      if (file === 'manifest.json') {
        // The sidecar is provenance, not a cited artifact — but its own
        // evidence table duplicates the report's digest claims, which makes
        // it a free second witness: refuse to archive a sidecar that
        // disagrees with the report it sits beside.
        try {
          const sidecar = JSON.parse(readFileSync(path, 'utf8'));
          for (const item of sidecar.evidence ?? []) {
            if (!item.id || !item.sha256) continue;
            const reportDigest = cited.get(item.id);
            if (reportDigest !== undefined && reportDigest !== item.sha256) {
              problems.push(
                `${member}: sidecar claims ${item.sha256} for ${item.id} but ${run}/report.md commits ${reportDigest}`,
              );
            }
          }
        } catch {
          problems.push(`${member}: sidecar is not parseable JSON`);
        }
        entries.push({
          member,
          sha256: digest,
          bytes: statSync(path).size,
          kind: 'sidecar',
        });
        continue;
      }
      const evidenceId = file.replace(/\.[^.]+$/, '');
      const citedDigest = cited.get(evidenceId);
      if (citedDigest === undefined) {
        problems.push(`${member}: no report line cites ${evidenceId}`);
        continue;
      }
      if (citedDigest !== digest) {
        problems.push(
          `${member}: bytes hash to ${digest} but ${run}/report.md commits ${citedDigest} — refusing to archive a mismatch`,
        );
        continue;
      }
      entries.push({
        member,
        run,
        evidenceId,
        sha256: digest,
        bytes: statSync(path).size,
        kind: 'artifact',
      });
    }
  }
  return { entries, problems };
}

function build(outDir, force = false) {
  const { entries, problems } = collectEntries();
  if (problems.length > 0) {
    console.error(
      `FAIL: refusing to build over integrity problems:\n${problems.map((p) => `- ${p}`).join('\n')}`,
    );
    return 1;
  }
  // A rebuild that pins FEWER members than the committed manifest would
  // silently orphan the difference (the retention test would catch it
  // downstream, but a builder must not print success over a shrink). Growing
  // the archive is a new release tag, not an in-place asset swap — the
  // committed manifest's pinned sha256 is only meaningful while the asset it
  // names is immutable.
  if (existsSync(resolve(repoRoot, MANIFEST_PATH)) && !force) {
    const committed = JSON.parse(
      readFileSync(resolve(repoRoot, MANIFEST_PATH), 'utf8'),
    );
    if (entries.length < committed.entries.length) {
      console.error(
        `FAIL: rebuild would pin ${entries.length} member(s) but the committed manifest pins ${committed.entries.length}. ` +
          'A shrink orphans receipts. Pass --force only when the difference is deliberately ledgered, and use a NEW release tag.',
      );
      return 1;
    }
  }
  mkdirSync(outDir, { recursive: true });
  const archivePath = join(outDir, ARCHIVE_NAME);
  execFileSync(
    'tar',
    [
      '-czf',
      archivePath,
      '-C',
      resolve(repoRoot, DOGFOOD_ROOT),
      ...entries.map((e) => e.member),
    ],
    { windowsHide: true },
  );
  const archiveBytes = readFileSync(archivePath);
  const manifest = {
    schemaVersion: 1,
    note:
      'Receipts archive (station#4043): evidence bytes for the digests the dogfood reports commit. ' +
      'Download the release asset named below and check it with ' +
      'node scripts/build-evidence-archive.mjs --verify=<path>. The release lives on the repository ' +
      'this manifest is committed to; re-upload the identical asset (same sha256) if the repository is mirrored.',
    archive: {
      releaseTag: 'dogfood-evidence-archive-v1',
      asset: ARCHIVE_NAME,
      sha256: sha256(archiveBytes),
      bytes: archiveBytes.length,
    },
    entries,
  };
  writeFileSync(
    resolve(repoRoot, MANIFEST_PATH),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  console.log(
    `Built ${archivePath} (${archiveBytes.length} bytes, sha256 ${manifest.archive.sha256}) — ${entries.length} members; manifest written to ${MANIFEST_PATH}.`,
  );
  return 0;
}

function verify(archivePath) {
  const manifest = JSON.parse(
    readFileSync(resolve(repoRoot, MANIFEST_PATH), 'utf8'),
  );
  if (!existsSync(archivePath)) {
    console.error(`FAIL: ${archivePath} does not exist.`);
    return 1;
  }
  const actual = sha256(readFileSync(archivePath));
  if (actual !== manifest.archive.sha256) {
    console.error(
      `FAIL: ${archivePath} hashes to ${actual}; the committed manifest pins ${manifest.archive.sha256}.`,
    );
    return 1;
  }
  // Whole-file identity implies member identity for THIS tarball, but a
  // manifest could still pin a phantom member the tarball never held. Extract
  // and prove set-equality plus per-member digests, so OK means every pinned
  // member is present and correct — not just that the outer bytes match.
  const extractDir = mkdtempSync(join(tmpdir(), 'evidence-archive-verify-'));
  try {
    execFileSync('tar', ['-xzf', archivePath, '-C', extractDir], {
      windowsHide: true,
    });
    const problems = [];
    for (const entry of manifest.entries) {
      const memberPath = join(extractDir, entry.member);
      if (!existsSync(memberPath)) {
        problems.push(
          `${entry.member}: pinned in the manifest but absent from the archive`,
        );
        continue;
      }
      const memberDigest = sha256(readFileSync(memberPath));
      if (memberDigest !== entry.sha256) {
        problems.push(
          `${entry.member}: archive bytes hash to ${memberDigest}; manifest pins ${entry.sha256}`,
        );
      }
    }
    if (problems.length > 0) {
      console.error(`FAIL:\n${problems.map((p) => `- ${p}`).join('\n')}`);
      return 1;
    }
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
  console.log(
    `OK: archive matches the committed manifest — ${manifest.entries.length} members present with pinned digests.`,
  );
  return 0;
}

export function main(argv = process.argv.slice(2)) {
  const outFlag = argv.find((a) => a.startsWith('--out='));
  const verifyFlag = argv.find((a) => a.startsWith('--verify='));
  if (verifyFlag) return verify(verifyFlag.slice('--verify='.length));
  if (outFlag)
    return build(outFlag.slice('--out='.length), argv.includes('--force'));
  console.error(
    'usage: build-evidence-archive.mjs --out=<dir> | --verify=<tar.gz>',
  );
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  process.exitCode = main();
