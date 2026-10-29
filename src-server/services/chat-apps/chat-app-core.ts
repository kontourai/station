import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  type ChatAppId,
  type ChatAppKillSwitch,
  type ChatChannelBinding,
  type ChatDeliveryLogEntry,
  type ChatDeliveryOutcome,
  type ChatDiscordImport,
  importLegacyDiscordConfiguration,
  parseChatAppKillSwitch,
  parseChatChannelBinding,
} from '@kontourai/station-contracts/chat-app';
import type {
  DiscordCapability,
  DiscordGatewayConfiguration,
} from '@kontourai/station-contracts/discord';
import { createLogger } from '../../utils/logger.js';
import { isDiscordGatewayConfiguration } from '../discord/discord-gateway-config-store.js';
import { ChatAppStore, readChatRecord } from './chat-app-store.js';
import { ChatIdentityLinks } from './chat-identity-links.js';

export interface LegacyDiscordRequest {
  discordUserId: string;
  guildId: string;
  channelId: string;
  capability: DiscordCapability;
  projectSlug?: string;
}

export type LegacyDiscordAuthorization =
  | { allowed: true; stationIdentity: string }
  | {
      allowed: false;
      reason:
        | 'outside_allowed_scope'
        | 'unmapped_identity'
        | 'not_permitted'
        | 'policy_unavailable'
        | 'app_disabled';
    };

type DeliveryContext = Omit<
  ChatDeliveryLogEntry,
  'id' | 'createdAt' | 'outcome'
>;
type DiscordImportPolicy = Pick<ChatDiscordImport, 'enabled' | 'guilds'>;

const logger = createLogger({ name: 'chat-app-core' });
const snowflake = (id: string) => /^[0-9]{17,20}$/.test(id);

export interface DiscordImportResult {
  imported: boolean;
  unreachable: {
    identities: number;
    guilds: number;
    channels: number;
    bindings: number;
  };
}

export class ChatAppCore {
  private readonly store: ChatAppStore;
  readonly links: ChatIdentityLinks;

  constructor(homeDir: string) {
    this.store = new ChatAppStore(homeDir);
    this.links = new ChatIdentityLinks(this.store);
  }

  importLegacyDiscord(
    configuration: DiscordGatewayConfiguration,
    beforeCommit: () => boolean,
  ): DiscordImportResult {
    if (!isDiscordGatewayConfiguration(configuration))
      throw new Error('Invalid legacy Discord policy');
    const result = this.store.transaction((db): DiscordImportResult => {
      const unreachable = {
        identities: 0,
        guilds: 0,
        channels: 0,
        bindings: 0,
      };
      if (this.discordImportIn(db)) return { imported: false, unreachable };
      const identities = (configuration.identities ?? []).filter((entry) => {
        if (snowflake(entry.discordUserId)) return true;
        unreachable.identities++;
        return false;
      });
      const guilds = (configuration.guilds ?? []).flatMap((entry) => {
        if (!snowflake(entry.guildId)) {
          unreachable.guilds++;
          return [];
        }
        const channelIds = (entry.channelIds ?? []).filter((id) => {
          if (snowflake(id)) return true;
          unreachable.channels++;
          return false;
        });
        return [{ ...entry, channelIds }];
      });
      const sessionBindings = (configuration.sessionBindings ?? []).filter(
        (entry) => {
          if (snowflake(entry.guildId) && snowflake(entry.channelId))
            return true;
          unreachable.bindings++;
          return false;
        },
      );
      const importedAt = new Date().toISOString();
      const imported = importLegacyDiscordConfiguration(
        { ...configuration, identities, guilds, sessionBindings },
        importedAt,
      );
      if (!imported)
        throw new Error(
          'Legacy Discord import contains unrepresentable configuration',
        );
      const seen = new Set<string>();
      for (const link of imported.links) {
        // V1 resolves the FIRST matching mapping, including a revoked first row.
        if (seen.has(link.externalUserId)) continue;
        seen.add(link.externalUserId);
        if (
          this.links.lookupIn(db, 'discord', link.externalUserId).state ===
          'unlinked'
        )
          this.links.appendIn(db, link);
      }
      for (const binding of imported.bindings) {
        if (!this.resolveBindingIn(db, binding))
          this.appendBindingIn(db, binding);
      }
      db.prepare(
        'INSERT INTO chat_app_imports(app, imported_at, record) VALUES (?,?,?)',
      ).run(
        'discord',
        importedAt,
        JSON.stringify({ enabled: imported.enabled, guilds: imported.guilds }),
      );
      return { imported: true, unreachable };
    }, beforeCommit);
    if (
      result.imported &&
      Object.values(result.unreachable).some((count) => count > 0)
    )
      logger.warn(
        'Legacy Discord import set aside unreachable identifiers',
        result.unreachable,
      );
    return result;
  }

