/**
 * `station knowledge reindex`/`migrate` — K3 index-management CLI verbs
 * (`s201-knowledge-retrieval` Wave 4). Both actions call the DRY SDK client
 * fetchers (`@kontourai/station-sdk/client`'s `rebuildKnowledgeIndex`/
 * `migratePreIndexKnowledge`, Wave 4) — the HTTP call itself is never
 * re-implemented here, matching this file family's own
 * (`packages/sdk/src/client/index.ts`) anti-triplication contract.
 *
 * Idempotency is entirely server-side (`rebuildRoot` re-derives from the K2
 * store; `migratePreIndexKnowledge` skips namespaces already migrated) — these
 * handlers only report whatever counts the server returns, including zero
 * new work on a second run, which is expected output, not an error.
 */
import {
  migratePreIndexKnowledge,
  rebuildKnowledgeIndex,
  searchKnowledgeIndex,
} from '@kontourai/station-sdk/client';
import type { ParsedCoreArgs } from './core-api.js';

/**
 * Both verbs rebuild an entire corpus server-side; how long that takes is a
 * function of the user's data, not of Station's health. They are therefore
 * exempt from the CLI's default request deadline — the one thing a timeout
 * here would reliably do is abandon a rebuild that was working.
 */
const NO_REQUEST_DEADLINE = { timeoutMs: null } as const;

