import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import {
  parseWorkspacePaneDescriptor,
  parseWorkspacePaneInstance,
} from '@kontourai/station-contracts/workspace-pane';
import {
  createWorkspacePaneHostBaselineDocument,
  restoreWorkspacePaneHostDocument,
} from '@kontourai/station-contracts/workspace-pane-host';
import { describe, expect, test } from 'vitest';
import { auditCodingCompositionInventory } from '../coding-composition-inventory-gate.mjs';
import { REQUIRED_CODING_COMPOSITION_CATEGORIES } from '../coding-composition-policy.mjs';

const inventory = () =>
  JSON.parse(
    readFileSync(
      'scripts/coding-composition-capability-inventory.json',
      'utf8',
    ),
  );

describe('Coding workspace composition Stage 0 inventory', () => {
  test('walks owned package tests without following installed dependencies or accepting their proofs', () => {
    const directory = mkdtempSync('packages/.coding-inventory-');
    const owned = `${directory}/owned.test.ts`.replaceAll('\\', '/');
    const dependency =
      `${directory}/node_modules/vendor/proof.test.ts`.replaceAll('\\', '/');
    try {
      mkdirSync(resolve(directory, 'node_modules/vendor'), { recursive: true });
      writeFileSync(owned, "test('owned proof', () => {});");
      writeFileSync(dependency, "test('dependency proof', () => {});");
      symlinkSync(
        resolve(directory, 'missing-target'),
        resolve(directory, 'node_modules/broken'),
        'junction',
      );
      const value = inventory();
      value.mcpApps.displayMode.testProofs.push({
        path: owned,
        anchor: 'owned proof',
      });
      expect(
        auditCodingCompositionInventory(process.cwd(), { inventory: value }),
      ).toEqual([]);
      value.mcpApps.displayMode.testProofs.push({
        path: dependency,
        anchor: 'dependency proof',
      });
      expect(
        auditCodingCompositionInventory(process.cwd(), { inventory: value }),
      ).toContain(
        `MCP Apps display-mode mediation names missing test path ${dependency}`,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('the independently authored gate accepts current production dependencies', () => {
    expect(auditCodingCompositionInventory()).toEqual([]);
  });

  test('required categories and MCP Apps renderer-leaf boundary are explicit', () => {
    const value = inventory();
    expect(
      new Set(value.capabilities.map((row: { id: string }) => row.id)),
    ).toEqual(new Set(REQUIRED_CODING_COMPOSITION_CATEGORIES));
    expect(value.mcpApps).toMatchObject({
      role: 'sandboxed-renderer-leaf',
      workspaceAuthority: false,
      displayMode: {
        status: 'IMPLEMENTED',
        deliveryIssue: 2952,
        contract: '@kontourai/station-contracts/mcp-app-display-mode',
        receipt: 'MCPAppDisplayModeDecision',
        pip: 'UNSUPPORTED',
        fullscreenIsPopout: false,
      },
    });
  });

  test('Meeting Notes instantiates and restores through the generic host document', () => {
    const fixture = inventory().nonDeveloperCompositionFixture;
    const descriptors = fixture.descriptors.map(parseWorkspacePaneDescriptor);
    const instances = fixture.instances.map(parseWorkspacePaneInstance);
    expect(descriptors.every(Boolean)).toBe(true);
    expect(instances.every(Boolean)).toBe(true);
    const document = createWorkspacePaneHostBaselineDocument(
      'meeting-notes-composition',
      {
        kind: 'project',
        projectId: 'meeting-project',
        layoutId: 'meeting-notes',
      },
      instances,
    );
    const restored = restoreWorkspacePaneHostDocument(
      structuredClone(document),
      instances,
    );
    expect(restored.failures).toEqual([]);
    expect(restored.document?.instances).toEqual(instances);
    expect(
      descriptors.map(
        (value: ReturnType<typeof parseWorkspacePaneDescriptor>) =>
          value?.renderer.kind,
      ),
    ).toEqual(['plugin-component', 'mcp-tool-ui']);
    expect(
      descriptors.map(
        (value: ReturnType<typeof parseWorkspacePaneDescriptor>) =>
          value?.placement.supportedRegions[0],
      ),
    ).toEqual(['primary', 'secondary']);
  });

  test('fault fixtures catch unlisted authority, lost semantics, evidence drift, and vocabulary drift', () => {
    expect(
      auditCodingCompositionInventory(process.cwd(), {
        sources: {
          'src-ui/src/newCodingAuthority.ts':
            "export const endpoint = '/api/coding/new';",
        },
      }),
    ).toContain(
      'undeclared Coding dependency: src-ui/src/newCodingAuthority.ts',
    );
    expect(
      auditCodingCompositionInventory(process.cwd(), {
        sources: {
          'src-server/routes/projects/coding.ts':
            'export const unrelated = true;',
        },
      }).some((finding) => finding.includes('lost semantic anchor')),
    ).toBe(true);
    const value = inventory();
    value.mcpApps.displayMode.status = 'NOT_IMPLEMENTED';
    value.nonDeveloperCompositionFixture.descriptors[0].id = 'coding-terminal';
    value.capabilities[0].testProofs[0].anchor = 'not-present-anchor';
    expect(
      auditCodingCompositionInventory(process.cwd(), { inventory: value }),
    ).toEqual(
      expect.arrayContaining([
        'MCP Apps/display-mode boundary drifted',
        'non-developer generic-host fixture contains Coding vocabulary',
        expect.stringContaining('test anchor missing'),
      ]),
    );
    const deletedDisplayProof = inventory();
    deletedDisplayProof.mcpApps.displayMode.testProofs[0].path =
      'src-ui/src/__tests__/deleted-display-proof.test.tsx';
    expect(
      auditCodingCompositionInventory(process.cwd(), {
        inventory: deletedDisplayProof,
      }).some((finding) => finding.includes('missing test path')),
    ).toBe(true);
    const incidentalDisplayProof = inventory();
    const displayProof =
      incidentalDisplayProof.mcpApps.displayMode.testProofs[0];
    expect(
      auditCodingCompositionInventory(process.cwd(), {
        inventory: incidentalDisplayProof,
        sources: {
          [displayProof.path]:
            "test('mentions fullscreen and PiP without mediation', () => {})",
        },
      }).some((finding) => finding.includes('test anchor missing')),
    ).toBe(true);
    const missingCategory = inventory();
    missingCategory.capabilities = missingCategory.capabilities.filter(
      (row: { id: string }) => row.id !== 'files',
    );
    expect(
      auditCodingCompositionInventory(process.cwd(), {
        inventory: missingCategory,
      }),
    ).toContain('required capability category missing: files');
    expect(
      auditCodingCompositionInventory(process.cwd(), {
        requiredCategories: [
          ...REQUIRED_CODING_COMPOSITION_CATEGORIES,
          'new-owner-required-category',
        ],
      }),
    ).toContain(
      'required capability category missing: new-owner-required-category',
    );
    const deletedProof = inventory();
    deletedProof.capabilities[0].testProofs[0].path =
      'src-ui/src/__tests__/deleted-proof.test.tsx';
    expect(
      auditCodingCompositionInventory(process.cwd(), {
        inventory: deletedProof,
      }).some((finding) => finding.includes('missing test path')),
    ).toBe(true);
    const incidentalProof = inventory();
    const proof = incidentalProof.capabilities[2].testProofs[1];
    expect(
      auditCodingCompositionInventory(process.cwd(), {
        inventory: incidentalProof,
        sources: {
          [proof.path]: "test('mentions availability only', () => {})",
        },
      }).some((finding) => finding.includes('test anchor missing')),
    ).toBe(true);
    const additive = inventory();
    additive.capabilities.push({
      ...structuredClone(additive.capabilities[0]),
      id: 'future-capability',
    });
    expect(
      auditCodingCompositionInventory(process.cwd(), { inventory: additive }),
    ).not.toContain('capability ids must be unique');
  });
});
