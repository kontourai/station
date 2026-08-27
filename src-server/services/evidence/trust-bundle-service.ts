/**
 * TrustBundleService - Surface trust bundles for project workspaces (S2).
 *
 * Trust bundles are the hand-off artifact of the Kontour evidence pipeline:
 * plugins (Survey Review Workbench first) and tools project verified state
 * into bare Surface `TrustBundle` JSON files. This service makes them a
 * first-class project surface:
 *
 *   - list: scan `<workspace>/.station/trust-bundles/*.json` plus the
 *     station-home fallback used when a project has no working directory
 *     (`<home>/projects/<slug>/plugin-data/<plugin>/trust-bundles/*.json`,
 *     the layout the Survey plugin established) and summarize each bundle.
 *   - read: validate a bundle (`validateTrustBundle`) and derive a Surface
 *     `TrustReport` (`buildTrustReport`) for the trust panel to render.
 *
 * Invalid bundles are reported as data (`valid: false` + the validation
 * error), mirroring how the readiness service reports "not configured" —
 * a bad artifact on disk is a state the panel must show, not a 500.
 */

import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  buildTrustReport,
  type TrustBundle,
  type TrustReport,
  validateTrustBundle,
} from '@kontourai/surface';
import { trustBundleLists, trustBundleReads } from '../../telemetry/metrics.js';

// ── Errors ────────────────────────────────────────────────────────────────

/** Requested bundle id does not resolve to a file → 404. */
export class TrustBundleNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrustBundleNotFoundError';
  }
}

// ── Public shapes ─────────────────────────────────────────────────────────

export type TrustBundleSource =
  | 'workspace'
  | 'station-home'
  | 'veritas-evidence';

export interface TrustBundleLocations {
  /** Project working directory; bundles live under `.station/trust-bundles/`. */
  workspacePath?: string;
  /**
   * Per-project plugin-data root in the Station home
   * (`<home>/projects/<slug>/plugin-data`); each plugin may keep a
   * `trust-bundles/` directory there when the project has no workspace.
   */
  pluginDataDir?: string;
  /**
   * Veritas generated evidence directory/directories. Station prefers
   * `<workspace>/.kontourai/veritas/evidence` and falls back to legacy
   * `<workspace>/.veritas/evidence`. When set, the newest `veritas-*.json`
   * evidence record's embedded `trust.bundle` is surfaced as a derived bundle,
   * so the Trust panel lights up wherever Veritas has run. Gated by the
   * `surfaceTrustFromVeritasEvidence` app setting at the route boundary.
   */
  veritasEvidenceDir?: string | string[];
}

/** Stable id for the bundle derived from the latest Veritas evidence record. */
const VERITAS_EVIDENCE_BUNDLE_ID = 'veritas-readiness';

export interface TrustBundleSummary {
  /** File stem; resolution prefers workspace bundles over station-home ones. */
  id: string;
  fileName: string;
  path: string;
  source: TrustBundleSource;
  /** Contributing plugin for station-home bundles. */
  plugin?: string;
  modifiedAt: string;
  valid: boolean;
  /** Validation error message when the bundle does not parse/validate. */
  error?: string;
  /** `bundle.source` for valid bundles. */
  bundleSource?: string;
  claimCount?: number;
  claimsByStatus?: Record<string, number>;
  transparencyGapCount?: number;
}

export interface TrustReportResult {
  id: string;
  path: string;
  source: TrustBundleSource;
  plugin?: string;
  modifiedAt: string;
  valid: boolean;
  error?: string;
  /** Surface trust report; null when the bundle is invalid. */
  report: TrustReport | null;
}

interface BundleFile {
  id: string;
  fileName: string;
  path: string;
  source: TrustBundleSource;
  plugin?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class TrustBundleService {
  /** Enumerate candidate bundle files, workspace first (resolution order). */
  private async findBundleFiles(
    locations: TrustBundleLocations,
  ): Promise<BundleFile[]> {
    const files: BundleFile[] = [];

    if (locations.workspacePath) {
      const dir = join(
        resolve(locations.workspacePath),
        '.station',
        'trust-bundles',
      );
      if (existsSync(dir)) {
        for (const name of (await readdir(dir)).sort()) {
          if (!name.endsWith('.json')) continue;
          files.push({
            id: name.slice(0, -'.json'.length),
            fileName: name,
            path: join(dir, name),
            source: 'workspace',
          });
        }
      }
    }

    if (locations.pluginDataDir && existsSync(locations.pluginDataDir)) {
      const pluginEntries = await readdir(locations.pluginDataDir, {
        withFileTypes: true,
      });
      for (const pluginEntry of pluginEntries
        .filter((entry) => entry.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name))) {
        const dir = join(
          locations.pluginDataDir,
          pluginEntry.name,
          'trust-bundles',
        );
        if (!existsSync(dir)) continue;
        for (const name of (await readdir(dir)).sort()) {
          if (!name.endsWith('.json')) continue;
          files.push({
            id: name.slice(0, -'.json'.length),
            fileName: name,
            path: join(dir, name),
            source: 'station-home',
            plugin: pluginEntry.name,
          });
        }
      }
    }

    if (locations.veritasEvidenceDir) {
      const latest = await this.findLatestVeritasEvidence(
        [locations.veritasEvidenceDir].flat(),
      );
      if (latest) {
        files.push({
          id: VERITAS_EVIDENCE_BUNDLE_ID,
          fileName: latest.fileName,
          path: latest.path,
          source: 'veritas-evidence',
        });
      }
    }

    return files;
  }

