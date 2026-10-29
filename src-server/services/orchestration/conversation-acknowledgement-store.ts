import { join } from 'node:path';
import type { PairedDevice } from '@kontourai/station-contracts/environment-security';
import {
  isHostedSessionReadAuthority,
  type SessionReadAuthority,
} from '@kontourai/station-contracts/tenancy';
import { DEVICE_IDENTITY_PROVIDER } from '../identity/identity-source.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../identity/principal-resolver.js';
import { JsonFileStore } from '../infra/json-store.js';
import { isPersonalFamilyDevice } from '../notifications/delivery/audience-resolver.js';

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

/** A request carrying a paired device's own credential and no person's. */
const DEVICE_PRINCIPAL_PREFIX = `human:${DEVICE_IDENTITY_PROVIDER}:`;

/**
 * Whether the paired device `deviceId` is one of the owner's own, read from
 * its record (`ownerDevicePredicate`). Absent: no device is known to be the
 * owner's, so each keeps its own record.
 */
export type IsOwnerDevice = (deviceId: string) => boolean;

/**
 * The key a personal Station files `principalId`'s views under: the owner's
 * key for a principal that is the owner, the principal's own id for another
 * person, nothing for a principal that is not a person.
 *
 * The owner is who Station already treats as one person for notification
 * focus (`audience-resolver.ts` `ownerPrincipals`): the local operator, and
 * each family device whose record is tied to no person (`isOwnerDevice`).
 * The `human:device:<id>` id alone does not say so: a device bound to an
 * account whose session is not current reads as its device identity too
 * (`orchestration-request-principal.ts`), and is not the owner. A tailnet login
 * (`human:tailscale-serve:<login>`) or an account is its own person, even
 * the owner's own: nothing records that a tailnet identity is the operator,
 * so it keeps its own Just finished until accounts link identities. That
 * errs toward a thread staying unread, never toward another person's view
 * clearing the owner's. An id with no principal kind is the OS account name
 * an older composition passes, which is the owner.
 */
function personalAcknowledgementKey(
  principalId: string,
  isOwnerDevice: IsOwnerDevice | undefined,
): string | undefined {
  if (NON_PERSON_KEY_PREFIXES.some((prefix) => principalId.startsWith(prefix)))
    return undefined;
  if (
    principalId === LOCAL_OPERATOR_PRINCIPAL_ID ||
    (principalId.startsWith(DEVICE_PRINCIPAL_PREFIX) &&
      isOwnerDevice?.(principalId.slice(DEVICE_PRINCIPAL_PREFIX.length)) ===
        true) ||
    !principalId.includes(':')
  )
    return PERSONAL_OWNER_ACKNOWLEDGEMENT_KEY;
  return principalId.startsWith('human:') ? principalId : undefined;
}

/**
 * Whose "last viewed" a request reads and writes, or `undefined` when the
 * caller has none.
 *
 * Last-viewed is the person's, not the device's: opening a thread on the
 * desktop clears it on the phone. The owner reaches a personal Station as
 * several principals (the local operator and each of their unbound paired
 * devices), which share one key; anyone else with access (People, personal
 * tokens, another tailnet login) keeps their own. See
 * `personalAcknowledgementKey`.
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
  isOwnerDevice?: IsOwnerDevice,
): string | undefined {
  if (isHostedSessionReadAuthority(authority)) {
    const tenantId = authority.tenantExecutionContext?.tenantId;
    return tenantId ? `tenant:${tenantId}` : undefined;
  }
  return personalAcknowledgementKey(authority.userId, isOwnerDevice);
}

/**
 * The owner-device rule `audience-resolver.ts` applies, over the current
 * device records: a live family device (`isPersonalFamilyDevice`) with no
 * person binding.
 */
export function ownerDevicePredicate(
  listDevices: () => readonly PairedDevice[],
): IsOwnerDevice {
  return (deviceId) => {
    const device = listDevices().find((candidate) => candidate.id === deviceId);
    return (
      device !== undefined &&
      device.principalBinding === undefined &&
      isPersonalFamilyDevice(device)
    );
  };
}

interface AcknowledgementStoreData {
  version: typeof STORE_VERSION | typeof LEGACY_STORE_VERSION;
  /** key -> conversation id -> the conversation version last viewed. */
  acknowledgements: Record<string, Record<string, string>>;
}

export interface ConversationAcknowledgementStore {
  /** Which paired devices are the owner's, for `conversationAcknowledgementKey`. */
  readonly isOwnerDevice?: IsOwnerDevice;
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

/** A version's time, or the earliest time when it does not parse. */
function versionTime(version: string): number {
  const time = Date.parse(version);
  return Number.isFinite(time) ? time : Number.MIN_SAFE_INTEGER;
}

/**
 * The later of two rendered versions, compared as times. An unparseable
 * stored version loses to a parseable one.
 */
function laterVersion(left: string | undefined, right: string): string {
  if (left === undefined) return right;
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (!Number.isFinite(leftTime)) return right;
  if (!Number.isFinite(rightTime)) return left;
  return leftTime > rightTime ? left : right;
}

/**
 * Version 1 filed acknowledgements under whatever id each writer had: the OS
 * account name (the inventory POST), a request principal (the attention
 * projection), or `default`. Each folds under today's key for it
 * (`personalAcknowledgementKey`), keeping the newest version per
 * conversation: the owner's ids into the owner key, another person's
 * principal under itself. `tenant:` keys were already the hosted key and
 * stay as they are; `service:`/`agent:` keys were never a person's view and
 * are dropped.
 */
function migrateLegacyAcknowledgements(
  acknowledgements: Record<string, Record<string, string>>,
  isOwnerDevice: IsOwnerDevice | undefined,
): Record<string, Record<string, string>> {
  const migrated: Record<string, Record<string, string>> = {};
  for (const [key, versions] of Object.entries(acknowledgements)) {
    if (key.startsWith('tenant:')) {
      migrated[key] = { ...versions };
      continue;
    }
    const target = personalAcknowledgementKey(key, isOwnerDevice);
    if (!target) continue;
    const merged = migrated[target] ?? {};
    for (const [conversationId, version] of Object.entries(versions)) {
      if (typeof version !== 'string') continue;
      merged[conversationId] = laterVersion(merged[conversationId], version);
    }
    if (Object.keys(merged).length > 0) migrated[target] = merged;
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

  constructor(
    dataDir: string,
    readonly isOwnerDevice?: IsOwnerDevice,
  ) {
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
      return migrateLegacyAcknowledgements(
        data.acknowledgements,
        this.isOwnerDevice,
      );
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
        // Oldest first; a version that does not parse goes first of all.
        .sort(([, left], [, right]) => versionTime(left) - versionTime(right))
        .slice(0, entries.length - MAX_ACKNOWLEDGEMENTS_PER_USER)
        .forEach(([id]) => delete forUser[id]);
    }

    this.store.write({
      version: STORE_VERSION,
      acknowledgements: { ...acknowledgements, [userId]: forUser },
    });
  }
}
