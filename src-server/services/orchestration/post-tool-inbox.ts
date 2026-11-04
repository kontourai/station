export interface PostToolSteerInput {
  readonly key: string;
  readonly text: string;
  readonly onUnconfirmed: () => void;
  readonly onDispatched: (persistMemory: () => Promise<void>) => Promise<void>;
}

interface PostToolInbox {
  owns(sessionId: string, turnId: string): boolean;
  deliver(
    sessionId: string,
    turnId: string,
    inject: (input: PostToolSteerInput) => void,
  ): void;
}

const inboxes = new Set<PostToolInbox>();

/** A running inbox registers until its runtime stops. Ambiguous ownership refuses delivery. */
export function registerPostToolInbox(inbox: PostToolInbox): () => void {
  inboxes.add(inbox);
  return () => {
    inboxes.delete(inbox);
  };
}

export function deliverPostToolInbox(
  sessionId: string,
  turnId: string,
  inject: (input: PostToolSteerInput) => void,
): void {
  const owners = [...inboxes].filter((inbox) => inbox.owns(sessionId, turnId));
  if (owners.length !== 1) return;
  owners[0]?.deliver(sessionId, turnId, inject);
}
