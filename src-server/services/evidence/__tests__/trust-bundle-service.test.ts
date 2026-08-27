import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../../telemetry/metrics.js', () => ({
  trustBundleLists: { add: vi.fn() },
  trustBundleReads: { add: vi.fn() },
}));

const { TrustBundleService, TrustBundleNotFoundError } = await import(
  '../trust-bundle-service.js'
);

/** Minimal bundle accepted by @kontourai/surface validateTrustBundle. */
function validBundle(claimId = 'claim-1'): Record<string, unknown> {
  return {
    schemaVersion: 5,
    source: 'station-test',
    claims: [
      {
        id: claimId,
        subjectType: 'artifact',
        subjectId: 'repo:demo',
        facet: 'quality',
        claimType: 'quality.static-checks',
        fieldOrBehavior: 'verify:static',
        value: 'pass',
        status: 'verified',
        createdAt: '2026-06-12T00:00:00.000Z',
        updatedAt: '2026-06-12T00:00:00.000Z',
      },
    ],
    evidence: [
      {
        id: `${claimId}.evidence`,
        claimId,
        evidenceType: 'test_output',
        method: 'validation',
        sourceRef: 'command:verify-static',
        excerptOrSummary: 'verify:static exited 0',
        observedAt: '2026-06-12T00:00:00.000Z',
        collectedBy: 'station',
        passing: true,
      },
    ],
    policies: [],
    events: [],
  };
}