function optionalStringFlag(
  parsed: ParsedCoreArgs,
  flag: string,
): string | undefined {
  const value = parsed.flags[flag];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** `station knowledge reindex [--root <id>]`. */
export async function runKnowledgeReindex(
  apiBase: string,
  parsed: ParsedCoreArgs,
): Promise<void> {
  const rootId = optionalStringFlag(parsed, 'root') ?? parsed.positionals[1];
  const result = await rebuildKnowledgeIndex(
    apiBase,
    rootId ? { rootId } : undefined,
    NO_REQUEST_DEADLINE,
  );

  const roots = Array.isArray(result?.roots) ? result.roots : [];
  if (roots.length === 0) {
    console.log('Knowledge reindex: no roots to rebuild.');
    return;
  }

  // Partial-failure honesty (code-review MED-3): a per-root failure is reported
  // inline alongside every root that DID succeed, rather than only ever printing
  // an all-or-nothing summary.
  for (const root of roots) {
    if (root.status === 'error') {
      console.log(`Failed to reindex root ${root.rootId}: ${root.error}`);
      continue;
    }
    console.log(
      `Reindexed root ${root.rootId}: ${root.records ?? 0} record(s), ${root.chunks ?? 0} chunk(s).`,
    );
  }

  const okRoots = roots.filter((root) => root.status !== 'error');
  const failedCount = roots.length - okRoots.length;
  const totalRecords = okRoots.reduce(
    (sum, root) => sum + (root.records ?? 0),
    0,
  );
  const totalChunks = okRoots.reduce(
    (sum, root) => sum + (root.chunks ?? 0),
    0,
  );
  console.log(
    `Knowledge reindex complete: ${okRoots.length} root(s), ${totalRecords} record(s), ${totalChunks} chunk(s)${
      failedCount > 0 ? `, ${failedCount} failed` : ''
    }.`,
  );
}

/**
 * `station knowledge search <query> [--root=<id> ...] [--top-k=<n>] [--json]`.
 *
 * Searches the K3 successor index (`POST /api/knowledge/index/search`), scoped
 * to the given roots when `--root` is supplied (repeatable) and all registered
 * roots otherwise. Results are the route's re-resolved records — title,
 * category, excerpt — never raw index hits (ADR-0009's "an index hit is not
 * the record" rule holds server-side; this verb only prints what the server
 * re-resolved). Unlike reindex/migrate this is an interactive query, so it
 * keeps the CLI's default request deadline.
 */
export async function runKnowledgeSearch(
  apiBase: string,
  parsed: ParsedCoreArgs,
): Promise<void> {
  const query = parsed.positionals[1];
  if (typeof query !== 'string' || query.length === 0) {
    throw new Error(
      'Missing required argument: search query. Usage: station knowledge search <query> [--root=<id> ...] [--top-k=<n>] [--json]',
    );
  }

  // parseCoreArgs only recognizes `--key=value`; a space-separated `--root x`
  // parses as boolean `--root` plus a stray positional. Left unchecked that
  // SILENTLY widens the search to all roots — and root scoping is documented
  // as an isolation boundary (docs/guides/knowledge.md), so the misuse must
  // fail loudly instead of unscoping the query.
  if (parsed.flags.root === true) {
    throw new Error(
      "--root requires '=<id>' (e.g. --root=root:personal); '--root <id>' is not supported.",
    );
  }
  if (parsed.flags['top-k'] === true) {
    throw new Error(
      "--top-k requires '=<n>' (e.g. --top-k=5); '--top-k <n>' is not supported.",
    );
  }

  const rootIds = parsed.repeatedFlags.root;
  const topKRaw = optionalStringFlag(parsed, 'top-k');
  let topK: number | undefined;
  if (topKRaw !== undefined) {
    topK = Number(topKRaw);
    if (!Number.isInteger(topK) || topK <= 0) {
      throw new Error(`--top-k must be a positive integer, got '${topKRaw}'.`);
    }
  }

  const results = await searchKnowledgeIndex(apiBase, {
    query,
    ...(rootIds && rootIds.length > 0 ? { rootIds } : {}),
    ...(topK !== undefined ? { topK } : {}),
  });

  if (parsed.flags.json === true) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  const scope =
    rootIds && rootIds.length > 0 ? rootIds.join(', ') : 'all roots';
  if (results.length === 0) {
    console.log(`Knowledge search: no results for '${query}' (${scope}).`);
    return;
  }

  for (const [index, result] of results.entries()) {
    console.log(
      `${index + 1}. [${result.score.toFixed(3)}] ${result.title} (${result.rootId} · ${result.category} · ${result.recordId})`,
    );
    if (result.excerpt) {
      console.log(`   ${result.excerpt}`);
    }
  }
  console.log(
    `Knowledge search: ${results.length} result(s) for '${query}' (${scope}).`,
  );
}

/** `station knowledge migrate [--project <slug>]`. */
export async function runKnowledgeMigrate(
  apiBase: string,
  parsed: ParsedCoreArgs,
): Promise<void> {
  const projectSlug =
    optionalStringFlag(parsed, 'project') ?? parsed.positionals[1];
  const result = await migratePreIndexKnowledge(
    apiBase,
    projectSlug ? { projectSlug } : undefined,
    NO_REQUEST_DEADLINE,
  );

  const documentsMigrated = result?.documentsMigrated ?? 0;
  const chunksIndexed = result?.chunksIndexed ?? 0;
  const namespacesProcessed = Array.isArray(result?.namespacesProcessed)
    ? result.namespacesProcessed
    : [];
  const namespaceResults = Array.isArray(result?.namespaceResults)
    ? result.namespaceResults
    : [];

  // Partial-failure honesty (code-review MED-3): report any per-namespace failure
  // inline, even when other namespaces in the same run succeeded.
  for (const ns of namespaceResults) {
    if (ns.status === 'error') {
      console.log(
        `Failed to migrate namespace ${ns.projectSlug}/${ns.namespace}: ${ns.error}`,
      );
    }
  }

  if (documentsMigrated === 0 && chunksIndexed === 0) {
    console.log(
      'Knowledge migrate: no pre-index documents or vectors found (no-op).',
    );
    return;
  }

  console.log(
    `Knowledge migrate complete: ${documentsMigrated} document(s), ${chunksIndexed} chunk(s) across ${namespacesProcessed.length} namespace(s)${
      namespacesProcessed.length > 0
        ? ` (${namespacesProcessed.join(', ')})`
        : ''
    }.`,
  );
}