  private discordImportIn(db: DatabaseSync): DiscordImportPolicy | undefined {
    return readChatRecord<DiscordImportPolicy>(
      db
        .prepare("SELECT record FROM chat_app_imports WHERE app='discord'")
        .get(),
    );
  }

  authorizeDiscord(
    configuration: DiscordGatewayConfiguration,
    request: LegacyDiscordRequest,
    beforeCommit: () => boolean,
  ): LegacyDiscordAuthorization {
    this.importLegacyDiscord(configuration, beforeCommit);
    return this.store.transaction((db) => {
      const refuse = (
        reason: Extract<
          LegacyDiscordAuthorization,
          { allowed: false }
        >['reason'],
        logReason: Extract<ChatDeliveryOutcome, { state: 'refused' }>['reason'],
      ): LegacyDiscordAuthorization => {
        this.appendDeliveryIn(db, {
          id: randomUUID(),
          app: 'discord',
          externalWorkspaceId: request.guildId,
          externalChannelId: request.channelId,
          externalUserId: request.discordUserId,
          direction:
            request.capability === 'transcript:read' ? 'outbound' : 'inbound',
          action:
            request.capability === 'transcript:read' ||
            request.capability === 'project-files:read'
              ? 'notify'
              : 'continue',
          outcome: { state: 'refused', reason: logReason },
          createdAt: new Date().toISOString(),
        });
        return { allowed: false, reason };
      };
      if (this.killSwitchIn(db, 'discord')?.disabled)
        return refuse('app_disabled', 'app-disabled');
      const imported = this.discordImportIn(db);
      const allowedIn = (guilds: DiscordImportPolicy['guilds']) =>
        guilds.some(
          (scope) =>
            scope.guildId === request.guildId &&
            scope.channelIds.includes(request.channelId),
        );
      const currentGuilds = (configuration.guilds ?? []).map((scope) => ({
        guildId: scope.guildId,
        channelIds: scope.channelIds ?? [],
      }));
      if (!imported || !allowedIn(imported.guilds) || !allowedIn(currentGuilds))
        return refuse('outside_allowed_scope', 'channel-unbound');
      const lookup = this.links.lookupIn(db, 'discord', request.discordUserId);
      if (lookup.state === 'unlinked')
        return refuse('unmapped_identity', 'unlinked-sender');
      if (lookup.state === 'revoked')
        return refuse('unmapped_identity', 'link-revoked');
      const legacy = lookup.link.provenance;
      const current = configuration.identities?.find(
        (mapping) => mapping.discordUserId === request.discordUserId,
      );
      if (!current) return refuse('unmapped_identity', 'unlinked-sender');
      if (current.revokedAt !== undefined)
        return refuse('unmapped_identity', 'link-revoked');
      // A newly linked principal needs current Project membership admission in
      // the later start/approve lanes; it cannot inherit a v1 user's grants.
      if (!legacy || current.stationIdentity !== legacy.stationIdentity)
        return refuse('not_permitted', 'capability-unavailable');
      if (
        !legacy.capabilities.includes(request.capability) ||
        !current.capabilities?.includes(request.capability)
      )
        return refuse('not_permitted', 'capability-unavailable');
      if (
        request.capability === 'project-files:read' &&
        (!request.projectSlug ||
          !legacy.projectFileProjects.includes(request.projectSlug) ||
          !current.projectFileProjects?.includes(request.projectSlug))
      )
        return refuse('not_permitted', 'capability-unavailable');
      return { allowed: true, stationIdentity: legacy.stationIdentity };
    }, beforeCommit);
  }

