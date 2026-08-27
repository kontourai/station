import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { KnowledgeDocumentMeta } from '@kontourai/station-contracts/knowledge';
import { KnowledgeFileTransactions } from '../../knowledge-store/adapters/shared/file-transactions.js';
import { KnowledgeStoreCorruptionError } from '../../knowledge-store/errors.js';

export const DEFAULT_KNOWLEDGE_NAMESPACE = 'default';

function isSafeDocumentRelativePath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  return (
    path.length > 0 &&
    !path.includes('\0') &&
    !isAbsolute(path) &&
    !normalized.startsWith('/') &&
    !/^[a-zA-Z]:/.test(normalized) &&
    !normalized.split('/').includes('..')
  );
}

function validateDocumentMeta(
  value: unknown,
  source: string,
  expectedNamespace?: string,
): KnowledgeDocumentMeta[] {
  if (!Array.isArray(value)) {
    throw new KnowledgeStoreCorruptionError(
      `${source}: knowledge metadata must be an array`,
    );
  }
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const entry of value) {
    const fields = entry as Record<string, unknown>;
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      typeof entry.id !== 'string' ||
      !entry.id ||
      typeof entry.filename !== 'string' ||
      !entry.filename ||
      typeof entry.namespace !== 'string' ||
      !entry.namespace ||
      (expectedNamespace !== undefined &&
        entry.namespace !== expectedNamespace) ||
      typeof entry.path !== 'string' ||
      !isSafeDocumentRelativePath(entry.path) ||
      !['upload', 'directory-scan', 'sync'].includes(String(entry.source)) ||
      !Number.isInteger(entry.chunkCount) ||
      entry.chunkCount < 0 ||
      (entry.contentHash !== undefined &&
        (typeof entry.contentHash !== 'string' ||
          !/^[a-f0-9]{64}$/.test(entry.contentHash))) ||
      typeof entry.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(entry.createdAt)) ||
      (entry.updatedAt !== undefined &&
        (typeof entry.updatedAt !== 'string' ||
          !Number.isFinite(Date.parse(entry.updatedAt)))) ||
      (entry.metadata !== undefined &&
        (!entry.metadata ||
          typeof entry.metadata !== 'object' ||
          Array.isArray(entry.metadata))) ||
      [
        'eventId',
        'eventSubject',
        'enhancedFrom',
        'enhancedTo',
        'storagePath',
      ].some(
        (field) =>
          fields[field] !== undefined && typeof fields[field] !== 'string',
      ) ||
      (entry.status !== undefined &&
        entry.status !== 'raw' &&
        entry.status !== 'enhanced')
    ) {
      throw new KnowledgeStoreCorruptionError(
        `${source}: knowledge metadata contains an invalid document`,
      );
    }
    if (ids.has(entry.id) || paths.has(entry.path)) {
      throw new KnowledgeStoreCorruptionError(
        `${source}: knowledge metadata contains duplicate document identity`,
      );
    }
    ids.add(entry.id);
    paths.add(entry.path);
  }
  return value as KnowledgeDocumentMeta[];
}

function parseMetadata(
  raw: string,
  source: string,
  expectedNamespace?: string,
): KnowledgeDocumentMeta[] {
  try {
    return validateDocumentMeta(JSON.parse(raw), source, expectedNamespace);
  } catch (error) {
    if (error instanceof KnowledgeStoreCorruptionError) throw error;
    throw new KnowledgeStoreCorruptionError(
      `${source}: knowledge metadata is corrupt`,
      { cause: error },
    );
  }
}

function safeDocumentPath(storageDir: string, filePath: string): string {
  if (typeof filePath !== 'string' || !isSafeDocumentRelativePath(filePath)) {
    throw new KnowledgeStoreCorruptionError(
      'Knowledge document path is invalid',
    );
  }
  const filesRoot = resolve(storageDir, 'files');
  const target = resolve(filesRoot, filePath);
  const rel = relative(filesRoot, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new KnowledgeStoreCorruptionError(
      'Knowledge document path escapes its namespace',
    );
  }
  return target;
}

export interface KnowledgeDocumentFileTransaction {
  metadata(): KnowledgeDocumentMeta[];
  replaceMetadata(docs: KnowledgeDocumentMeta[]): void;
  readDocument(filePath: string): string | null;
  writeDocument(filePath: string, content: string): void;
  removeDocument(filePath: string): void;
  listDocumentDirectory(
    relativePath: string,
  ): Array<{ name: string; kind: 'file' | 'directory' }>;
}

