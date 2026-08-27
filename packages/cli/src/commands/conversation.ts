import { writeFileSync } from 'node:fs';
import {
  optionalValueFlag,
  type ParsedCoreArgs,
  requestText,
  requirePositional,
} from './core-api.js';

/**
 * station#1999 S2: `station conversation export <agent> <conversationId>`
 * — portable transcript export through the server's unified conversation
 * read path, so every engine family (Station engine, Claude Code, Codex,
 * ACP-connected apps) exports identically. Formats are the server's ferry
 * output formats; `thread` (canonical @kontourai/thread JSON) is the
 * default.
 */
export async function runConversationCommand(
  apiBase: string,
  parsed: ParsedCoreArgs,
): Promise<void> {
  const verb = parsed.positionals[0];
  if (verb !== 'export') {
    throw new Error(
      `Unknown conversation subcommand "${verb ?? ''}" (expected: export)`,
    );
  }
  const agentSlug = requirePositional(parsed, 1, 'agent slug');
  const conversationId = requirePositional(parsed, 2, 'conversation id');
  const format = optionalValueFlag(parsed, 'format') ?? 'thread';
  const output = optionalValueFlag(parsed, 'output');

  const { body } = await requestText(
    apiBase,
    `/agents/${encodeURIComponent(agentSlug)}/conversations/${encodeURIComponent(conversationId)}/export?format=${encodeURIComponent(format)}`,
  );

  if (output) {
    writeFileSync(output, body.endsWith('\n') ? body : `${body}\n`);
    console.error(`wrote ${output}`);
    return;
  }
  console.log(body);
}
