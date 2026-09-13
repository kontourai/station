import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  ConversationPullRequestLink,
  PullRequestLinkIdentity,
} from '@kontourai/station-contracts/conversation-pull-request-links';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { JsonFileStore } from '../infra/json-store.js';

const VERSION = 1;
const MAX_CONVERSATIONS = 500;
const MAX_LINKS = 20;
const TEXT = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,254}$/;
const validActor = (value: string) =>
  value.trim().length > 0 &&
  value.length <= 255 &&
  ![...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
type Document = {
  version: typeof VERSION;
  conversations: Record<string, ConversationPullRequestLink[]>;
};

export class ConversationPullRequestLinkStoreError extends Error {}

const identityKey = (value: PullRequestLinkIdentity) =>
  JSON.stringify([
    value.provider,
    value.host.toLowerCase(),
    value.repository.owner,
    value.repository.name,
    value.ref,
  ]);

function validateIdentity(value: PullRequestLinkIdentity) {
  const values = [
    value.provider,
    value.host,
    value.repository?.owner,
    value.repository?.name,
    value.ref,
  ];
  if (values.some((item) => typeof item !== 'string' || !TEXT.test(item)))
    throw new ConversationPullRequestLinkStoreError(
      'Pull request link identity is invalid.',
    );
}

function validateDocument(value: Document): Document {
  if (
    !value ||
    value.version !== VERSION ||
    !value.conversations ||
    typeof value.conversations !== 'object' ||
    Array.isArray(value.conversations) ||
    Object.keys(value.conversations).length > MAX_CONVERSATIONS
  )
    throw new ConversationPullRequestLinkStoreError(
      'Conversation pull request links are unavailable.',
    );
  for (const [conversationId, links] of Object.entries(value.conversations)) {
    if (
      !TEXT.test(conversationId) ||
      !Array.isArray(links) ||
      links.length > MAX_LINKS
    )
      throw new ConversationPullRequestLinkStoreError(
        'Conversation pull request links are unavailable.',
      );
    const keys = new Set<string>();
    for (const link of links) {
      validateIdentity(link);
      if (
        link.source !== 'explicit' ||
        typeof link.linkedAt !== 'string' ||
        !Number.isFinite(Date.parse(link.linkedAt)) ||
        typeof link.linkedBy !== 'string' ||
        !validActor(link.linkedBy) ||
        keys.has(identityKey(link))
      )
        throw new ConversationPullRequestLinkStoreError(
          'Conversation pull request links are unavailable.',
        );
      keys.add(identityKey(link));
    }
  }
  return value;
}

export class ConversationPullRequestLinkStore {
  private readonly filePath: string;
  private readonly store: JsonFileStore<Document>;
  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'conversation-pull-request-links.json');
    this.store = new JsonFileStore(
      this.filePath,
      { version: VERSION, conversations: {} },
      {
        durableAtomicWrite: true,
        onCorruption: 'throw',
        maxReadBytes: 512 * 1024,
      },
    );
  }

  list(conversationId: string): ConversationPullRequestLink[] {
    if (!TEXT.test(conversationId))
      throw new ConversationPullRequestLinkStoreError(
        'Conversation identity is invalid.',
      );
    const document = validateDocument(this.store.read());
    return structuredClone(document.conversations[conversationId] ?? []);
  }

  async link(
    conversationId: string,
    identity: PullRequestLinkIdentity,
    actor: string,
    isCurrent: () => boolean,
  ): Promise<ConversationPullRequestLink[]> {
    validateIdentity(identity);
    if (!TEXT.test(conversationId) || !validActor(actor) || !isCurrent())
      throw new ConversationPullRequestLinkStoreError(
        'Conversation link authorization changed.',
      );
    return this.mutate(conversationId, isCurrent, (links) => {
      if (links.some((link) => identityKey(link) === identityKey(identity)))
        return links;
      if (links.length >= MAX_LINKS)
        throw new ConversationPullRequestLinkStoreError(
          `A Conversation may link at most ${MAX_LINKS} pull requests.`,
        );
      return [
        ...links,
        {
          ...structuredClone(identity),
          host: identity.host.toLowerCase(),
          source: 'explicit',
          linkedAt: new Date().toISOString(),
          linkedBy: actor,
        },
      ];
    });
  }

  async unlink(
    conversationId: string,
    identity: PullRequestLinkIdentity,
    isCurrent: () => boolean,
  ): Promise<ConversationPullRequestLink[]> {
    validateIdentity(identity);
    return this.mutate(conversationId, isCurrent, (links) =>
      links.filter((link) => identityKey(link) !== identityKey(identity)),
    );
  }

  private async mutate(
    conversationId: string,
    isCurrent: () => boolean,
    update: (
      current: ConversationPullRequestLink[],
    ) => ConversationPullRequestLink[],
  ) {
    if (!TEXT.test(conversationId) || !isCurrent())
      throw new ConversationPullRequestLinkStoreError(
        'Conversation link authorization changed.',
      );
    mkdirSync(dirname(this.filePath), { recursive: true });
    const release = await acquireFileMutationLockAsync(
      `${this.filePath}.mutation`,
    );
    try {
      const document = validateDocument(this.store.read());
      const current = structuredClone(
        document.conversations[conversationId] ?? [],
      );
      const next = update(current);
      if (!isCurrent())
        throw new ConversationPullRequestLinkStoreError(
          'Conversation link authorization changed.',
        );
      document.conversations[conversationId] = next;
      if (next.length === 0) delete document.conversations[conversationId];
      validateDocument(document);
      this.store.write(document);
      return structuredClone(next);
    } finally {
      await release();
    }
  }
}
