export interface TerminalTab {
  id: string;
  type: 'shell' | 'agent';
  label: string;
  mode?: 'chat' | 'terminal';
  agentSlug?: string;
  agentMode?: string;
  connectionId?: string;
  shell?: string;
  shellArgs?: string[];
}
