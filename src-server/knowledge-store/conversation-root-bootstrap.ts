/**
 * Boot-time wiring for the `root:conversations` K2 root (station#1879). Two
 * distinct actions, deliberately gated differently:
 *
 *   1. `provider.registerAdapter(...)` — ALWAYS runs, unconditionally. This is
 *      an in-memory `Map.set` (`KnowledgeAdapterRegistry.register`), zero I/O,
 *      so it costs nothing to register even when the root itself never gets
 *      created — mirrors `runtime-service-bootstrap.ts`'s own precedent for
 *      constructing `KnowledgeStoreProvider` unconditionally while its FLAG-
 *      gated behavior lives downstream.
 *   2. The root itself — gated on `AppConfig.knowledgeStores === true`, this
 *      flag's first real enforcement point (`runtime-service-bootstrap.ts`'s
 *      doc comment names exactly this: "whichever K3+ work adds a route/
 *      service that both checks the flag... and calls this provider"). This
 *      is also the ONLY durable write this module ever performs.
 *
 * The root is created via a DIRECT `persistence.saveKnowledgeStoreRoot`
 * upsert, never `KnowledgeStoreProvider.createRoot` — `createRoot`'s
 * `generateRootId` mints `root:personal`/`root:personal:2`/... for the
 * `{ kind: 'personal' }` scope this root uses, which would either poach the
 * real `root:personal` id (if no personal store exists yet) or mint an
 * incrementing suffix (if one does) — neither is `root:conversations`, the
 * stable id every other part of this feature (the adapter, the CLI, the
 * index) is written against. `getRoot`, a plain read, is still used to check
 * for an existing root first, so re-running this at every boot is a true
 * no-op once the root exists (idempotent, and never rewrites `createdAt`).
 */
import type { AppConfig } from '@kontourai/station-contracts/config';
import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';
import { getOrchestrationDatabasePath } from '../domain/migrations/003-orchestration-events.js';
import { isHostedTenantExecutionRequired } from '../runtime/bootstrap/runtime-tenant-context.js';
import {
  CONVERSATION_ROOT_ID,
  CONVERSATION_STORE_ADAPTER_ID,
  type ConversationFileStoreReader,
  type ConversationSessionReader,
  createConversationStoreAdapterDescriptor,
} from './adapters/conversation-store.js';
import type {
  KnowledgeStoreProvider,
  KnowledgeStoreRootPersistence,
} from './knowledge-store-provider.js';

export interface EnsureConversationKnowledgeRootDeps {
  provider: KnowledgeStoreProvider;
  /** The same `KnowledgeStoreRootPersistence` the provider itself was
   * constructed with (`FileStorageAdapter` in production) — a direct
   * dependency so this module can upsert the stable-id root without going
   * through `createRoot`'s id-generation (see module doc). */
  persistence: KnowledgeStoreRootPersistence;
  sessionReader: ConversationSessionReader;
  fileStores: Map<string, ConversationFileStoreReader>;
  getUserId: () => string | undefined;
  /** `projectHomeDir` — used only to derive the documentary `storeRoot` path
   * (`{projectHomeDir}/data/orchestration.sqlite`) recorded on the root for
   * Settings/CLI listings; the adapter itself never reads this path (see
   * `conversation-store.ts`'s `createConversationStoreAdapterDescriptor` doc). */
  projectHomeDir: string;
  /** `AppConfig.knowledgeStores` — read by the caller (may be `undefined`
   * pre-boot), compared with `=== true` here so an absent/off flag behaves
   * identically (byte-identical to today, per `AppConfig.knowledgeStores`'s
   * own doc comment). */
  knowledgeStoresEnabled: AppConfig['knowledgeStores'];
}

export async function ensureConversationKnowledgeRoot(
  deps: EnsureConversationKnowledgeRootDeps,
): Promise<void> {
  // The conversation adapter has one process-global file-store leg and its
  // root has a personal scope.  Hosted tenants cannot soundly bind either to
  // the request that later asks to index/search, so suppress the entire
  // projection (including a pre-existing root) rather than registering an
  // adapter whose fallback authority could read shared history.
  if (isHostedTenantExecutionRequired()) return;

  // Action 1 — always, unconditionally, zero I/O.
  deps.provider.registerAdapter(
    createConversationStoreAdapterDescriptor({
      sessionReader: deps.sessionReader,
      fileStores: deps.fileStores,
      getUserId: deps.getUserId,
    }),
  );

  // Action 2 — the flag's first real enforcement point.
  if (deps.knowledgeStoresEnabled !== true) return;

  const existing = await deps.provider.getRoot(CONVERSATION_ROOT_ID);
  if (existing) return;

  const root: KnowledgeStoreRoot = {
    id: CONVERSATION_ROOT_ID,
    scope: { kind: 'personal' },
    adapterId: CONVERSATION_STORE_ADAPTER_ID,
    storeRoot: getOrchestrationDatabasePath(deps.projectHomeDir),
    displayName: 'Conversation history',
    createdAt: new Date().toISOString(),
  };
  await deps.persistence.saveKnowledgeStoreRoot(root);
}
