import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectConfig } from '@kontourai/station-contracts/project';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  knowledgeStoreRootPathForNamespace,
  projectNamespacesToRoots,
} from '../namespace-compat.js';

function fixtureProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    id: 'proj-1',
    name: 'Acme',
    slug: 'acme',
    knowledgeNamespaces: [
      { id: 'default', label: 'Documents', behavior: 'rag' },
      { id: 'notes', label: 'Notes', behavior: 'inject' },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('projectNamespacesToRoots (K2 Wave 2 — AC4 namespace compat)', () => {
  const fixedNow = new Date('2026-07-05T12:00:00.000Z');

  test('produces one project-scoped root per namespace, with a storeRoot outside the legacy namespace/vectordb trees', () => {
    const project = fixtureProject();
    const roots = projectNamespacesToRoots(project, '/home/.station', {
      now: fixedNow,
    });

    expect(roots).toEqual([
      {
        id: 'root:project-acme:default',
        scope: { kind: 'project', projectSlug: 'acme' },
        adapterId: 'kit-default-store',
        storeRoot: '/home/.station/knowledge-stores/projects/acme/default',
        displayName: 'Documents',
        createdAt: fixedNow.toISOString(),
      },
      {
        id: 'root:project-acme:notes',
        scope: { kind: 'project', projectSlug: 'acme' },
        adapterId: 'kit-default-store',
        storeRoot: '/home/.station/knowledge-stores/projects/acme/notes',
        displayName: 'Notes',
        createdAt: fixedNow.toISOString(),
      },
    ]);

    // Never overlaps the legacy paths (knowledge-storage.ts's
    // defaultKnowledgeStorageDir / knowledgeVectorNamespace shapes).
    for (const root of roots) {
      expect(root.storeRoot).not.toContain('/projects/acme/knowledge/');
      expect(root.storeRoot).not.toContain('/vectordb/');
    }
  });

  test('a project with no knowledgeNamespaces maps to an empty array', () => {
    const project = fixtureProject({ knowledgeNamespaces: undefined });
    expect(projectNamespacesToRoots(project, '/home/.station')).toEqual([]);
  });

  test('an explicit adapterId option is honored (e.g. mapping onto kit-obsidian-store)', () => {
    const project = fixtureProject({
      knowledgeNamespaces: [
        { id: 'default', label: 'Documents', behavior: 'rag' },
      ],
    });
    const roots = projectNamespacesToRoots(project, '/home/.station', {
      now: fixedNow,
      adapterId: 'kit-obsidian-store',
    });
    expect(roots).toHaveLength(1);
    expect(roots[0].adapterId).toBe('kit-obsidian-store');
  });

  test('knowledgeStoreRootPathForNamespace matches the path embedded in the mapped root', () => {
    expect(
      knowledgeStoreRootPathForNamespace('/home/.station', 'acme', 'default'),
    ).toBe('/home/.station/knowledge-stores/projects/acme/default');
  });
});

describe('projectNamespacesToRoots — descriptor-only: zero filesystem access', () => {
  // Per the plan's own alternative verification shape ("or by running against a
  // temp dir seeded with sentinel files and asserting they are byte-identical
  // before/after"): seed real files at the LEGACY namespace/vectordb paths this
  // function must never touch, snapshot their content, call the mapping function
  // against that same temp dir as `projectHomeDir`, and assert the sentinel files
  // are byte-identical afterward — a real fs-level proof, not just an absence of a
  // `fs` import.
  let projectHomeDir: string;
  let legacyNamespaceFile: string;
  let legacyVectordbFile: string;
  let legacyNamespaceContentBefore: string;
  let legacyVectordbContentBefore: string;

  beforeEach(() => {
    projectHomeDir = mkdtempSync(join(tmpdir(), 'namespace-compat-home-'));

    const legacyNamespaceDir = join(
      projectHomeDir,
      'projects',
      'acme',
      'knowledge',
      'default',
    );
    mkdirSync(legacyNamespaceDir, { recursive: true });
    legacyNamespaceFile = join(legacyNamespaceDir, 'metadata.json');
    legacyNamespaceContentBefore = JSON.stringify([{ id: 'doc-1' }]);
    writeFileSync(legacyNamespaceFile, legacyNamespaceContentBefore, 'utf-8');

    const legacyVectordbDir = join(projectHomeDir, 'vectordb', 'project-acme');
    mkdirSync(legacyVectordbDir, { recursive: true });
    legacyVectordbFile = join(legacyVectordbDir, 'index.bin');
    legacyVectordbContentBefore = 'sentinel-vector-bytes';
    writeFileSync(legacyVectordbFile, legacyVectordbContentBefore, 'utf-8');
  });

  afterEach(() => {
    rmSync(projectHomeDir, { recursive: true, force: true });
  });

  test('mapping a project with namespaces leaves every legacy namespace/vectordb file byte-identical', () => {
    const project = fixtureProject();
    const roots = projectNamespacesToRoots(project, projectHomeDir);
    expect(roots).toHaveLength(2);

    expect(readFileSync(legacyNamespaceFile, 'utf-8')).toBe(
      legacyNamespaceContentBefore,
    );
    expect(readFileSync(legacyVectordbFile, 'utf-8')).toBe(
      legacyVectordbContentBefore,
    );

    // The mapped roots' storeRoot paths are real absolute paths under
    // projectHomeDir, but the mapping function itself never created them — no
    // migration/side-effect occurred as a result of calling it.
    for (const root of roots) {
      expect(root.storeRoot.startsWith(projectHomeDir)).toBe(true);
    }
  });
});
