import type {
  KnowledgeDocumentMeta,
  KnowledgeNamespaceConfig,
} from '@kontourai/station-contracts/knowledge';
import {
  knowledgeVectorNamespace,
  readKnowledgeDocuments,
} from './knowledge-storage.js';

export interface KnowledgeRagContextResult {
  /** The exact string composed into the model input. */
  context: string;
  /**
   * Chunks/sources of THAT string, derived from the same `relevant` array
   * that built it (station#2649) — record and injection share one
   * derivation, so the per-turn context receipt cannot name a chunk the
   * model never saw.
   */
  chunkCount: number;
  /** Distinct source doc filenames, in first-appearance order. */
  sources: string[];
}

export function buildKnowledgeRagContextDetailed(
  results: Array<{
    score: number;
    text: string;
    metadata: { filename?: string };
  }>,
  threshold: number,
): KnowledgeRagContextResult | null {
  const relevant = results.filter((result) => result.score >= threshold);
  if (relevant.length === 0) return null;

  const contextBlocks = relevant.map(
    (result, index) =>
      `[${index + 1}] (score: ${result.score.toFixed(2)}, source: ${result.metadata.filename ?? 'unknown'})\n${result.text}`,
  );

  const sources: string[] = [];
  for (const result of relevant) {
    const filename = result.metadata.filename ?? 'unknown';
    if (!sources.includes(filename)) sources.push(filename);
  }

  return {
    context: `<project_knowledge>\nThe following context was retrieved from the project's knowledge base. Use it to inform your response when relevant.\n\n${contextBlocks.join('\n\n')}\n</project_knowledge>`,
    chunkCount: relevant.length,
    sources,
  };
}

export async function buildKnowledgeInjectContext({
  projectSlug,
  namespaces,
  dataDir,
  resolveStorageDir,
  vectorDb,
  embeddingProvider,
}: {
  projectSlug: string;
  namespaces: KnowledgeNamespaceConfig[];
  dataDir: string;
  resolveStorageDir: (projectSlug: string, namespace: string) => string;
  vectorDb: {
    namespaceExists(namespace: string): Promise<boolean>;
    search(
      namespace: string,
      queryVector: number[],
      topK: number,
    ): Promise<
      Array<{
        text: string;
        metadata: Record<string, unknown>;
      }>
    >;
  };
  embeddingProvider: {
    embed(texts: string[]): Promise<number[][]>;
  };
}): Promise<string | null> {
  const sections: string[] = [];

  for (const namespaceConfig of namespaces) {
    const storageDir = resolveStorageDir(projectSlug, namespaceConfig.id);
    const docs = await readKnowledgeDocuments(
      {
        storageDir,
        dataDir,
        projectSlug,
        namespace: namespaceConfig.id,
      },
      (transaction) => transaction.metadata(),
    );
    if (docs.length === 0) continue;

    const namespace = knowledgeVectorNamespace(projectSlug, namespaceConfig.id);
    if (!(await vectorDb.namespaceExists(namespace))) continue;

    const totalChunks = docs.reduce((sum, doc) => sum + doc.chunkCount, 0);
    if (totalChunks === 0) continue;

    const [queryVector] = await embeddingProvider.embed([
      namespaceConfig.label,
    ]);
    const results = await vectorDb.search(namespace, queryVector, totalChunks);
    if (results.length === 0) continue;

    const byDoc = new Map<
      string,
      { filename: string; chunks: Map<number, string> }
    >();
    const authoritativeHashes = new Map(
      docs.map((document) => [document.id, document.contentHash ?? null]),
    );
    for (const result of results) {
      const docId = String(result.metadata.docId);
      const authoritativeHash = authoritativeHashes.get(docId);
      if (
        typeof authoritativeHash !== 'string' ||
        result.metadata.contentHash !== authoritativeHash
      ) {
        continue;
      }
      const chunkIndex = Number(result.metadata.chunkIndex);
      const filename = String(result.metadata.filename);
      if (!byDoc.has(docId)) {
        byDoc.set(docId, { filename, chunks: new Map() });
      }
      byDoc.get(docId)!.chunks.set(chunkIndex, result.text);
    }

    const docTexts: string[] = [];
    for (const [, { chunks }] of byDoc) {
      const sorted = Array.from(chunks.entries()).sort((a, b) => a[0] - b[0]);
      docTexts.push(sorted.map(([, text]) => text).join('\n\n'));
    }

    if (docTexts.length === 0) continue;

    sections.push(
      `<${namespaceConfig.id}_rules>\n${docTexts.join('\n\n')}\n</${namespaceConfig.id}_rules>`,
    );
  }

  if (sections.length === 0) return null;
  return `<project_rules>\n${sections.join('\n\n')}\n</project_rules>`;
}

export async function findKnowledgeDocumentNamespace({
  projectSlug,
  docId,
  namespaces,
  dataDir,
  resolveStorageDir,
}: {
  projectSlug: string;
  docId: string;
  namespaces: KnowledgeNamespaceConfig[];
  dataDir: string;
  resolveStorageDir: (projectSlug: string, namespace: string) => string;
}): Promise<string | null> {
  for (const namespace of namespaces) {
    const storageDir = resolveStorageDir(projectSlug, namespace.id);
    const metadata = await readKnowledgeDocuments(
      { storageDir, dataDir, projectSlug, namespace: namespace.id },
      (transaction) => transaction.metadata(),
    );
    if (
      metadata.some((document: KnowledgeDocumentMeta) => document.id === docId)
    ) {
      return namespace.id;
    }
  }

  return null;
}
