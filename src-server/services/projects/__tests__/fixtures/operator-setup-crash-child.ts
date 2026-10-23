import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileStorageAdapter } from '../../../../domain/file-storage-adapter.js';
import {
  OperatorSetupService,
  operatorSetupPreviewSchema,
} from '../../operator-setup-service.js';
import { createProjectSessionDirectoryResolver } from '../../project-session-directory.js';

const home = process.argv[2];
if (!home) throw new Error('Missing fixture home');
const storage = new FileStorageAdapter(home);
const directory = createProjectSessionDirectoryResolver(home, storage);
const service = new OperatorSetupService(
  home,
  async (slug) => ({
    projectId: storage.getProject(slug).id,
    cwd: (await directory(slug))!,
  }),
  (slug) => storage.getProject(slug).id,
);
const request = operatorSetupPreviewSchema.parse(
  JSON.parse(readFileSync(join(home, 'crash-request.json'), 'utf8')),
);
await service.preview('setup', request, () => {});
await service.run('setup', request.id, () => {});
