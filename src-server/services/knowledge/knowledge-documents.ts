import crypto from 'node:crypto';
import { join } from 'node:path';
import {
  type KnowledgeDocumentMeta,
  type KnowledgeNamespaceConfig,
} from '@kontourai/station-contracts/knowledge';
import type {
  IEmbeddingProvider,
  IVectorDbProvider,
} from '../../providers/llm/model-provider-types.js';
import { observeKnowledgeDerivedFailure } from './knowledge-observability.js';
import {
  chunkKnowledgeText,
  knowledgeVectorNamespace,
  mutateKnowledgeDocuments,
  parseKnowledgeFrontmatter,
  readKnowledgeDocuments,
  serializeKnowledgeFrontmatter,
} from './knowledge-storage.js';

interface KnowledgeDocumentDeps {
  vectorDb: IVectorDbProvider | null;
  embeddingProvider: IEmbeddingProvider | null;
  dataDir: string;
  resolveStorageDir: (projectSlug: string, namespace: string) => string;
  getNamespaceConfig: (
    projectSlug: string,
    namespace: string,
  ) => KnowledgeNamespaceConfig | undefined;
  findDocNamespace: (
    projectSlug: string,
    docId: string,
  ) => Promise<string | null>;
}

function contentHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function replaceDerivedVectors(
  vectorDb: IVectorDbProvider,
  input: {
    namespace: string;
    docId: string;
    filename: string;
    contentHash: string;
    oldChunkCount: number;
    chunks: string[];
    vectors: number[][];
  },
): Promise<void> {
  try {
    if (!(await vectorDb.namespaceExists(input.namespace))) {
      await vectorDb.createNamespace(input.namespace);
    }
    if (input.oldChunkCount > 0) {
      await vectorDb.deleteDocuments(
        input.namespace,
        Array.from(
          { length: input.oldChunkCount },
          (_, index) => `${input.docId}:${index}`,
        ),
      );
    }
    if (input.chunks.length > 0) {
      await vectorDb.addDocuments(
        input.namespace,
        input.chunks.map((text, index) => ({
          id: `${input.docId}:${index}`,
          vector: input.vectors[index],
          text,
          metadata: {
            docId: input.docId,
            filename: input.filename,
            contentHash: input.contentHash,
            chunkIndex: index,
          },
        })),
      );
    }
  } catch (error) {
    observeKnowledgeDerivedFailure('replace-document-vectors', error);
  }
}

export async function uploadKnowledgeDocument(
  deps: KnowledgeDocumentDeps,
  projectSlug: string,
  filename: string,
  content: string,
  source: 'upload' | 'directory-scan' | 'sync' = 'upload',
  namespace = 'default',
  extraMeta?: Record<string, any>,
): Promise<KnowledgeDocumentMeta> {
  const { vectorDb, embeddingProvider } = deps;
  if (!vectorDb) {
    throw new Error('No vector DB provider configured');
  }

  const nsCfg = deps.getNamespaceConfig(projectSlug, namespace);
  const storageDir = deps.resolveStorageDir(projectSlug, namespace);
  const shouldWriteFiles = nsCfg?.writeFiles !== false;
  const { metadata: fmMeta, body } = parseKnowledgeFrontmatter(content);
  const filePath = filename;

  const chunks = chunkKnowledgeText(body);
  const bodyHash = contentHash(body);
  const docId = crypto.randomUUID();
  const vectors =
    embeddingProvider && chunks.length > 0
      ? await embeddingProvider.embed(chunks)
      : chunks.map(() => []);

  const mergedMeta = { ...fmMeta, ...extraMeta };
  const meta: KnowledgeDocumentMeta = {
    id: docId,
    filename,
    namespace,
    path: filePath,
    source,
    chunkCount: chunks.length,
    contentHash: bodyHash,
    createdAt: new Date().toISOString(),
    ...(shouldWriteFiles && {
      storagePath: join(storageDir, 'files', filePath),
    }),
    ...(Object.keys(mergedMeta).length > 0 && { metadata: mergedMeta }),
  };
  const committed = await mutateKnowledgeDocuments(
    {
      storageDir,
      dataDir: deps.dataDir,
      projectSlug,
      namespace,
      operation: 'upload-document',
    },
    (transaction) => {
      const existing = transaction.metadata();
      if (shouldWriteFiles) transaction.writeDocument(filePath, content);
      transaction.replaceMetadata([...existing, meta]);
      return meta;
    },
  );
  await replaceDerivedVectors(vectorDb, {
    namespace: knowledgeVectorNamespace(projectSlug, namespace),
    docId,
    filename,
    contentHash: bodyHash,
    oldChunkCount: 0,
    chunks,
    vectors,
  });
  return committed;
}

export async function deleteKnowledgeDocument(
  deps: KnowledgeDocumentDeps,
  projectSlug: string,
  docId: string,
  namespace?: string,
): Promise<void> {
  const { vectorDb } = deps;
  if (!vectorDb) {
    throw new Error('No vector DB provider configured');
  }

  const targetNs =
    namespace ?? (await deps.findDocNamespace(projectSlug, docId));
  if (!targetNs) {
    throw new Error(`Document '${docId}' not found`);
  }

  const ns = knowledgeVectorNamespace(projectSlug, targetNs);
  const storageDir = deps.resolveStorageDir(projectSlug, targetNs);
  const deleted = await mutateKnowledgeDocuments(
    {
      storageDir,
      dataDir: deps.dataDir,
      projectSlug,
      namespace: targetNs,
      operation: 'delete-document',
    },
    (transaction) => {
      const meta = transaction.metadata();
      const doc = meta.find((candidate) => candidate.id === docId);
      if (!doc) {
        throw new Error(
          `Document '${docId}' not found in namespace '${targetNs}'`,
        );
      }
      transaction.removeDocument(doc.path || doc.filename);
      transaction.replaceMetadata(
        meta.filter((candidate) => candidate.id !== docId),
      );
      return doc;
    },
  );
  try {
    await vectorDb.deleteDocuments(
      ns,
      Array.from(
        { length: deleted.chunkCount },
        (_, index) => `${docId}:${index}`,
      ),
    );
  } catch (error) {
    observeKnowledgeDerivedFailure('delete-document-vectors', error);
  }
}