  /**
   * Newest `veritas-<runId>.json` evidence record in the directory, by mtime.
   * Returns undefined when the directory is absent or holds no evidence records.
   */
  private async findLatestVeritasEvidence(
    evidenceDirs: string[],
  ): Promise<{ fileName: string; path: string } | undefined> {
    let newest: { fileName: string; path: string; mtimeMs: number } | undefined;
    for (const evidenceDir of evidenceDirs) {
      if (!existsSync(evidenceDir)) continue;
      const names = (await readdir(evidenceDir)).filter(
        (name) => name.startsWith('veritas-') && name.endsWith('.json'),
      );
      for (const name of names) {
        const path = join(evidenceDir, name);
        const mtimeMs = (await stat(path)).mtimeMs;
        if (!newest || mtimeMs > newest.mtimeMs) {
          newest = { fileName: name, path, mtimeMs };
        }
      }
    }
    return newest
      ? { fileName: newest.fileName, path: newest.path }
      : undefined;
  }

  private async loadBundle(
    file: BundleFile,
  ): Promise<
    | { valid: true; bundle: TrustBundle; modifiedAt: string }
    | { valid: false; error: string; modifiedAt: string }
  > {
    const modifiedAt = (await stat(file.path)).mtime.toISOString();
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(file.path, 'utf8'));
    } catch (error: unknown) {
      return {
        valid: false,
        error: `bundle is not valid JSON: ${errorMessage(error)}`,
        modifiedAt,
      };
    }
    // A Veritas evidence record wraps the Surface bundle at `trust.bundle`
    // (the bundle itself is a standard `@kontourai/surface` TrustBundle, so it
    // validates with the same validator). Unwrap before validating; everything
    // else is already a bare bundle on disk.
    if (file.source === 'veritas-evidence') {
      const embedded = (parsed as { trust?: { bundle?: unknown } })?.trust
        ?.bundle;
      if (embedded === undefined) {
        return {
          valid: false,
          error: 'Veritas evidence record has no embedded trust.bundle',
          modifiedAt,
        };
      }
      parsed = embedded;
    }
    try {
      return { valid: true, bundle: validateTrustBundle(parsed), modifiedAt };
    } catch (error: unknown) {
      return { valid: false, error: errorMessage(error), modifiedAt };
    }
  }

  /** List bundles for a project with per-bundle claim summaries. */
  async listBundles(
    locations: TrustBundleLocations,
  ): Promise<TrustBundleSummary[]> {
    const files = await this.findBundleFiles(locations);
    const summaries: TrustBundleSummary[] = [];

    for (const file of files) {
      const loaded = await this.loadBundle(file);
      const base: TrustBundleSummary = {
        id: file.id,
        fileName: file.fileName,
        path: file.path,
        source: file.source,
        ...(file.plugin ? { plugin: file.plugin } : {}),
        modifiedAt: loaded.modifiedAt,
        valid: loaded.valid,
      };
      if (!loaded.valid) {
        summaries.push({ ...base, error: loaded.error });
        continue;
      }
      try {
        const report = buildTrustReport(loaded.bundle);
        summaries.push({
          ...base,
          bundleSource: loaded.bundle.source,
          claimCount: report.summary.totalClaims,
          claimsByStatus: report.summary.byStatus,
          transparencyGapCount: report.transparencyGaps.length,
        });
      } catch (error: unknown) {
        // Validated but un-reportable — surface as invalid rather than 500.
        summaries.push({ ...base, valid: false, error: errorMessage(error) });
      }
    }

    const sources = new Set(summaries.map((summary) => summary.source));
    trustBundleLists.add(1, {
      sources:
        sources.size >= 2
          ? 'multiple'
          : (sources.values().next().value ?? 'none'),
    });
    return summaries;
  }

  /**
   * Resolve a bundle id to its trust report. Resolution order is workspace
   * first, then station-home plugins alphabetically — the same order the
   * list presents. Invalid bundles return `valid: false` with the error.
   */
  async getTrustReport(
    locations: TrustBundleLocations,
    id: string,
  ): Promise<TrustReportResult> {
    const files = await this.findBundleFiles(locations);
    const file = files.find((candidate) => candidate.id === id);
    if (!file) {
      trustBundleReads.add(1, { outcome: 'not-found' });
      throw new TrustBundleNotFoundError(`Trust bundle not found: ${id}`);
    }

    const loaded = await this.loadBundle(file);
    const base = {
      id: file.id,
      path: file.path,
      source: file.source,
      ...(file.plugin ? { plugin: file.plugin } : {}),
      modifiedAt: loaded.modifiedAt,
    };
    if (!loaded.valid) {
      trustBundleReads.add(1, { outcome: 'invalid' });
      return { ...base, valid: false, error: loaded.error, report: null };
    }
    try {
      const report = buildTrustReport(loaded.bundle);
      trustBundleReads.add(1, { outcome: 'report' });
      return { ...base, valid: true, report };
    } catch (error: unknown) {
      trustBundleReads.add(1, { outcome: 'invalid' });
      return {
        ...base,
        valid: false,
        error: errorMessage(error),
        report: null,
      };
    }
  }
}
