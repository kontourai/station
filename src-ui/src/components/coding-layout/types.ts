export interface TerminalTab {
  id: string;
  type: 'shell' | 'agent';
  label: string;
  mode?: 'chat' | 'terminal';
  agentSlug?: string;
  agentMode?: string;
  connectionId?: string;
  /** The server's terminal session, once one is open for this tab. */
  terminalId?: string;
  /** A pre-socket terminal whose owned history the next open imports once. */
  legacyTerminalId?: string;
}
