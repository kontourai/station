/**
 * #3483: tool-server sign-in abilities a catalog listing depends on.
 *
 * The owner that delivers an ability registers it once when it loads. Until
 * then, a catalog entry that needs it is listed with the reason it cannot be
 * added; registering the ability makes the same entry addable without any
 * change to catalog data.
 *
 * `pre-registered-clients`: a remote tool server can sign in with an OAuth
 * client the person registered with the provider (`clientId` or a Client ID
 * Metadata Document) when its authorization server has no dynamic client
 * registration. Nothing in this module delivers it; the tool-server OAuth
 * owner registers it in the change that adds that support.
 */
export type ToolServerOAuthCapability = 'pre-registered-clients';

const delivered = new Set<ToolServerOAuthCapability>();

export function registerToolServerOAuthCapability(
  capability: ToolServerOAuthCapability,
): void {
  delivered.add(capability);
}

export function hasToolServerOAuthCapability(
  capability: ToolServerOAuthCapability,
): boolean {
  return delivered.has(capability);
}