  resolveBinding(input: {
    app: ChatAppId;
    externalWorkspaceId: string;
    externalChannelId: string;
    externalThreadId?: string;
  }): ChatChannelBinding | undefined {
    return this.store.read((db) => this.resolveBindingIn(db, input));
  }

  private resolveBindingIn(
    db: DatabaseSync,
    input: {
      app: ChatAppId;
      externalWorkspaceId: string;
      externalChannelId: string;
      externalThreadId?: string;
    },
  ): ChatChannelBinding | undefined {
    const read = (threadId: string) =>
      readChatRecord<ChatChannelBinding>(
        db
          .prepare(
            'SELECT record FROM chat_channel_bindings WHERE app=? AND workspace_id=? AND channel_id=? AND thread_id=? ORDER BY sequence DESC LIMIT 1',
          )
          .get(
            input.app,
            input.externalWorkspaceId,
            input.externalChannelId,
            threadId,
          ),
      );
    return (
      (input.externalThreadId ? read(input.externalThreadId) : undefined) ??
      read('')
    );
  }

  private appendBindingIn(db: DatabaseSync, binding: ChatChannelBinding): void {
    db.prepare(
      'INSERT INTO chat_channel_bindings(app, workspace_id, channel_id, thread_id, record) VALUES (?,?,?,?,?)',
    ).run(
      binding.app,
      binding.externalWorkspaceId,
      binding.externalChannelId,
      binding.externalThreadId ?? '',
      JSON.stringify(binding),
    );
  }

  // UNWIRED(#4143): lane 3C supplies current operator authority for management writes.
  bind(binding: ChatChannelBinding, beforeCommit: () => boolean): void {
    const parsed = parseChatChannelBinding(binding);
    if (!parsed || parsed.provenance)
      throw new Error('Invalid channel binding');
    this.store.transaction(
      (db) => this.appendBindingIn(db, parsed),
      beforeCommit,
    );
  }

  private killSwitchIn(
    db: DatabaseSync,
    app: ChatAppId,
  ): ChatAppKillSwitch | undefined {
    const record = readChatRecord<unknown>(
      db
        .prepare(
          'SELECT record FROM chat_app_kill_switches WHERE app=? ORDER BY sequence DESC LIMIT 1',
        )
        .get(app),
    );
    if (record === undefined) return undefined;
    const parsed = parseChatAppKillSwitch(record);
    if (!parsed || parsed.app !== app)
      throw new Error('Chat app kill switch is unavailable');
    return parsed;
  }

  isDisabled(app: ChatAppId): boolean {
    return this.store.read(
      (db) => this.killSwitchIn(db, app)?.disabled === true,
    );
  }

  // UNWIRED(#4143): lane 3C supplies current operator authority for management writes.
  setKillSwitch(value: ChatAppKillSwitch, beforeCommit: () => boolean): void {
    const parsed = parseChatAppKillSwitch(value);
    if (!parsed) throw new Error('Invalid chat app kill switch');
    this.store.transaction((db) => {
      db.prepare(
        'INSERT INTO chat_app_kill_switches(app, record) VALUES (?,?)',
      ).run(parsed.app, JSON.stringify(parsed));
    }, beforeCommit);
  }

  private appendDeliveryIn(
    db: DatabaseSync,
    entry: ChatDeliveryLogEntry,
  ): void {
    db.prepare('INSERT INTO chat_delivery_log(id, record) VALUES (?,?)').run(
      entry.id,
      JSON.stringify(entry),
    );
  }

  recordDelivery(
    context: DeliveryContext,
    outcome: ChatDeliveryOutcome,
  ): string {
    const entry = {
      ...context,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      outcome,
    };
    this.store.transaction(
      (db) => this.appendDeliveryIn(db, entry),
      () => true,
    );
    return entry.id;
  }

