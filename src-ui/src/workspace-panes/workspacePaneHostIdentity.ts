/** Collision-safe structural identities for DOM and ref maps. */
export function workspacePaneHostTupleId(
  prefix: string,
  ...parts: readonly string[]
): string {
  // Hex encodes UTF-8 bytes, so untrusted catalog identities cannot inject
  // whitespace, selectors, or delimiter ambiguity into DOM id tokens.
  const encode = (part: string) =>
    Array.from(new TextEncoder().encode(part), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
  return `${prefix}-${parts.map(encode).join('-')}`;
}

export function workspacePaneHostTabIdentity(
  groupId: string,
  instanceId: string,
): string {
  return workspacePaneHostTupleId('workspace-pane-tab', groupId, instanceId);
}

export function workspacePaneHostPanelIdentity(
  groupId: string,
  instanceId: string,
): string {
  return workspacePaneHostTupleId('workspace-pane-panel', groupId, instanceId);
}
