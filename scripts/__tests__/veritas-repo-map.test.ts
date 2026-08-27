/**
 * Repo Map contract test (Veritas 1.5).
 *
 * Replaces the retired scripts/veritas-report.mjs test. Its load-bearing
 * protection is route selection: runtime/server changes must keep selecting
 * the connected-agents behavioral suite (the move-to-test replacement proof
 * for the runtime-contracts family), and the required governance gate must
 * stay wired. See docs/strategy/veritas/migration-0.5-record.md.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error -- @kontourai/veritas ships untyped ESM
import { classifyNodes } from '@kontourai/veritas';
import { describe, expect, it } from 'vitest';
import {
  findUnexecutableRoutedProofFamilyIds,
  runRepoGovernanceChecks,
} from '../proof-family-lane.mjs';

const rootDir = process.cwd();

function readJson(relativePath: string) {
  return JSON.parse(readFileSync(resolve(rootDir, relativePath), 'utf8'));
}

const repoMap = readJson('.veritas/repo-map.json');
const standards = readJson(
  '.veritas/repo-standards/default.repo-standards.json',
);
const inventory = readJson(
  '.veritas/proof-families/repo-guardrails.families.json',
);
const claimStore = readJson('veritas.claims.json');
const packageJson = readJson('package.json');
const veritasReadme = readFileSync(
  resolve(rootDir, '.veritas/README.md'),
  'utf8',
);

interface EvidenceCheckRoute {
  nodeIds: string[];
  componentIds?: string[];
  evidenceCheckIds: string[];
}

function routes(): EvidenceCheckRoute[] {
  return repoMap.evidence.evidenceCheckRoutes ?? [];
}

// 0.5.0 runtime matches routes on componentIds while the published schema
// documents nodeIds; the repo-map carries both. Route on the runtime key.
function routedCheckIdsFor(nodeId: string): string[] {
  return routes()
    .filter((route) => (route.componentIds ?? []).includes(nodeId))
    .flatMap((route) => route.evidenceCheckIds);
}

/**
 * The declared major for a dependency, resolved from whichever section holds
 * it and independent of `^`/`~`/exact pinning. Throws rather than returning a
 * sentinel when the dependency is absent, so a rename fails saying what is
 * missing instead of comparing `undefined`.
 */
function dependencyMajor(
  manifest: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  },
  name: string,
): number {
  const range =
    manifest.dependencies?.[name] ?? manifest.devDependencies?.[name];
  if (range === undefined)
    throw new Error(
      `${name} is in neither dependencies nor devDependencies of package.json`,
    );
  const major = /^[\^~]?(\d+)\./.exec(range)?.[1];
  if (major === undefined)
    throw new Error(`${name} version "${range}" has no leading major`);
  return Number(major);
}