export async function getKnowledgeDocumentContent(
  deps: KnowledgeDocumentDeps,
  projectSlug: string,
  docId: string,
  namespace?: string,
): Promise<string> {
  const targetNs =
    namespace ?? (await deps.findDocNamespace(projectSlug, docId));
  if (!targetNs) {
    throw new Error(`Document '${docId}' not found`);
  }

  const storageDir = deps.resolveStorageDir(projectSlug, targetNs);
  const local = await readKnowledgeDocuments(
    {
      storageDir,
      dataDir: deps.dataDir,
      projectSlug,
      namespace: targetNs,
    },
    (transaction) => {
      const doc = transaction
        .metadata()
        .find((candidate) => candidate.id === docId);
      if (!doc) throw new Error(`Document '${docId}' not found`);
      return {
        doc,
        content: transaction.readDocument(doc.path || doc.filename),
      };
    },
  );
  const { doc, content: fileContent } = local;
  if (fileContent !== null) {
    return fileContent;
  }

  if (doc.contentHash === undefined) {
    throw new Error(
      'Authoritative document content is unavailable until its derived index is rebuilt',
    );
  }

  const { vectorDb } = deps;
  if (!vectorDb) {
    throw new Error('No vector DB provider configured');
  }

  const ns = knowledgeVectorNamespace(projectSlug, targetNs);
  if (!(await vectorDb.namespaceExists(ns))) {
    throw new Error('Vector namespace not found');
  }

  const results = await vectorDb.getByMetadata(ns, 'docId', docId);
  const chunks = new Map<number, string>();
  for (const result of results) {
    if (result.metadata.contentHash !== doc.contentHash) {
      continue;
    }
    chunks.set(result.metadata.chunkIndex as number, result.text);
  }
  return Array.from(chunks.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, text]) => text)
    .join('\n\n');
}

export async function updateKnowledgeDocument(
  deps: KnowledgeDocumentDeps,
  projectSlug: string,
  docId: string,
  updates: { content?: string; metadata?: Record<string, any> },
  namespace?: string,
): Promise<KnowledgeDocumentMeta> {
  const { vectorDb, embeddingProvider } = deps;
  if (!vectorDb) {
    throw new Error('No vector DB provider configured');
  }

  const targetNs =
    namespace ?? (await deps.findDocNamespace(projectSlug, docId));
  if (!targetNs) {
    throw new Error(`Document '${docId}' not found`);
  }

  const storageDir = deps.resolveStorageDir(projectSlug, targetNs);
  const updated = await mutateKnowledgeDocuments(
    {
      storageDir,
      dataDir: deps.dataDir,
      projectSlug,
      namespace: targetNs,
      operation: 'update-document',
    },
    async (transaction) => {
      const allMeta = transaction.metadata();
      const docIdx = allMeta.findIndex((candidate) => candidate.id === docId);
      if (docIdx < 0) throw new Error(`Document '${docId}' not found`);

      const doc = allMeta[docIdx];
      const filePath = doc.path || doc.filename;
      let content = updates.content;
      let newMetadata = { ...doc.metadata, ...updates.metadata };
      if (content === undefined) {
        const existing = transaction.readDocument(filePath);
        if (existing) {
          const { metadata: fmMeta, body } =
            parseKnowledgeFrontmatter(existing);
          newMetadata = { ...fmMeta, ...doc.metadata, ...updates.metadata };
          content = body;
        }
      } else {
        const { metadata: fmMeta, body } = parseKnowledgeFrontmatter(content);
        newMetadata = { ...fmMeta, ...updates.metadata };
        content = body;
      }

      const nsCfg = deps.getNamespaceConfig(projectSlug, targetNs);
      if (nsCfg?.writeFiles !== false) {
        transaction.writeDocument(
          filePath,
          serializeKnowledgeFrontmatter(newMetadata, content ?? ''),
        );
      }

      const chunks = chunkKnowledgeText(content ?? '');
      const bodyHash = contentHash(content ?? '');
      const vectors =
        embeddingProvider && chunks.length > 0
          ? await embeddingProvider.embed(chunks)
          : chunks.map(() => []);
      const updatedMeta: KnowledgeDocumentMeta = {
        ...doc,
        chunkCount: chunks.length,
        contentHash: bodyHash,
        updatedAt: new Date().toISOString(),
        ...(Object.keys(newMetadata).length > 0 && { metadata: newMetadata }),
      };
      allMeta[docIdx] = updatedMeta;
      transaction.replaceMetadata(allMeta);
      return { updatedMeta, oldChunkCount: doc.chunkCount, chunks, vectors };
    },
  );
  await replaceDerivedVectors(vectorDb, {
    namespace: knowledgeVectorNamespace(projectSlug, targetNs),
    docId,
    filename: updated.updatedMeta.filename,
    contentHash: updated.updatedMeta.contentHash!,
    oldChunkCount: updated.oldChunkCount,
    chunks: updated.chunks,
    vectors: updated.vectors,
  });
  return updated.updatedMeta;
}
