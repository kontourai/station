import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `docs/strategy/dogfood/<run>/report.md` commits a SHA-256 digest for every
 * evidence artifact a gated `station-delivery` run attached.  Those artifacts
 * were originally produced into `.flow/runs/<run>/evidence/`, which is
 * gitignored — so for most of this repo's life the committed digests were
 * receipts for files that existed on exactly one machine.  A digest nobody can
 * resolve to bytes is not evidence; it is an assertion.
 *
 * This test keeps the two sides bound together:
 *   - every committed digest resolves to a retained artifact whose bytes hash
 *     to exactly that digest, OR is named in the unrecoverable ledger; and
 *   - every ledger entry is still genuinely unrecoverable, so the ledger
 *     cannot quietly become an excuse list.
 *
 * It deliberately does NOT recompute digests from the artifacts.  A mismatch
 * means the committed receipt was wrong; the correct response is to
 * investigate the report, never to rewrite the digest to match whatever bytes
 * happen to be on disk.
 */

const DOGFOOD_ROOT = 'docs/strategy/dogfood';
const LEDGER_PATH = join(DOGFOOD_ROOT, 'evidence-retention.json');
const ARCHIVE_MANIFEST_PATH = join(DOGFOOD_ROOT, 'evidence-archive.json');

/** `- ev.1781244850210.1: surface.claim for implement-gate (<64 hex>)` */
const EVIDENCE_LINE =
  /^- (ev\.[0-9.]+): (\S+) for (\S+) \(([a-f0-9]{64})\)\s*$/gm;

interface CitedDigest {
  run: string;
  reportPath: string;
  evidenceId: string;
  kind: string;
  gate: string;
  sha256: string;
}

interface LedgerEntry {
  run: string;
  reason: string;
  detail: string;
  digests: {
    evidenceId: string;
    gate: string;
    kind: string;
    sha256: string;
  }[];
}

interface Ledger {
  schemaVersion: number;
  unrecoverableDigestCount: number;
  unrecoverable: LedgerEntry[];
}

