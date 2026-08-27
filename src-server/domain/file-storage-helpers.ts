// The JSON-file storage primitives moved to @kontourai/station-shared/json-file-storage
// so the published CLI stops bundling server internals through deep relative
// imports (2026-08-24 architecture pass; ADR-0005's second consumer existed).
// This module re-exports them for the server tree and keeps the one helper
// that genuinely depends on server-only schema parsing.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProjectConfig } from './file-storage-schemas.js';

export * from '@kontourai/station-shared/json-file-storage';

export function listProjectSlugs(projectHomeDir: string): string[] {
  const dir = join(projectHomeDir, 'projects');
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export function resolveProjectSlugById(
  projectHomeDir: string,
  projectId: string,
): string {
  for (const slug of listProjectSlugs(projectHomeDir)) {
    const projectPath = join(projectHomeDir, 'projects', slug, 'project.json');
    let project: ReturnType<typeof parseProjectConfig>;
    try {
      project = parseProjectConfig(
        JSON.parse(readFileSync(projectPath, 'utf-8')),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (project.id === projectId) {
      return slug;
    }
  }
  throw new Error(`Project not found for id: ${projectId}`);
}
