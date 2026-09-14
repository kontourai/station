import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type {
  LayoutConfig,
  LayoutDefinition,
} from '@kontourai/station-contracts/layout';
import type { ProjectConfig } from '@kontourai/station-contracts/project';
import { FileStorageAdapter } from './file-storage-adapter.js';
import { runOrchestrationEventMigration } from './migrations/003-orchestration-events.js';

/** Owner-scoped layout stores, never the pre-projects legacy format (#2060). */
const RESERVED_LAYOUT_ROOTS = new Set(['personal', 'instance']);

/**
 * The pre-projects `layouts/<name>/layout.json` shape: a `LayoutDefinition`,
 * which declares `tabs` at the top level and has no record identity.
 */
function isLegacyLayoutDefinition(value: unknown): value is LayoutDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate.tabs)) return false;
  if (typeof candidate.slug !== 'string' || candidate.slug.length === 0) {
    return false;
  }
  return candidate.owner === undefined && candidate.projectSlug === undefined;
}

const BUILTIN_VECTOR_DB_ID = 'lancedb-builtin';
const BUILTIN_VECTOR_DB_NAME = 'Station Built-In';

export async function runStartupMigrations(
  projectHomeDir: string,
): Promise<void> {
  runOrchestrationEventMigration(projectHomeDir);

  // Seed default provider connections (runs every startup, idempotent)
  const storageAdapter = new FileStorageAdapter(projectHomeDir);
  const existing = storageAdapter.listProviderConnections();
  const builtinVectorDb = existing.find(
    (connection) =>
      connection.id === BUILTIN_VECTOR_DB_ID && connection.type === 'lancedb',
  );
  if (builtinVectorDb && builtinVectorDb.name !== BUILTIN_VECTOR_DB_NAME) {
    await storageAdapter.saveProviderConnection({
      ...builtinVectorDb,
      name: BUILTIN_VECTOR_DB_NAME,
    });
  }
  if (!existing.some((c) => c.capabilities.includes('vectordb'))) {
    await storageAdapter.saveProviderConnection({
      id: BUILTIN_VECTOR_DB_ID,
      type: 'lancedb',
      name: BUILTIN_VECTOR_DB_NAME,
      config: { dataDir: `${projectHomeDir}/vectordb` },
      enabled: true,
      capabilities: ['vectordb'] as ('llm' | 'embedding' | 'vectordb')[],
    });
  }

  const projectsDir = join(projectHomeDir, 'projects');

  if (existsSync(projectsDir)) return;

  const layoutsDir = join(projectHomeDir, 'layouts');
  const legacyLayoutDefinitions: LayoutDefinition[] = [];

  if (existsSync(layoutsDir)) {
    for (const entry of readdirSync(layoutsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      // `layouts/personal` and `layouts/instance` are the owner-scoped stores
      // (#2060), not the pre-projects layout format this migration reads. A
      // home with Boards and no projects is a valid CURRENT state, and
      // sweeping those roots migrated live records into a phantom `default`
      // project — dropping everything the legacy shape has no field for.
      if (RESERVED_LAYOUT_ROOTS.has(entry.name)) continue;
      const layoutFile = join(layoutsDir, entry.name, 'layout.json');
      if (!existsSync(layoutFile)) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(layoutFile, 'utf-8'));
      } catch (e) {
        console.debug(
          'Failed to parse layout file during migration:',
          layoutFile,
          e,
        );
        continue;
      }
      // Require the legacy shape rather than trusting the path: a
      // `LayoutDefinition` declares `tabs`, and an owner-scoped
      // `LayoutConfig` declares `owner`/`projectSlug` and keeps its tabs
      // inside `config`. Migrating the latter would rewrite a record that is
      // already in its final form.
      if (!isLegacyLayoutDefinition(parsed)) continue;
      legacyLayoutDefinitions.push(parsed);
    }
  }

  // Nothing legacy to migrate: leave a fresh (or layouts-but-nothing-
  // parseable) home with no `projects/` directory at all, so the app's
  // designed zero-project empty state renders instead of a phantom
  // `Default` project. A pre-placed `projects/<slug>/project.json` (the
  // documented distributor provisioning contract) is covered by the
  // `existsSync(projectsDir)` early return above and is never touched here.
  if (legacyLayoutDefinitions.length === 0) return;

  const now = new Date().toISOString();
  const project: ProjectConfig = {
    id: randomUUID(),
    name: 'Default',
    slug: 'default',
    createdAt: now,
    updatedAt: now,
  };

  const defaultProjectDir = join(projectsDir, 'default');
  const projectLayoutsDir = join(defaultProjectDir, 'layouts');
  mkdirSync(projectLayoutsDir, { recursive: true });

  writeFileSync(
    join(defaultProjectDir, 'project.json'),
    JSON.stringify(project, null, 2),
    'utf-8',
  );

  for (const sl of legacyLayoutDefinitions) {
    const layout: LayoutConfig = {
      id: randomUUID(),
      projectSlug: 'default',
      type: 'chat',
      name: sl.name,
      slug: sl.slug,
      icon: sl.icon,
      description: sl.description,
      config: {
        tabs: sl.tabs,
        defaultAgent: sl.defaultAgent,
        availableAgents: sl.availableAgents,
      },
      createdAt: now,
      updatedAt: now,
    };

    writeFileSync(
      join(projectLayoutsDir, `${sl.slug}.json`),
      JSON.stringify(layout, null, 2),
      'utf-8',
    );
  }
}
