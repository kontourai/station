import { existsSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import type {
  KnowledgeDocumentMeta,
  KnowledgeNamespaceConfig,
  KnowledgeSearchFilter,
  KnowledgeTreeNode,
} from '@kontourai/station-contracts/knowledge';
import type { IStorageAdapter } from '../../domain/storage-adapter.js';
import type { ProjectWorkspacePathOptions } from '../projects/project-workspace-path.js';
import {
  applyKnowledgeScanPatterns,
  collectKnowledgeFiles,
  DEFAULT_EXTENSIONS,
  matchesKnowledgeFilter,
  normalizeKnowledgeExtension,
  resolveKnowledgeScanPath,
} from './knowledge-scan-utils.js';
import { readKnowledgeDocuments } from './knowledge-storage.js';

export async function listKnowledgeDocuments({
  projectSlug,
  namespace,
  filter,
  dataDir,
  listNamespaces,
  resolveStorageDir,
}: {
  projectSlug: string;
  namespace?: string;
  filter?: KnowledgeSearchFilter;
  dataDir: string;
  listNamespaces(projectSlug: string): KnowledgeNamespaceConfig[];
  resolveStorageDir(projectSlug: string, namespace: string): string;
}): Promise<KnowledgeDocumentMeta[]> {
  let docs: KnowledgeDocumentMeta[];
  if (namespace) {
    const storageDir = resolveStorageDir(projectSlug, namespace);
    docs = await readKnowledgeDocuments(
      { storageDir, dataDir, projectSlug, namespace },
      (transaction) => transaction.metadata(),
    );
  } else {
    docs = [];
    for (const namespaceConfig of listNamespaces(projectSlug)) {
      const storageDir = resolveStorageDir(projectSlug, namespaceConfig.id);
      docs.push(
        ...(await readKnowledgeDocuments(
          {
            storageDir,
            dataDir,
            projectSlug,
            namespace: namespaceConfig.id,
          },
          (transaction) => transaction.metadata(),
        )),
      );
    }
  }

  if (!filter) return docs;
  return docs.filter((document) => matchesKnowledgeFilter(document, filter));
}

export async function buildKnowledgeDirectoryTree({
  projectSlug,
  namespace,
  dataDir,
  resolveStorageDir,
}: {
  projectSlug: string;
  namespace: string;
  dataDir: string;
  resolveStorageDir(projectSlug: string, namespace: string): string;
}): Promise<KnowledgeTreeNode> {
  const storageDir = resolveStorageDir(projectSlug, namespace);
  return readKnowledgeDocuments(
    { storageDir, dataDir, projectSlug, namespace },
    (transaction) => {
      const metadata = transaction.metadata();
      const metadataByPath = new Map(
        metadata.map((document) => [
          document.path || document.filename,
          document,
        ]),
      );

      const visit = (relativePath: string): KnowledgeTreeNode => {
        const children = transaction
          .listDocumentDirectory(relativePath)
          .map((entry) => {
            const childPath = relativePath
              ? `${relativePath}/${entry.name}`
              : entry.name;
            if (entry.kind === 'directory') return visit(childPath);
            const document = metadataByPath.get(childPath);
            return {
              name: entry.name,
              path: childPath,
              type: 'file' as const,
              ...(document && { doc: document }),
            };
          });
        const fileCount = children.reduce(
          (count, child) =>
            count + (child.type === 'file' ? 1 : (child.fileCount ?? 0)),
          0,
        );
        return {
          name: relativePath ? relativePath.split('/').at(-1)! : namespace,
          path: relativePath || '.',
          type: 'directory',
          fileCount,
          children,
        };
      };

      return visit('');
    },
  );
}

export async function scanKnowledgeDirectories({
  projectSlug,
  namespace = 'code',
  extensions,
  includePatterns,
  excludePatterns,
  storageAdapter,
  getNamespaceConfig,
  uploadDocument,
  workspacePathOptions,
}: {
  projectSlug: string;
  namespace?: string;
  extensions?: string[];
  includePatterns?: string[];
  excludePatterns?: string[];
  storageAdapter?: IStorageAdapter;
  /**
   * How the project's own directory is resolved when the namespace declares
   * no `storageDir` (station#1501 slice 3b). Omitted, the resolver reads the
   * ambient Station home.
   */
  workspacePathOptions?: ProjectWorkspacePathOptions;
  getNamespaceConfig(
    projectSlug: string,
    namespace: string,
  ): KnowledgeNamespaceConfig | undefined;
  uploadDocument(
    projectSlug: string,
    filename: string,
    content: string,
    source: 'directory-scan',
    namespace: string,
  ): Promise<unknown>;
}): Promise<{ indexed: number; skipped: number }> {
  const scanPath = await resolveKnowledgeScanPath(
    projectSlug,
    namespace,
    storageAdapter,
    getNamespaceConfig,
    workspacePathOptions,
  );
  if (!scanPath || !existsSync(scanPath)) return { indexed: 0, skipped: 0 };

  const allowedExtensions = extensions
    ? new Set(
        extensions.map((extension) => normalizeKnowledgeExtension(extension)),
      )
    : DEFAULT_EXTENSIONS;
  const files = collectKnowledgeFiles(scanPath, allowedExtensions);
  const filteredFiles = applyKnowledgeScanPatterns(
    files,
    scanPath,
    includePatterns,
    excludePatterns,
  );

  let indexed = 0;
  let skipped = 0;
  for (const filePath of filteredFiles) {
    try {
      const content = readFileSync(filePath, 'utf-8');
      if (content.length === 0 || content.length > 500_000) {
        skipped += 1;
        continue;
      }
      const relativePath = relative(scanPath, filePath);
      await uploadDocument(
        projectSlug,
        relativePath,
        content,
        'directory-scan',
        namespace,
      );
      indexed += 1;
    } catch (error) {
      console.debug('Failed to index file during directory scan:', error);
      skipped += 1;
    }
  }

  return { indexed, skipped };
}
