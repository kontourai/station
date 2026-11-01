interface PostToolInbox {
  owns(sessionId: string, turnId: string): boolean;
  deliver(
    sessionId: string,
    turnId: string,
    inject: (text: string) => void,
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
  inject: (text: string) => void,
): void {
  const owners = [...inboxes].filter((inbox) => inbox.owns(sessionId, turnId));
  if (owners.length > 1)
    throw new Error('Post-tool inbox ownership is ambiguous.');
  owners[0]?.deliver(sessionId, turnId, inject);
}
