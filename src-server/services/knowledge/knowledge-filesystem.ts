import { existsSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import type {
  KnowledgeDocumentMeta,
  KnowledgeNamespaceConfig,
  KnowledgeSearchFilter,
  KnowledgeTreeNode,
} from '@kontourai/station-contracts/knowledge';
import type { IStorageAdapter } from '../../domain/storage-adapter.js';
import { createLogger } from '../../utils/logger.js';
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

const logger = createLogger({ name: 'knowledge-filesystem' });

/** Longest document, in characters, a directory scan indexes. */
const MAX_SCANNED_DOCUMENT_CHARACTERS = 500_000;
/**
 * Largest file a directory scan reads at all. UTF-8 spends at most three
 * bytes on one UTF-16 code unit, so a file above this size always decodes to
 * more than `MAX_SCANNED_DOCUMENT_CHARACTERS` and is skipped without being
 * read. A file at or below it is read and measured exactly as before.
 */
const MAX_SCANNED_FILE_BYTES = MAX_SCANNED_DOCUMENT_CHARACTERS * 3;

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
   * no `storageDir` (archive#1501). Omitted, the resolver reads the
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
  // The patterns are applied inside the walk, so the walk's file cap counts
  // files this scan will index rather than files the patterns then discard.
  const files = await collectKnowledgeFiles(
    scanPath,
    allowedExtensions,
    (filePath) =>
      applyKnowledgeScanPatterns(
        [filePath],
        scanPath,
        includePatterns,
        excludePatterns,
      ).length > 0,
  );

  let indexed = 0;
  let skipped = 0;
  for (const filePath of files) {
    try {
      // Size first: an empty or oversized file is skipped without its bytes
      // ever being read into memory. `lstat`, so a file swapped for a link
      // since the walk is not read through either.
      const info = await lstat(filePath);
      if (
        !info.isFile() ||
        info.size === 0 ||
        info.size > MAX_SCANNED_FILE_BYTES
      ) {
        skipped += 1;
        continue;
      }
      const content = await readFile(filePath, 'utf-8');
      if (
        content.length === 0 ||
        content.length > MAX_SCANNED_DOCUMENT_CHARACTERS
      ) {
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
      logger.debug('Failed to index file during directory scan', { error });
      skipped += 1;
    }
  }

  return { indexed, skipped };
}
