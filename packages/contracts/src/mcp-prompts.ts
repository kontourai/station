/**
 * #3284: an MCP server prompt offered to one agent as a slash command.
 *
 * MCP prompt arguments are named string parameters (`name`, `description`,
 * `required`); the protocol gives them no other type, so neither does this.
 */
export interface AgentMcpPromptArgument {
  name: string;
  description?: string;
  required: boolean;
}

export interface AgentMcpPrompt {
  /** The typed command word without its slash: `<serverId>:<promptName>`. */
  command: string;
  serverId: string;
  name: string;
  title?: string;
  description?: string;
  arguments: AgentMcpPromptArgument[];
}

export interface AgentMcpPromptListing {
  prompts: AgentMcpPrompt[];
  /** Servers in the agent's tool view whose prompts could not be read. */
  unavailable: Array<{ serverId: string; reason: string }>;
}

/** The text a prompt produced, inserted into the turn as the user's message. */
export interface AgentMcpPromptRun {
  serverId: string;
  name: string;
  text: string;
  /** This Station can carry the origin into a supported foreground turn. */
  turnOriginSupported?: true;
  /** Opaque, short-lived proof binding origin and text to this prompt run. */
  originReceipt?: string;
}

export interface AgentMcpPromptOrigin {
  serverId: string;
  name: string;
  receipt: string;
}

/** Server-verified companion; never accepted from a public send. */
export interface VerifiedMcpPromptOrigin {
  serverId: string;
  name: string;
  untrusted: boolean;
}
