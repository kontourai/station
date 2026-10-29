/**
 * Writer processes for knowledge-document-transactions.process.test.ts.
 *
 * `legacy-*` modes run the document writer Station shipped before legacy
 * documents moved onto ProjectFileTransactions: a `KnowledgeFileTransactions`
 * over the namespace directory, publishing `files/<path>` then
 * `metadata.json`. Its journal and lock are therefore the exact bytes and
 * paths an earlier build leaves behind. `project-*` modes run the current
 * owner with a crash seam. Each crash mode exits 23 at the named point.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProjectFileTransactions } from '../../../../domain/project-file-transactions.js';
import { KnowledgeFileTransactions } from '../../../../knowledge-store/adapters/shared/file-transactions.js';

const [home, projectSlug, storageDir, mode, documentPath, content, metadata] =
  process.argv.slice(2);
if (!home || !projectSlug || !storageDir || !mode || !documentPath) {
  throw new Error('home, projectSlug, storageDir, mode and path are required');
}
const readyPath = join(home, 'child-ready');
const releasePath = join(home, 'child-release');

async function waitForRelease(): Promise<void> {
  writeFileSync(readyPath, 'ready', 'utf8');
  while (!existsSync(releasePath)) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function crashAfter(count: number) {
  let publications = 0;
  return () => {
    publications += 1;
    if (publications === count) process.exit(23);
  };
}

const documentFile = join(storageDir, 'files', documentPath);
const metadataFile = join(storageDir, 'metadata.json');

if (mode.startsWith('legacy-')) {
  const files = new KnowledgeFileTransactions(storageDir, {
    afterFilePublish:
      mode === 'legacy-crash-after-first-publish'
        ? crashAfter(1)
        : mode === 'legacy-crash-after-final-publish'
          ? crashAfter(2)
          : undefined,
  });
  await files.mutate('upload-document', async () => {
    if (mode === 'legacy-hold-lock') await waitForRelease();
    files.writeText(documentFile, content ?? '');
    files.writeText(metadataFile, metadata ?? '[]\n');
  });
} else if (mode === 'project-crash-after-first-publish') {
  await new ProjectFileTransactions(home, {
    documents: { afterFilePublish: crashAfter(1) },
  }).mutateDocuments(projectSlug, storageDir, 'upload-document', (files) => {
    files.writeText(documentFile, content ?? '');
    files.writeText(metadataFile, metadata ?? '[]\n');
  });
} else {
  throw new Error(`unknown mode: ${mode}`);
}