function runDirectories(): string[] {
  return readdirSync(DOGFOOD_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function citedDigests(): CitedDigest[] {
  const cited: CitedDigest[] = [];
  for (const run of runDirectories()) {
    const reportPath = join(DOGFOOD_ROOT, run, 'report.md');
    if (!existsSync(reportPath)) continue;
    const report = readFileSync(reportPath, 'utf8');
    for (const match of report.matchAll(EVIDENCE_LINE)) {
      cited.push({
        run,
        reportPath,
        evidenceId: match[1],
        kind: match[2],
        gate: match[3],
        sha256: match[4],
      });
    }
  }
  return cited;
}

/**
 * Retained artifacts sit beside the report that cites them, named for the
 * evidence id they carry (`evidence/ev.<id>.<ext>`).  `manifest.json` is the
 * run's own provenance sidecar, not a cited artifact.
 */
function retainedArtifacts(run: string): Map<string, string> {
  const evidenceDir = join(DOGFOOD_ROOT, run, 'evidence');
  const found = new Map<string, string>();
  if (!existsSync(evidenceDir)) return found;
  for (const file of readdirSync(evidenceDir)) {
    if (file === 'manifest.json') continue;
    const evidenceId = file.replace(/\.[^.]+$/, '');
    found.set(evidenceId, join(evidenceDir, file));
  }
  return found;
}

function sha256OfFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function loadLedger(): Ledger {
  return JSON.parse(readFileSync(LEDGER_PATH, 'utf8')) as Ledger;
}

/**
 * station#4043: evidence bytes may be relocated to the receipts archive (a
 * GitHub Release asset) instead of retained beside the report. The committed
 * manifest pins the archive's own sha256 plus one entry per member; each
 * artifact entry's digest was byte-verified against its report's citation by
 * scripts/build-evidence-archive.mjs at build time, and a downloaded asset is
 * re-checkable with `--verify=<path>`. This test treats a manifest entry as a
 * resolution root; it never treats the manifest as license to weaken the
 * mismatch rule for bytes that ARE retained locally.
 */
interface ArchiveManifest {
  schemaVersion: number;
  archive: { releaseTag: string; asset: string; sha256: string; bytes: number };
  entries: {
    member: string;
    run?: string;
    evidenceId?: string;
    sha256: string;
    bytes: number;
    kind: 'artifact' | 'sidecar';
  }[];
}

function loadArchiveManifest(): ArchiveManifest | undefined {
  if (!existsSync(ARCHIVE_MANIFEST_PATH)) return undefined;
  return JSON.parse(
    readFileSync(ARCHIVE_MANIFEST_PATH, 'utf8'),
  ) as ArchiveManifest;
}

function archivedDigests(manifest: ArchiveManifest | undefined) {
  const byRunAndId = new Map<string, string>();
  if (!manifest) return byRunAndId;
  for (const entry of manifest.entries) {
    if (entry.kind !== 'artifact') continue;
    byRunAndId.set(`${entry.run}/${entry.evidenceId}`, entry.sha256);
  }
  return byRunAndId;
}

function ledgerDigests(ledger: Ledger): Map<string, LedgerEntry> {
  const byDigest = new Map<string, LedgerEntry>();
  for (const entry of ledger.unrecoverable) {
    for (const digest of entry.digests) byDigest.set(digest.sha256, entry);
  }
  return byDigest;
}

describe('dogfood evidence retention', () => {
  const cited = citedDigests();
  const ledger = loadLedger();
  const unrecoverable = ledgerDigests(ledger);
  const archiveManifest = loadArchiveManifest();
  const archived = archivedDigests(archiveManifest);

  it('finds evidence digests to check', () => {
    // Guards the parser itself: a report-format change that stopped matching
    // would otherwise make every assertion below vacuously pass.
    expect(cited.length).toBeGreaterThanOrEqual(64);
    expect(new Set(cited.map((c) => c.run)).size).toBeGreaterThanOrEqual(20);
  });

  it('resolves every committed digest to retained bytes or to the ledger', () => {
    const dangling: string[] = [];
    const mismatched: string[] = [];

    for (const entry of cited) {
      const artifact = retainedArtifacts(entry.run).get(entry.evidenceId);

      if (!artifact) {
        const archivedDigest = archived.get(`${entry.run}/${entry.evidenceId}`);
        if (archivedDigest !== undefined) {
          if (archivedDigest !== entry.sha256) {
            mismatched.push(
              `${ARCHIVE_MANIFEST_PATH} pins ${archivedDigest} for ` +
                `${entry.run}/${entry.evidenceId} but ${entry.reportPath} committed ` +
                `${entry.sha256}. The committed receipt and the archived record ` +
                `disagree — investigate which is wrong. Do NOT update either to match.`,
            );
          }
          continue;
        }
        if (unrecoverable.has(entry.sha256)) continue;
        dangling.push(
          `${entry.reportPath} cites ${entry.evidenceId} (${entry.sha256}) ` +
            `but ${join(DOGFOOD_ROOT, entry.run, 'evidence')} holds no such artifact, ` +
            `and it is not recorded in ${LEDGER_PATH}.`,
        );
        continue;
      }

      const actual = sha256OfFile(artifact);
      if (actual !== entry.sha256) {
        mismatched.push(
          `${artifact} hashes to ${actual} but ${entry.reportPath} committed ` +
            `${entry.sha256} for ${entry.evidenceId}. The committed receipt and ` +
            `the retained bytes disagree — investigate which is wrong. Do NOT ` +
            `update the report to match the file.`,
        );
      }
    }

    expect(mismatched, mismatched.join('\n')).toEqual([]);
    expect(dangling, dangling.join('\n')).toEqual([]);
  });

  it('keeps the unrecoverable ledger honest and non-growing', () => {
    const stale: string[] = [];
    for (const entry of ledger.unrecoverable) {
      const retained = retainedArtifacts(entry.run);
      for (const digest of entry.digests) {
        const artifact = retained.get(digest.evidenceId);
        if (artifact && sha256OfFile(artifact) === digest.sha256) {
          stale.push(
            `${digest.evidenceId} is listed unrecoverable but ${artifact} now ` +
              `matches ${digest.sha256}. Remove it from ${LEDGER_PATH}.`,
          );
        }
      }
    }
    expect(stale, stale.join('\n')).toEqual([]);

    const total = ledger.unrecoverable.reduce(
      (sum, entry) => sum + entry.digests.length,
      0,
    );
    expect(total).toBe(ledger.unrecoverableDigestCount);
    // Ratchet: artifacts can be recovered, never newly lost. A run that cannot
    // retain its evidence must not be committed in the first place.
    expect(total).toBeLessThanOrEqual(16);
  });

  it('keeps the archive manifest honest in both directions', () => {
    if (!archiveManifest) return;
    expect(archiveManifest.schemaVersion).toBe(1);
    expect(archiveManifest.archive.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(archiveManifest.archive.releaseTag.startsWith('v')).toBe(false);
    expect(archiveManifest.entries.length).toBeGreaterThan(0);
    const members = archiveManifest.entries.map((entry) => entry.member);
    expect([...members].sort()).toEqual(members);
    expect(new Set(members).size).toBe(members.length);

    const problems: string[] = [];
    const citedByRunAndId = new Map(
      cited.map((c) => [`${c.run}/${c.evidenceId}`, c.sha256]),
    );
    for (const entry of archiveManifest.entries) {
      if (entry.kind !== 'artifact') continue;
      const key = `${entry.run}/${entry.evidenceId}`;
      // An archived artifact that is ALSO retained locally is a stale entry:
      // local bytes are the resolution root again, so the entry must go.
      if (
        entry.run &&
        retainedArtifacts(entry.run).has(entry.evidenceId ?? '')
      ) {
        problems.push(
          `${key} is archived but also retained locally — remove the manifest entry.`,
        );
      }
      // An archived digest still in the unrecoverable ledger contradicts the
      // ledger's own meaning: the bytes are recoverable from the archive.
      if (unrecoverable.has(entry.sha256)) {
        problems.push(
          `${key} (${entry.sha256}) is archived AND ledgered unrecoverable — remove the ledger entry.`,
        );
      }
      // An archive member no report cites is an orphan hidden in the archive.
      if (citedByRunAndId.get(key) === undefined) {
        problems.push(`${key} is archived but no report cites it.`);
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('retains no artifact that no report cites', () => {
    const citedIds = new Set(cited.map((c) => `${c.run}/${c.evidenceId}`));
    const orphans: string[] = [];
    for (const run of runDirectories()) {
      for (const [evidenceId, path] of retainedArtifacts(run)) {
        if (!citedIds.has(`${run}/${evidenceId}`)) orphans.push(path);
      }
    }
    expect(orphans, orphans.join('\n')).toEqual([]);
  });

  it('keeps a provenance manifest beside every retained run', () => {
    const missing: string[] = [];
    for (const run of runDirectories()) {
      if (retainedArtifacts(run).size === 0) continue;
      const manifest = join(DOGFOOD_ROOT, run, 'evidence', 'manifest.json');
      if (!existsSync(manifest)) {
        missing.push(manifest);
        continue;
      }
      // The manifest is the run's own record of what it attached and from
      // where; a retained artifact with no manifest entry has no provenance.
      const declared = new Set<string>(
        (
          JSON.parse(readFileSync(manifest, 'utf8')) as {
            evidence?: { id: string }[];
          }
        ).evidence?.map((e) => e.id) ?? [],
      );
      for (const evidenceId of retainedArtifacts(run).keys()) {
        if (!declared.has(evidenceId)) {
          missing.push(`${manifest} does not declare ${evidenceId}`);
        }
      }
    }
    expect(missing, missing.join('\n')).toEqual([]);
  });
});
