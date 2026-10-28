import { join } from 'node:path';
import {
  isHostedSessionReadAuthority,
  type SessionReadAuthority,
} from '@kontourai/station-contracts/tenancy';
import { JsonFileStore } from '../infra/json-store.js';

const STORE_VERSION = 2 as const;
const LEGACY_STORE_VERSION = 1 as const;
const MAX_ACKNOWLEDGEMENTS_PER_USER = 2_000;

/**
 * The key every acknowledgement on a personal Station is filed under.
 *
 * Not a principal id: `personal` is no `PrincipalRef` kind, so it can never
 * collide with one (`human:`, `service:`, `agent:`, `tenant:`).
 */
export const PERSONAL_OWNER_ACKNOWLEDGEMENT_KEY = 'personal:owner';

/** Principal kinds that are never a person viewing a conversation. */
const NON_PERSON_KEY_PREFIXES = ['service:', 'agent:', 'tenant:'] as const;

/**
 * Whose "last viewed" a request reads and writes, or `undefined` when the
 * caller has none.
 *
 * Last-viewed is the person's, not the device's: opening a thread on the
 * desktop clears it on the phone. A personal Station has one owner, but the
 * same owner reaches it as several principals — the local operator, a paired
 * device (`human:device:<id>`) and a Tailscale Serve login
 * (`human:tailscale-serve:<login>`) for the same phone, depending on the
 * topology (see the station#4518 note in `runtime-routes.ts`). Unifying those
 * into one identity is still an open question for attribution; for read state
 * the answer is simply the owner, so every human principal maps to one key.
 *
 * A hosted Station has no single owner. Its requests read under the tenant
 * principal (`tenant:<id>`), the identity hosted reads are already scoped by;
 * a hosted request with no bound tenant has no key and reads nothing.
 *
 * The ONE derivation for the inventory GET, the acknowledgement POST and the
 * attention projection. Before it, the GET read under the request principal
 * while the POST wrote under the OS account name, so no acknowledgement was
 * ever read back and every finished thread stayed in "Just finished".
 */
export function conversationAcknowledgementKey(
  authority: SessionReadAuthority,
): string | undefined {
  if (isHostedSessionReadAuthority(authority)) {
    const tenantId = authority.tenantExecutionContext?.tenantId;
    return tenantId ? `tenant:${tenantId}` : undefined;
  }
  return NON_PERSON_KEY_PREFIXES.some((prefix) =>
    authority.userId.startsWith(prefix),
  )
    ? undefined
    : PERSONAL_OWNER_ACKNOWLEDGEMENT_KEY;
}

interface AcknowledgementStoreData {
  version: typeof STORE_VERSION | typeof LEGACY_STORE_VERSION;
  /** key -> conversation id -> the conversation version last viewed. */
  acknowledgements: Record<string, Record<string, string>>;
}

export interface ConversationAcknowledgementStore {
  getMany(
    userId: string,
    conversationIds: readonly string[],
  ): ReadonlyMap<string, string>;
  acknowledge(input: {
    userId: string;
    conversationId: string;
    updatedAt: string;
  }): void;
}

function laterVersion(left: string | undefined, right: string): string {
  return left !== undefined && left.localeCompare(right) > 0 ? left : right;
}

/**
 * Version 1 filed acknowledgements under whatever id each writer had: the OS
 * account name (the inventory POST), a request principal (the attention
 * projection), or `default`. Every one of those on a personal Station was the
 * owner, so they fold into the owner key, keeping the newest version per
 * conversation. `tenant:` keys were already the hosted key and stay as they
 * are; `service:`/`agent:` keys were never a person's view and are dropped.
 */
function migrateLegacyAcknowledgements(
  acknowledgements: Record<string, Record<string, string>>,
): Record<string, Record<string, string>> {
  const migrated: Record<string, Record<string, string>> = {};
  const owner: Record<string, string> = {};
  for (const [key, versions] of Object.entries(acknowledgements)) {
    if (key.startsWith('tenant:')) {
      migrated[key] = { ...versions };
      continue;
    }
    if (NON_PERSON_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      continue;
    }
    for (const [conversationId, version] of Object.entries(versions)) {
      if (typeof version !== 'string') continue;
      owner[conversationId] = laterVersion(owner[conversationId], version);
    }
  }
  if (Object.keys(owner).length > 0) {
    migrated[PERSONAL_OWNER_ACKNOWLEDGEMENT_KEY] = owner;
  }
  return migrated;
}

/**
 * Durable, per-person read state for the unified conversation inventory.
 *
 * The stored value is the `updatedAt` version that was actually rendered,
 * rather than the acknowledgement request's wall-clock time. A later turn
 * therefore becomes unseen again naturally, even if the acknowledgement and
 * a provider event race. This stays independent of the conversation owner so
 * it works equally for runtime transcripts and file-store conversations.
 *
 * Keys come from `conversationAcknowledgementKey`; this class does not
 * interpret them beyond migrating version 1.
 */
export class FileConversationAcknowledgementStore
  implements ConversationAcknowledgementStore
{
  private readonly store: JsonFileStore<AcknowledgementStoreData>;

  constructor(dataDir: string) {
    this.store = new JsonFileStore(
      join(dataDir, 'conversation-acknowledgements.json'),
      { version: STORE_VERSION, acknowledgements: {} },
      { durableAtomicWrite: true, onCorruption: 'throw' },
    );
  }

  /** The current-version view; a version 1 file is migrated in memory. */
  private readAcknowledgements(): Record<string, Record<string, string>> {
    const data = this.store.read();
    if (data.version === STORE_VERSION) return data.acknowledgements;
    if (data.version === LEGACY_STORE_VERSION) {
      return migrateLegacyAcknowledgements(data.acknowledgements);
    }
    return {};
  }

  /** One fresh snapshot per inventory read; never cache across requests. */
  getMany(
    userId: string,
    conversationIds: readonly string[],
  ): ReadonlyMap<string, string> {
    const result = new Map<string, string>();
    if (conversationIds.length === 0) return result;
    const forUser = this.readAcknowledgements()[userId];
    for (const id of conversationIds) {
      const version = forUser?.[id];
      if (version !== undefined) result.set(id, version);
    }
    return result;
  }

  /**
   * Never moves a conversation's version backwards: two devices now share
   * one key, and a phone acknowledging the version it rendered a minute ago
   * must not undo the desktop having seen a newer one.
   */
  acknowledge({
    userId,
    conversationId,
    updatedAt,
  }: {
    userId: string;
    conversationId: string;
    updatedAt: string;
  }): void {
    const acknowledgements = this.readAcknowledgements();
    const forUser = {
      ...(acknowledgements[userId] ?? {}),
      [conversationId]: laterVersion(
        acknowledgements[userId]?.[conversationId],
        updatedAt,
      ),
    };

    const entries = Object.entries(forUser);
    if (entries.length > MAX_ACKNOWLEDGEMENTS_PER_USER) {
      entries
        .sort(([, left], [, right]) => left.localeCompare(right))
        .slice(0, entries.length - MAX_ACKNOWLEDGEMENTS_PER_USER)
        .forEach(([id]) => delete forUser[id]);
    }

    this.store.write({
      version: STORE_VERSION,
      acknowledgements: { ...acknowledgements, [userId]: forUser },
    });
  }
}