function documentTransaction(
  files: KnowledgeFileTransactions,
  storageDir: string,
  dataDir: string,
  projectSlug: string,
  namespace: string,
): KnowledgeDocumentFileTransaction {
  return {
    metadata: () => {
      const metadataPath = join(storageDir, 'metadata.json');
      const current = files.readText(metadataPath);
      if (current !== null) {
        return parseMetadata(current, metadataPath, namespace);
      }
      return loadLegacyKnowledgeMeta(dataDir, projectSlug, namespace, (path) =>
        files.readExternalText(path),
      );
    },
    replaceMetadata: (docs) => {
      validateDocumentMeta(docs, join(storageDir, 'metadata.json'), namespace);
      files.writeText(
        join(storageDir, 'metadata.json'),
        `${JSON.stringify(docs, null, 2)}\n`,
      );
    },
    readDocument: (filePath) =>
      files.readText(safeDocumentPath(storageDir, filePath)),
    writeDocument: (filePath, content) =>
      files.writeText(safeDocumentPath(storageDir, filePath), content),
    removeDocument: (filePath) =>
      files.remove(safeDocumentPath(storageDir, filePath)),
    listDocumentDirectory: (relativePath) =>
      files.listDirectoryEntries(
        safeDocumentPath(storageDir, relativePath || '.'),
      ),
  };
}

export async function mutateKnowledgeDocuments<T>(
  input: {
    storageDir: string;
    dataDir: string;
    projectSlug: string;
    namespace: string;
    operation: string;
  },
  body: (transaction: KnowledgeDocumentFileTransaction) => T | Promise<T>,
): Promise<T> {
  const files = new KnowledgeFileTransactions(input.storageDir);
  return files.mutate(input.operation, () =>
    body(
      documentTransaction(
        files,
        input.storageDir,
        input.dataDir,
        input.projectSlug,
        input.namespace,
      ),
    ),
  );
}

export async function readKnowledgeDocuments<T>(
  input: {
    storageDir: string;
    dataDir: string;
    projectSlug: string;
    namespace: string;
  },
  body: (transaction: KnowledgeDocumentFileTransaction) => T | Promise<T>,
): Promise<T> {
  const files = new KnowledgeFileTransactions(input.storageDir);
  return files.read(() =>
    body(
      documentTransaction(
        files,
        input.storageDir,
        input.dataDir,
        input.projectSlug,
        input.namespace,
      ),
    ),
  );
}

