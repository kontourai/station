import { beforeEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ConfigLoader } from '../../../domain/config-loader.js';
import { LayoutService } from '../layout-service.js';

describe('LayoutService', () => {
  const makeTempDir = trackTempDirs();
  let home: string;

  beforeEach(() => {
    home = makeTempDir('station-layout-service-');
  });

  // The workflow routes reach the per-Agent workflow store only through this
  // service, and their own tests mock it. So this round trip, over a real
  // ConfigLoader on disk, is what proves each verb reaches the store with its
  // (agent, workflow) arguments in the order the store reads them.
  test('workflow create, list, read, update and delete round-trip through the Agent store', async () => {
    const loader = new ConfigLoader({ projectHomeDir: home });
    const { slug } = await loader.createAgent({
      name: 'Workflow Agent',
      prompt: 'Test',
    });
    const service = new LayoutService(loader, {});

    await service.createWorkflow(slug, 'nightly-sweep.ts', 'export default 1;');
    expect(
      (await service.listAgentWorkflows(slug)).map((workflow) => workflow.id),
    ).toEqual(['nightly-sweep.ts']);
    await expect(service.getWorkflow(slug, 'nightly-sweep.ts')).resolves.toBe(
      'export default 1;',
    );

    await service.updateWorkflow(slug, 'nightly-sweep.ts', 'export default 2;');
    await expect(service.getWorkflow(slug, 'nightly-sweep.ts')).resolves.toBe(
      'export default 2;',
    );

    await service.deleteWorkflow(slug, 'nightly-sweep.ts');
    await expect(service.listAgentWorkflows(slug)).resolves.toEqual([]);
  });
});
