// Slash command plugin system
import type { QueryClient } from '@tanstack/react-query';
import type { BindingStatus } from '../utils/execution';

export type SlashCommandContext = {
  sessionId: string;
  chatState: any;
  agent: any;
  args: string[];
  apiBase: string;
  availableModels?: Array<{ id: string; name: string; originalId?: string }>;
  bindingStatus?: BindingStatus;
  updateChat: (sessionId: string, updates: any) => void;
  addEphemeralMessage: (
    sessionId: string,
    message: {
      role: 'user' | 'assistant' | 'system';
      content: string;
      contentType?: 'markdown' | 'html';
    },
  ) => void;
  queryClient: QueryClient;
  sendMessage: (content: string) => Promise<void>;
  autocomplete: {
    openModel: () => void;
    openNewChat: () => void;
    closeCommand: () => void;
    closeAll: () => void;
  };
};

// Commands just do their work, no return value needed
export type SlashCommandHandler = (
  context: SlashCommandContext,
) => Promise<void>;

// Command registry
const commands = new Map<string, SlashCommandHandler>();

// Register a command
export function registerCommand(name: string, handler: SlashCommandHandler) {
  commands.set(name, handler);
}

// Get command handler
export function getCommand(name: string): SlashCommandHandler | undefined {
  return commands.get(name);
}

// Get all command names
export function getAllCommands(): string[] {
  return Array.from(commands.keys());
}