describe('TrustBundleService', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function createWorkspace(): string {
    const cwd = mkdtempSync(join(tmpdir(), 'station-trust-ws-'));
    tempDirs.push(cwd);
    return cwd;
  }

  function createPluginDataDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'station-trust-home-'));
    tempDirs.push(dir);
    return dir;
  }

  function writeWorkspaceBundle(cwd: string, name: string, content: unknown) {
    const dir = join(cwd, '.station', 'trust-bundles');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, name),
      typeof content === 'string' ? content : JSON.stringify(content, null, 2),
    );
  }

  function writePluginBundle(
    pluginDataDir: string,
    plugin: string,
    name: string,
    content: unknown,
  ) {
    const dir = join(pluginDataDir, plugin, 'trust-bundles');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, name),
      typeof content === 'string' ? content : JSON.stringify(content, null, 2),
    );
  }

  /**
   * Write a Veritas evidence record
   * (`.kontourai/veritas/evidence/veritas-<runId>.json`) whose embedded
   * `trust.bundle` is `bundle`. Returns the evidence dir.
   */
  function writeVeritasEvidence(
    cwd: string,
    runId: string,
    bundle: unknown,
  ): string {
    const dir = join(cwd, '.kontourai', 'veritas', 'evidence');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `veritas-${runId}.json`),
      JSON.stringify(
        { run_id: `veritas-${runId}`, trust: { bundle } },
        null,
        2,
      ),
    );
    return dir;
  }

  describe('listBundles', () => {
    test('returns an empty list when no bundle directories exist', async () => {
      const cwd = createWorkspace();
      const result = await new TrustBundleService().listBundles({
        workspacePath: cwd,
        pluginDataDir: join(cwd, 'nope', 'plugin-data'),
      });
      expect(result).toEqual([]);
    });

    test('summarizes workspace bundles with claim counts by status', async () => {
      const cwd = createWorkspace();
      writeWorkspaceBundle(cwd, 'survey-session.json', validBundle());
      const result = await new TrustBundleService().listBundles({
        workspacePath: cwd,
      });
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: 'survey-session',
        fileName: 'survey-session.json',
        source: 'workspace',
        valid: true,
        bundleSource: 'station-test',
        claimCount: 1,
      });
      const statusTotal = Object.values(result[0].claimsByStatus ?? {}).reduce(
        (sum, count) => sum + count,
        0,
      );
      expect(statusTotal).toBe(1);
      expect(result[0].transparencyGapCount).toBe(0);
    });

    test('includes station-home plugin bundles with plugin attribution', async () => {
      const pluginDataDir = createPluginDataDir();
      writePluginBundle(
        pluginDataDir,
        'survey-review-workbench',
        'survey-fallback.json',
        validBundle(),
      );
      const result = await new TrustBundleService().listBundles({
        pluginDataDir,
      });
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: 'survey-fallback',
        source: 'station-home',
        plugin: 'survey-review-workbench',
        valid: true,
      });
    });

    test('lists workspace bundles before station-home bundles', async () => {
      const cwd = createWorkspace();
      const pluginDataDir = createPluginDataDir();
      writeWorkspaceBundle(cwd, 'a-workspace.json', validBundle());
      writePluginBundle(
        pluginDataDir,
        'a-plugin',
        'a-home.json',
        validBundle(),
      );
      const result = await new TrustBundleService().listBundles({
        workspacePath: cwd,
        pluginDataDir,
      });
      expect(result.map((entry) => entry.source)).toEqual([
        'workspace',
        'station-home',
      ]);
    });

    test('reports unparseable and invalid bundles as data, not errors', async () => {
      const cwd = createWorkspace();
      writeWorkspaceBundle(cwd, 'broken.json', '{not json');
      writeWorkspaceBundle(cwd, 'invalid.json', { source: 'x', claims: [] });
      writeWorkspaceBundle(cwd, 'notes.txt', 'ignored');
      const result = await new TrustBundleService().listBundles({
        workspacePath: cwd,
      });
      expect(result.map((entry) => entry.id).sort()).toEqual([
        'broken',
        'invalid',
      ]);
      const broken = result.find((entry) => entry.id === 'broken');
      expect(broken?.valid).toBe(false);
      expect(broken?.error).toContain('not valid JSON');
      const invalid = result.find((entry) => entry.id === 'invalid');
      expect(invalid?.valid).toBe(false);
      expect(invalid?.error).toContain('schemaVersion');
    });
  });

  describe('getTrustReport', () => {
    test('derives a trust report from a valid bundle', async () => {
      const cwd = createWorkspace();
      writeWorkspaceBundle(cwd, 'survey-session.json', validBundle());
      const result = await new TrustBundleService().getTrustReport(
        { workspacePath: cwd },
        'survey-session',
      );
      expect(result.valid).toBe(true);
      expect(result.source).toBe('workspace');
      expect(result.report?.claims).toHaveLength(1);
      expect(result.report?.claims[0]).toMatchObject({
        id: 'claim-1',
        claimType: 'quality.static-checks',
      });
      expect(result.report?.claims[0].status).toBeTruthy();
      expect(result.report?.evidence).toHaveLength(1);
      expect(result.report?.summary.totalClaims).toBe(1);
      expect(Array.isArray(result.report?.transparencyGaps)).toBe(true);
    });

    test('prefers the workspace bundle when ids collide with station-home', async () => {
      const cwd = createWorkspace();
      const pluginDataDir = createPluginDataDir();
      const workspaceBundle = validBundle('workspace-claim');
      writeWorkspaceBundle(cwd, 'same-id.json', workspaceBundle);
      writePluginBundle(
        pluginDataDir,
        'a-plugin',
        'same-id.json',
        validBundle('home-claim'),
      );
      const result = await new TrustBundleService().getTrustReport(
        { workspacePath: cwd, pluginDataDir },
        'same-id',
      );
      expect(result.source).toBe('workspace');
      expect(result.report?.claims[0].id).toBe('workspace-claim');
    });

    test('returns valid:false with the validation error for a bad bundle', async () => {
      const cwd = createWorkspace();
      writeWorkspaceBundle(cwd, 'invalid.json', { claims: 'nope' });
      const result = await new TrustBundleService().getTrustReport(
        { workspacePath: cwd },
        'invalid',
      );
      expect(result.valid).toBe(false);
      expect(result.report).toBeNull();
      expect(result.error).toBeTruthy();
    });

    test('throws not-found for an unknown bundle id', async () => {
      const cwd = createWorkspace();
      await expect(
        new TrustBundleService().getTrustReport(
          { workspacePath: cwd },
          'missing',
        ),
      ).rejects.toBeInstanceOf(TrustBundleNotFoundError);
    });
  });

  describe('veritas-evidence source', () => {
    test('surfaces the embedded bundle from the newest evidence record', async () => {
      const cwd = createWorkspace();
      const evidenceDir = writeVeritasEvidence(cwd, '100', validBundle('old'));
      // A newer record (later in iteration; mtime resolved by stat) wins.
      writeVeritasEvidence(cwd, '200', validBundle('new'));

      const result = await new TrustBundleService().listBundles({
        veritasEvidenceDir: evidenceDir,
      });
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: 'veritas-readiness',
        source: 'veritas-evidence',
        valid: true,
        bundleSource: 'station-test',
        claimCount: 1,
      });
    });

    test('reports invalid when the record has no embedded trust.bundle', async () => {
      const cwd = createWorkspace();
      const dir = join(cwd, '.kontourai', 'veritas', 'evidence');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'veritas-1.json'),
        JSON.stringify({ run_id: 'veritas-1' }),
      );
      const result = await new TrustBundleService().listBundles({
        veritasEvidenceDir: dir,
      });
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: 'veritas-readiness',
        source: 'veritas-evidence',
        valid: false,
      });
      expect(result[0].error).toMatch(/no embedded trust\.bundle/);
    });

    test('resolves the derived bundle id through getTrustReport', async () => {
      const cwd = createWorkspace();
      const evidenceDir = writeVeritasEvidence(cwd, '1', validBundle());
      const report = await new TrustBundleService().getTrustReport(
        { veritasEvidenceDir: evidenceDir },
        'veritas-readiness',
      );
      expect(report.source).toBe('veritas-evidence');
      expect(report.valid).toBe(true);
      expect(report.report).not.toBeNull();
    });

    test('contributes nothing when the evidence dir is absent', async () => {
      const cwd = createWorkspace();
      const result = await new TrustBundleService().listBundles({
        veritasEvidenceDir: join(cwd, '.veritas', 'evidence'),
      });
      expect(result).toEqual([]);
    });
  });
});
