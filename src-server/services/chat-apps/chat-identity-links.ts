import type { DatabaseSync } from 'node:sqlite';
import {
  type ChatAppId,
  type ChatIdentityLink,
  parseChatIdentityLink,
} from '@kontourai/station-contracts/chat-app';
import { ChatAppStore, readChatRecord } from './chat-app-store.js';

type LinkLookup =
  | { state: 'unlinked' }
  | { state: 'revoked'; link: ChatIdentityLink }
  | { state: 'linked'; link: ChatIdentityLink };

function parseStoredLink(value: ChatIdentityLink): ChatIdentityLink {
  const parsed = parseChatIdentityLink(value);
  if (!parsed) throw new Error('Chat identity link is unavailable');
  return parsed;
}

export class ChatIdentityLinks {
  constructor(private readonly store: ChatAppStore) {}

  // UNWIRED(#4143): lane 3C exposes the operator's link projection.
  lookup(app: ChatAppId, externalUserId: string): LinkLookup {
    return this.store.read((db) => this.lookupIn(db, app, externalUserId));
  }

  lookupIn(
    db: DatabaseSync,
    app: ChatAppId,
    externalUserId: string,
  ): LinkLookup {
    const record = readChatRecord<ChatIdentityLink>(
      db
        .prepare(
          'SELECT record FROM chat_identity_links WHERE app=? AND external_user_id=? ORDER BY sequence DESC LIMIT 1',
        )
        .get(app, externalUserId),
    );
    if (!record) return { state: 'unlinked' };
    const link = parseStoredLink(record);
    if (link.app !== app || link.externalUserId !== externalUserId)
      throw new Error('Chat identity link key mismatch');
    // Presence is revocation, including future timestamps inherited from v1.
    if (link.revokedAt !== undefined) return { state: 'revoked', link };
    return { state: 'linked', link };
  }

  appendIn(db: DatabaseSync, link: ChatIdentityLink): void {
    parseStoredLink(link);
    db.prepare(
      'INSERT INTO chat_identity_links(app, external_user_id, record) VALUES (?,?,?)',
    ).run(link.app, link.externalUserId, JSON.stringify(link));
  }

  // UNWIRED(#4143): lane 3C supplies the authenticated operator management seam.
  revoke(
    app: ChatAppId,
    externalUserId: string,
    revokedAt: string,
    beforeCommit: () => boolean,
  ): boolean {
    if (!Number.isFinite(Date.parse(revokedAt)))
      throw new Error('Invalid revocation time');
    return this.store.transaction((db) => {
      const current = this.lookupIn(db, app, externalUserId);
      if (current.state === 'unlinked') return false;
      if (current.state === 'revoked') return true;
      this.appendIn(db, { ...current.link, revokedAt });
      return true;
    }, beforeCommit);
  }
}