describe('veritas repo map (1.5)', () => {
  it('maps files to the expected work areas', () => {
    const result = classifyNodes(
      [
        'src-server/routes/chat/chat.ts',
        'packages/sdk/src/index.ts',
        '.github/workflows/ci.yml',
        'tests/registry.spec.ts',
        'package.json',
      ],
      repoMap,
      rootDir,
    );

    expect(result.affectedNodes).toEqual(
      expect.arrayContaining([
        'product.src-server',
        'package.sdk',
        'delivery.github',
        'verification.tests',
        'governance.root-manifests',
      ]),
    );
    expect(result.unmatchedFiles).toEqual([]);
  });

  it('does not treat root-manifest prefixes as exact matches', () => {
    const result = classifyNodes(['package.json.backup'], repoMap, rootDir);
    expect(result.affectedNodes).toEqual([]);
    expect(result.unmatchedFiles).toEqual(['package.json.backup']);
  });

  it('keeps repo-governance required and verification-policy default-only', () => {
    expect(repoMap.evidence.requiredEvidenceCheckIds).toEqual([
      'repo-governance',
    ]);
    expect(repoMap.evidence.defaultEvidenceCheckIds).toContain(
      'repo-governance',
    );
    expect(repoMap.evidence.defaultEvidenceCheckIds).toContain(
      'verification-policy',
    );
    expect(repoMap.evidence.requiredEvidenceCheckIds).not.toContain(
      'verification-policy',
    );
    expect(
      repoMap.evidence.evidenceChecks.find(
        (check: { id: string }) => check.id === 'verification-policy',
      ),
    ).toMatchObject({
      command: 'npm run verification:policy:gate',
      method: 'validation',
    });
    expect(veritasReadme).toContain('`verification-policy` (default)');
  });

  it('keeps generated evidence and external-tool artifacts in the Veritas 1.5 artifact root', () => {
    expect(repoMap.evidence.artifactDir).toBe('.kontourai/veritas/evidence');
    const externalArtifacts = repoMap.evidence.evidenceChecks
      .map(
        (check: { externalTool?: { artifactPath?: string } }) =>
          check.externalTool?.artifactPath,
      )
      .filter(Boolean);
    expect(externalArtifacts).not.toHaveLength(0);
    expect(
      externalArtifacts.every((path: string) =>
        path.startsWith('.kontourai/veritas/'),
      ),
    ).toBe(true);
  });

  it('keeps Veritas and Surface on compatible contracts and authors claim facets', () => {
    // This assertion IS the compatibility declaration — nothing else in the
    // repo records which majors Station is built against — so a major bump
    // SHOULD red it until a human acknowledges the migration here. Surface
    // 2 -> 3 was that acknowledgement (station#4440).
    //
    // What it must NOT red on is where the dependency is declared or how it
    // is pinned. It went stale three ways at once: Veritas moved
    // devDependencies -> dependencies (which read back `undefined` and threw
    // before the Surface line was even reached), and Surface is pinned
    // EXACTLY, which is this repo's majority convention for Kontour siblings
    // (conduit, dispatch, flow, thread, ... are all exact). So resolve from
    // either section and compare the major, not the range syntax.
    expect(dependencyMajor(packageJson, '@kontourai/veritas')).toBe(1);
    expect(dependencyMajor(packageJson, '@kontourai/surface')).toBe(3);
    expect(claimStore.claims.length).toBeGreaterThan(0);
    for (const claim of claimStore.claims) {
      expect(claim.facet).toEqual(expect.any(String));
      expect(claim).not.toHaveProperty('surface');
    }
  });

  it('routes runtime server changes to connected-agents as replacement proof', () => {
    const routed = routedCheckIdsFor('product.src-server');
    expect(routed).toEqual(['connected-agents']);
  });

  it('keeps assertion-free proof families out of readiness routing', () => {
    expect(findUnexecutableRoutedProofFamilyIds(repoMap, inventory)).toEqual(
      [],
    );

    expect(routedCheckIdsFor('product.src-ui')).toEqual([]);
    expect(routedCheckIdsFor('package.sdk')).toEqual([]);
  });

  it('rejects a fault-injected assertion-free proof-family route', () => {
    const nonConformantRoute: EvidenceCheckRoute = {
      nodeIds: ['package.sdk'],
      componentIds: ['package.sdk'],
      evidenceCheckIds: ['architecture-boundaries'],
    };

    const nonConformantRepoMap = {
      ...repoMap,
      evidence: {
        ...repoMap.evidence,
        evidenceCheckRoutes: [nonConformantRoute],
      },
    };

    expect(
      findUnexecutableRoutedProofFamilyIds(nonConformantRepoMap, inventory),
    ).toEqual(['architecture-boundaries']);
    expect(
      runRepoGovernanceChecks({
        routeErrorEgressCheck: () => [],
        repoMap: nonConformantRepoMap,
        proofFamilyManifest: inventory,
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'routed-proof-family-not-executable',
          severity: 'block',
        }),
      ]),
    );
  });

  it('keeps schema nodeIds and runtime componentIds in sync on every route', () => {
    for (const route of routes()) {
      expect(route.componentIds).toEqual(route.nodeIds);
    }
  });

  it('only routes declared evidence checks', () => {
    const declared = new Set(
      repoMap.evidence.evidenceChecks.map((check: { id: string }) => check.id),
    );
    const referenced = [
      ...repoMap.evidence.requiredEvidenceCheckIds,
      ...repoMap.evidence.defaultEvidenceCheckIds,
      ...(repoMap.evidence.evidenceCheckRoutes ?? []).flatMap(
        (route: { evidenceCheckIds: string[] }) => route.evidenceCheckIds,
      ),
    ];
    for (const id of referenced) {
      expect(declared).toContain(id);
    }
  });

  it('declares the check-family inventory manifest', () => {
    expect(repoMap.evidence.evidenceInventoryManifests).toContain(
      '.veritas/proof-families/repo-guardrails.families.json',
    );
    expect(inventory.items.length).toBeGreaterThan(0);
    const repoGovernance = inventory.items.find(
      (item: { id: string }) => item.id === 'repo-governance',
    );
    expect(repoGovernance).toMatchObject({
      defaultDisposition: 'required',
      evidenceCheckId: 'repo-governance',
    });
  });

  it('keeps the migrated trust-contract requirements in repo standards', () => {
    const ruleIds = standards.rules.map((rule: { id: string }) => rule.id);
    expect(ruleIds).toEqual(
      expect.arrayContaining([
        'required-station-governance-artifacts',
        'ai-instruction-files-synced',
        'forbid-shared-root-imports',
        'brownfield-gap-log-present',
      ]),
    );
  });

  it('keeps every rule on the 1.5 enforcementLevel field and off the inert stage field', () => {
    // `stage` was never in veritas-repo-standards.schema.json, and
    // src/rules/result.mjs reads `enforcementLevel` alone — so a rule carrying
    // only `stage` is advisory no matter what it says, which is how
    // `"stage": "block"` rules sat unarmed from the 1.5 migration until
    // station#1561 caught it. A rule that reintroduces `stage` reads as armed
    // and is not, so assert the absence rather than trusting review.
    for (const rule of standards.rules as Record<string, unknown>[]) {
      expect(
        rule,
        `rule ${String(rule.id)} carries the inert stage field`,
      ).not.toHaveProperty('stage');
      expect(
        ['Observe', 'Guide', 'Require'],
        `rule ${String(rule.id)}`,
      ).toContain(rule.enforcementLevel);
    }
  });

  it('keeps the delivery-conduct standards routable, and blocking only where attested', () => {
    // Enforcement level per rule is a human decision recorded by
    // `veritas attest policy-change`; this pins the current decision so a
    // promotion or demotion cannot land as an unreviewed config edit.
    // Two promoted on the station#1480 owner-approved plan; the other two are
    // held at Guide with per-rule reasons on that issue, and their date gate
    // is replaced by an evidence trigger recorded in each explain.summary.
    const expectedLevels: Record<string, string> = {
      'trust-surfaces-name-their-gaps': 'Require',
      'evidence-claims-anchor-to-executed-commands': 'Guide',
      'read-paths-join-exactly-and-never-write': 'Guide',
      'verification-conduct-sentinels-and-fault-injection': 'Require',
    };
    const deliveryRuleIds = Object.keys(expectedLevels);
    const byId = new Map<string, Record<string, unknown>>(
      standards.rules.map((rule: { id: string }) => [rule.id, rule]),
    );

    for (const id of deliveryRuleIds) {
      const rule = byId.get(id);
      expect(rule, `missing delivery-conduct rule ${id}`).toBeDefined();
      expect(rule?.enforcementLevel, `enforcement level for ${id}`).toBe(
        expectedLevels[id],
      );
      expect(rule?.classification).not.toBe('hard-invariant');
      // The routing key is also the deterministic check: every listed path
      // must exist, or `veritas explain --file` stops reaching agents.
      const artifacts = (rule?.match as { artifacts?: string[] })?.artifacts;
      expect(artifacts?.length ?? 0).toBeGreaterThan(0);
      for (const artifact of artifacts ?? []) {
        expect(
          existsSync(resolve(rootDir, artifact)),
          `${id} references missing artifact ${artifact}`,
        ).toBe(true);
      }
      // Each rule points at the protocol it codifies, and every pointer it
      // hands an agent has to resolve — a dead contextLink degrades the
      // just-in-time guidance silently.
      const contextLinks = (rule?.explain as { contextLinks?: string[] })
        ?.contextLinks;
      expect(contextLinks).toContain(
        'docs/strategy/multi-agent-delivery-protocol.md',
      );
      for (const link of contextLinks ?? []) {
        expect(
          existsSync(resolve(rootDir, link)),
          `${id} references missing contextLink ${link}`,
        ).toBe(true);
      }
    }
  });

  it('routes the delivery-conduct work areas to their existing lanes only', () => {
    // New work areas must reuse the lane their parent area already runs, so
    // naming a surface adds guidance without adding an evidence command.
    expect(routedCheckIdsFor('product.src-ui.trust-surfaces')).toEqual(
      routedCheckIdsFor('product.src-ui'),
    );
    expect(routedCheckIdsFor('product.src-server.evidence-services')).toEqual(
      routedCheckIdsFor('product.src-server'),
    );
  });

  it('classifies a trust surface and an evidence service into their work areas', () => {
    const result = classifyNodes(
      [
        'src-ui/src/components/trust/TrustPanel.tsx',
        'src-server/services/evidence/command-evidence-routing-policy.ts',
      ],
      repoMap,
      rootDir,
    );

    expect(result.affectedNodes).toEqual(
      expect.arrayContaining([
        'product.src-ui',
        'product.src-ui.trust-surfaces',
        'product.src-server',
        'product.src-server.evidence-services',
      ]),
    );
    expect(result.unmatchedFiles).toEqual([]);
  });
});