  settleDelivery(
    id: string,
    outcome: Exclude<ChatDeliveryOutcome, { state: 'pending' }>,
  ): void {
    this.store.transaction(
      (db) => {
        const entry = readChatRecord<ChatDeliveryLogEntry>(
          db
            .prepare(
              'SELECT record FROM chat_delivery_log WHERE id=? ORDER BY sequence DESC LIMIT 1',
            )
            .get(id),
        );
        if (!entry || entry.outcome.state !== 'pending')
          throw new Error('Chat delivery is not pending');
        this.appendDeliveryIn(db, { ...entry, outcome });
      },
      () => true,
    );
  }

  // UNWIRED(#4146): retained receipts feed the later owner-authenticated log view.
  deliveryLog(limit = 100): ChatDeliveryLogEntry[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new Error('Invalid log limit');
    return this.store.read((db) =>
      db
        .prepare(
          'SELECT record FROM chat_delivery_log WHERE sequence IN (SELECT MAX(sequence) FROM chat_delivery_log GROUP BY id) ORDER BY sequence DESC LIMIT ?',
        )
        .all(limit)
        .map((row) => {
          const record = readChatRecord<ChatDeliveryLogEntry>(row);
          if (!record) throw new Error('Chat delivery is unavailable');
          return record;
        }),
    );
  }

  async deliver(
    context: DeliveryContext,
    send: () => Promise<void | { externalMessageId: string }>,
  ): Promise<void> {
    const id = this.recordDelivery(context, { state: 'pending' });
    if (this.isDisabled(context.app)) {
      this.settleDelivery(id, { state: 'refused', reason: 'app-disabled' });
      return;
    }
    let receipt: void | { externalMessageId: string };
    try {
      receipt = await send();
    } catch {
      this.settleDelivery(id, {
        state: 'failed',
        reason: 'transport-delivery-failed',
      });
      throw new Error('Chat message delivery failed');
    }
    // An injected/older transport may acknowledge without a provider message
    // id. Retain pending/unknown custody instead of inventing delivery proof.
    if (receipt)
      this.settleDelivery(id, {
        state: 'delivered',
        externalMessageId: receipt.externalMessageId,
      });
  }
}

function codePointBoundary(text: string, end: number): number {
  if (
    end > 0 &&
    end < text.length &&
    text.charCodeAt(end - 1) >= 0xd800 &&
    text.charCodeAt(end - 1) <= 0xdbff &&
    text.charCodeAt(end) >= 0xdc00 &&
    text.charCodeAt(end) <= 0xdfff
  )
    return end - 1;
  return end;
}

/** Limits are UTF-16 units, as on Discord; chunks join back to the exact input. */
export function* splitChatText(text: string, limit: number): Generator<string> {
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error('Invalid chat text limit');
  let offset = 0;
  while (offset < text.length) {
    const end = codePointBoundary(text, Math.min(offset + limit, text.length));
    if (end === offset)
      throw new Error('Chat text limit cannot contain a code point');
    yield text.slice(offset, end);
    offset = end;
  }
}

/** Discord retains its one-message truncation/disclosure policy on the shared renderer. */
export function renderChatTranscript(
  output: string,
  limit: number,
  pointer: string,
): string {
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error('Invalid chat text limit');
  const content = output || 'Station completed the turn.';
  if (content.length <= limit) return content;
  const disclosure = `\n\n[Truncated — view the full response in Station: ${pointer}]`;
  const room = limit - disclosure.length;
  if (room < 2)
    throw new Error('Chat text limit cannot contain the disclosure');
  const candidate = splitChatText(content, room - 1).next().value ?? '';
  const sentenceEnd = Math.max(
    candidate.lastIndexOf('. '),
    candidate.lastIndexOf('! '),
    candidate.lastIndexOf('? '),
    candidate.lastIndexOf('\n'),
  );
  const text =
    sentenceEnd >= Math.floor(room / 2)
      ? candidate.slice(0, sentenceEnd + 1)
      : `${candidate.trimEnd()}…`;
  return `${text}${disclosure}`;
}