export function chunkKnowledgeText(text: string, maxChunkSize = 500): string[] {
  const sections = text.split(/(?=^#{1,6}\s)/m);
  const chunks: string[] = [];
  let current = '';

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    if (current.length + trimmed.length + 2 <= maxChunkSize) {
      current = current ? `${current}\n\n${trimmed}` : trimmed;
      continue;
    }

    if (current) chunks.push(current);
    if (trimmed.length <= maxChunkSize) {
      current = trimmed;
      continue;
    }

    const paragraphs = trimmed.split(/\n\n+/);
    current = '';
    for (const paragraph of paragraphs) {
      const trimmedParagraph = paragraph.trim();
      if (!trimmedParagraph) continue;

      if (current.length + trimmedParagraph.length + 2 <= maxChunkSize) {
        current = current
          ? `${current}\n\n${trimmedParagraph}`
          : trimmedParagraph;
        continue;
      }

      if (current) chunks.push(current);
      if (trimmedParagraph.length <= maxChunkSize) {
        current = trimmedParagraph;
        continue;
      }

      current = '';
      for (const line of trimmedParagraph.split(/\n/)) {
        const trimmedLine = line.trim();
        if (!trimmedLine) continue;
        if (current.length + trimmedLine.length + 1 <= maxChunkSize) {
          current = current ? `${current}\n${trimmedLine}` : trimmedLine;
        } else {
          if (current) chunks.push(current);
          current = trimmedLine;
        }
      }
    }
  }

  if (current) chunks.push(current);
  if (chunks.length <= 1) return chunks;

  const overlapped: string[] = [chunks[0]];
  for (let index = 1; index < chunks.length; index += 1) {
    const overlap = chunks[index - 1].slice(-50).trimStart();
    overlapped.push(`${overlap}\n\n${chunks[index]}`);
  }
  return overlapped;
}

export function parseKnowledgeFrontmatter(content: string): {
  metadata: Record<string, any>;
  body: string;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { metadata: {}, body: content };

  const yamlBlock = match[1];
  const body = match[2];
  const metadata: Record<string, any> = {};

  for (const line of yamlBlock.split('\n')) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const [, key, rawVal] = kv;
    const value = rawVal.trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      metadata[key] = value
        .slice(1, -1)
        .split(',')
        .map((segment) => segment.trim().replace(/^["']|["']$/g, ''));
    } else if (value === 'true') {
      metadata[key] = true;
    } else if (value === 'false') {
      metadata[key] = false;
    } else if (/^\d+$/.test(value)) {
      metadata[key] = Number(value);
    } else {
      metadata[key] = value.replace(/^["']|["']$/g, '');
    }
  }

  return { metadata, body };
}

export function serializeKnowledgeFrontmatter(
  metadata: Record<string, any>,
  body: string,
): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.join(', ')}]`);
    } else if (typeof value === 'string' && value.includes(':')) {
      lines.push(`${key}: "${value}"`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  if (lines.length === 0) return body;
  return `---\n${lines.join('\n')}\n---\n${body}`;
}

export function defaultKnowledgeStorageDir(
  dataDir: string,
  projectSlug: string,
  namespace: string,
): string {
  return join(dataDir, 'projects', projectSlug, 'knowledge', namespace);
}

function legacyNamespaceMetaFile(
  dataDir: string,
  projectSlug: string,
  namespace: string,
): string {
  return join(
    dataDir,
    'projects',
    projectSlug,
    'documents',
    `metadata-${namespace}.json`,
  );
}

function legacyFlatMetaFile(dataDir: string, projectSlug: string): string {
  return join(dataDir, 'projects', projectSlug, 'documents', 'metadata.json');
}

function loadLegacyKnowledgeMeta(
  dataDir: string,
  projectSlug: string,
  namespace: string,
  readLegacyText: (path: string) => string | null,
): KnowledgeDocumentMeta[] {
  const oldNamespaceFile = legacyNamespaceMetaFile(
    dataDir,
    projectSlug,
    namespace,
  );
  const oldNamespace = readLegacyText(oldNamespaceFile);
  if (oldNamespace !== null) {
    return parseMetadata(oldNamespace, oldNamespaceFile, namespace);
  }

  if (namespace === DEFAULT_KNOWLEDGE_NAMESPACE) {
    const flatFile = legacyFlatMetaFile(dataDir, projectSlug);
    const flat = readLegacyText(flatFile);
    if (flat !== null) {
      let docs: unknown;
      try {
        docs = JSON.parse(flat);
      } catch (error) {
        throw new KnowledgeStoreCorruptionError(
          `${flatFile}: legacy knowledge metadata is corrupt`,
          { cause: error },
        );
      }
      if (!Array.isArray(docs)) {
        throw new KnowledgeStoreCorruptionError(
          `${flatFile}: legacy knowledge metadata must be an array`,
        );
      }
      const migrated = docs.map((doc) => ({
        ...(doc as object),
        namespace: DEFAULT_KNOWLEDGE_NAMESPACE,
      }));
      return validateDocumentMeta(
        migrated,
        flatFile,
        DEFAULT_KNOWLEDGE_NAMESPACE,
      );
    }
  }

  return [];
}

export async function saveKnowledgeMeta(
  storageDir: string,
  docs: KnowledgeDocumentMeta[],
): Promise<void> {
  const files = new KnowledgeFileTransactions(storageDir);
  await files.mutate('replace-document-metadata', () => {
    validateDocumentMeta(docs, join(storageDir, 'metadata.json'));
    files.writeText(
      join(storageDir, 'metadata.json'),
      `${JSON.stringify(docs, null, 2)}\n`,
    );
  });
}

export function knowledgeVectorNamespace(
  projectSlug: string,
  namespace: string,
): string {
  return namespace === DEFAULT_KNOWLEDGE_NAMESPACE
    ? `project-${projectSlug}`
    : `project-${projectSlug}:${namespace}`;
}
