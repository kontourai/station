import { writeFileSync } from 'node:fs';
import {
  forkConversation,
  setConversationWorkState,
} from '@kontourai/station-sdk/client';
import {
  getResolvedApiBase,
  optionalValueFlag,
  type ParsedCoreArgs,
  printJson,
  requestJson,
  requestText,
  requirePositional,
} from './core-api.js';
import { explainRequestFailure } from './errors.js';
import { terminalSafeText } from './terminal-safe.js';

/**
 * station#1999 S2: `station conversation export <agent> <conversationId>`
 * — portable transcript export through the server's unified conversation
 * read path, so every engine family (Station engine, Claude Code, Codex,
 * ACP-connected apps) exports identically. Formats are the server's ferry
 * output formats; `thread` (canonical @kontourai/thread JSON) is the
 * default.
 *
 * `station conversation fork <agent> <conversationId>` forks it through the
 * route and fetcher the web app's fork uses (`forkConversation`), as the
 * person: the same request Station Control's `fork_conversation` makes for
 * an agent, without that tool's scope rule, which holds only agents.
 *
 * `station conversation settle|reopen <conversationId>` moves it between
 * Open and Settled in your own inbox (the Open and Settled inbox preview),
 * through the route the inbox row and Station Control's
 * `settle_conversation` use.
 */
export async function runConversationCommand(
  apiBase: string,
  parsed: ParsedCoreArgs,
): Promise<void> {
  const verb = parsed.positionals[0];
  if (verb === 'search') {
    const query = new URLSearchParams({
      query: requirePositional(parsed, 1, 'search phrase'),
    });
    for (const [flag, key] of [
      ['project', 'projectSlug'],
      ['agent', 'agent'],
      ['limit', 'limit'],
    ] as const) {
      const value = optionalValueFlag(parsed, flag);
      if (value !== undefined) query.set(key, value);
    }
    printJson(
      await requestJson(apiBase, `/api/conversations/work/search?${query}`),
    );
    return;
  }
  if (verb === 'delete') {
    const agent = requirePositional(parsed, 1, 'agent slug');
    const conversationId = requirePositional(parsed, 2, 'conversation id');
    if (parsed.flags.confirm !== true)
      throw new Error('Deleting a conversation requires --confirm.');
    try {
      printJson(
        await requestJson(
          apiBase,
          `/agents/${encodeURIComponent(agent)}/conversations/${encodeURIComponent(conversationId)}/owned`,
          { method: 'DELETE' },
        ),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        'status' in error &&
        error.status === 404 &&
        !('code' in error)
      ) {
        throw new Error(
          'This Station does not support owner-scoped conversation deletion.',
          { cause: error },
        );
      }
      throw error;
    }
    return;
  }
  if (verb === 'fork') return runConversationFork(apiBase, parsed);
  if (verb === 'settle' || verb === 'reopen')
    return runConversationResolution(apiBase, parsed, verb === 'settle');
  if (verb !== 'export') {
    throw new Error(
      `Unknown conversation subcommand "${verb ?? ''}" (expected: delete, export, fork, settle, reopen, search)`,
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

async function runConversationFork(
  apiBase: string,
  parsed: ParsedCoreArgs,
): Promise<void> {
  const agentSlug = requirePositional(parsed, 1, 'agent slug');
  const conversationId = requirePositional(parsed, 2, 'conversation id');
  const targetAgent = optionalValueFlag(parsed, 'target-agent') ?? agentSlug;
  const targetProjectSlug = optionalValueFlag(parsed, 'project');
  const branchPointTurnId = optionalValueFlag(parsed, 'turn');
  const idempotencyKey = optionalValueFlag(parsed, 'idempotency-key');
  const jsonMode = parsed.flags.json === true;
  let data: Awaited<ReturnType<typeof forkConversation>>;
  try {
    data = await forkConversation(
      apiBase,
      agentSlug,
      conversationId,
      targetAgent,
      {
        ...(targetProjectSlug ? { targetProjectSlug } : {}),
        ...(branchPointTurnId ? { branchPointTurnId } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      },
    );
  } catch (error) {
    // As `station delegate`: Station unreachable exits 2, a refusal 3.
    const transport = explainRequestFailure(error, getResolvedApiBase());
    console.error(
      'Error:',
      terminalSafeText(
        transport ?? (error instanceof Error ? error.message : String(error)),
      ),
    );
    process.exit(transport ? 2 : 3);
    return;
  }
  if (jsonMode) {
    console.log(JSON.stringify({ ok: true, kind: 'conversation.fork', data }));
    return;
  }
  // The ids and disclosure are the Station's text: made safe, as its errors are.
  console.log(
    [
      `Forked ${conversationId} into conversation ${data.conversationId}${
        data.branchPointTurnId ? ` (from turn ${data.branchPointTurnId})` : ''
      }`,
      ...(data.disclosure ? [data.disclosure] : []),
    ]
      .map(terminalSafeText)
      .join('\n'),
  );
}

async function runConversationResolution(
  apiBase: string,
  parsed: ParsedCoreArgs,
  settled: boolean,
): Promise<void> {
  const conversationId = requirePositional(parsed, 1, 'conversation id');
  try {
    await setConversationWorkState(apiBase, conversationId, settled);
  } catch (error) {
    // As `fork`: Station unreachable exits 2, a refusal 3.
    const transport = explainRequestFailure(error, getResolvedApiBase());
    console.error(
      'Error:',
      terminalSafeText(
        transport ?? (error instanceof Error ? error.message : String(error)),
      ),
    );
    process.exit(transport ? 2 : 3);
    return;
  }
  if (parsed.flags.json === true) {
    console.log(
      JSON.stringify({
        ok: true,
        kind: 'conversation.work-state',
        data: { conversationId, settled },
      }),
    );
    return;
  }
  console.log(
    terminalSafeText(
      `${settled ? 'Settled' : 'Reopened'} conversation ${conversationId}`,
    ),
  );
}
