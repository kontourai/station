import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import { projectCreateSchema } from '../../../routes/schemas/schema-definitions/content.js';
import { ProjectService } from '../project-service.js';

describe('project default environment', () => {
  test('rejects a saved reference with an empty id', () => {
    expect(
      projectCreateSchema.safeParse({
        name: 'Invalid',
        defaultEnvironment: { kind: 'saved', id: '' },
      }).success,
    ).toBe(false);
  });

  test('round-trips saved refs and clears current refs instead of persisting filler', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-project-environment-'));
    const storage = new FileStorageAdapter(home);
    const service = new ProjectService(storage);
    const created = await service.createProject({
      name: 'Remote Project',
      slug: 'remote-project',
      defaultEnvironment: { kind: 'saved', id: 'env-remote' as any },
    });

    expect(service.getProject(created.slug).defaultEnvironment).toEqual({
      kind: 'saved',
      id: 'env-remote',
    });

    await service.updateProject(created.slug, {
      defaultEnvironment: { kind: 'current' },
    });
    expect(service.getProject(created.slug)).not.toHaveProperty(
      'defaultEnvironment',
    );
  });
});
