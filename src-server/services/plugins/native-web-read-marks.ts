/**
 * #4828: engine-native web reads mark the conversation as having read
 * content written by others, the same mark an `untrusted` integration's
 * result sets (untrusted-content-policy.ts). After it, the conversation's
 * later tool calls take the untrusted-content permission and its writes to
 * known agent-instruction and git-hook locations are denied by path, as a
 * best-effort early check that does not contain git hook execution
 * (untrusted-persistence-protection.ts).
 *
 * Each engine is marked where Station sees its web reads complete:
 * - Station engine: `afterToolCall` for the HTTP request built-in
 *   (agent-hooks.ts);
 * - Claude Code: an in-process `PostToolUse` hook for its web tools
 *   (claude-adapter.ts);
 * - Codex: a completed `webSearch` item on the app-server stream, the
 *   session's own or a subagent's (codex-adapter-notifications.ts,
 *   codex-adapter-child-work.ts);
 * - ACP: a tool call the agent reports with kind `fetch`
 *   (acp-adapter-events.ts);
 * - every engine: Station's own browser tools, at the browser-agent route
 *   (browser-agent.ts).
 *
 * `nativeWebReadCoverage` reports the same seams per engine, and what each
 * cannot see. Nothing here assumes an engine is safe.
 */
import type { NativeWebReadCoverage } from '@kontourai/station-contracts/tool';
import type { InvocationContext } from '../../runtime/types.js';
import {
  sharedUntrustedContentLedger,
  type UntrustedContentLedger,
} from './untrusted-content-policy.js';

/** Claude Code's built-in tools that return content from the web. */
export const CLAUDE_NATIVE_WEB_READ_TOOLS: ReadonlySet<string> = new Set([
  'WebFetch',
  'WebSearch',
]);

/** Codex app-server `ThreadItem` type of a web search or page open. */
export const CODEX_WEB_SEARCH_ITEM_TYPE = 'webSearch';

/** A Codex `item/completed` notification for a web search or page open. */
export function isCodexWebSearchCompletion(notification: {
  method: string;
  params?: unknown;
}): boolean {
  if (notification.method !== 'item/completed') return false;
  const params = notification.params;
  if (!params || typeof params !== 'object') return false;
  const item = (params as { item?: unknown }).item;
  return (
    !!item &&
    typeof item === 'object' &&
    (item as { type?: unknown }).type === CODEX_WEB_SEARCH_ITEM_TYPE
  );
}

/** ACP `ToolKind` for a tool that retrieves external data. */
export const ACP_FETCH_TOOL_KIND = 'fetch';

/** Station's browser operations that do not return page content. */
const BROWSER_OPERATIONS_WITHOUT_PAGE_CONTENT: ReadonlySet<string> = new Set([
  'status',
  'close',
]);

/**
 * Whether a browser-agent operation reads or drives a page. Unknown
 * operations count as reads.
 */
export function browserOperationReadsPage(operation: string): boolean {
  return !BROWSER_OPERATIONS_WITHOUT_PAGE_CONTENT.has(operation);
}

/**
 * Records a native web read for every id the conversation is known by (a
 * session and its conversation). The mark is recorded before this returns,
 * so the engine's next pre-tool check sees it.
 */
export function markNativeWebRead(
  conversationIds: readonly (string | undefined)[],
  options: {
    ledger?: UntrustedContentLedger;
    delegation?: InvocationContext['delegation'];
  } = {},
): void {
  const ledger = options.ledger ?? sharedUntrustedContentLedger;
  for (const id of new Set(conversationIds))
    if (id)
      ledger.markConversation(id, Promise.resolve(true), options.delegation);
}

/**
 * Per engine, whether Station marks the conversation when the engine reads
 * the web with its own built-in tools. `covered`: each of them marks it;
 * `partial`: Station marks only what the engine labels as a web read;
 * `uncovered`: nothing marks it. A shell command that downloads (curl, wget)
 * is not recognised as a web read on any engine. Station's browser tools
 * mark for every engine they are delivered to and are not repeated here.
 */
export function nativeWebReadCoverage(): NativeWebReadCoverage[] {
  return [
    {
      engine: 'station',
      coverage: 'covered',
      signals: ['http_request'],
      reason:
        "Station runs this engine's tools itself: the HTTP request built-in marks the turn and the conversation when it returns.",
    },
    {
      engine: 'claude',
      coverage: 'covered',
      signals: [...CLAUDE_NATIVE_WEB_READ_TOOLS],
      reason:
        'A PostToolUse hook Station registers in the engine marks the conversation when WebFetch or WebSearch returns, in a subagent too.',
    },
    {
      engine: 'codex',
      coverage: 'covered',
      signals: [CODEX_WEB_SEARCH_ITEM_TYPE],
      reason:
        "Codex reports each web search and page open as a webSearch item, which marks the conversation when it completes. Station's pre-tool policy does not run for Codex's own file changes and commands, so after the mark only its sandbox, when confined, keeps repository hooks and configuration read-only.",
    },
    {
      engine: 'acp',
      coverage: 'partial',
      signals: [`kind:${ACP_FETCH_TOOL_KIND}`],
      reason:
        'A tool call the agent reports with kind "fetch" marks the conversation. The kind is the agent\'s own label, so a web tool it reports as another kind does not mark it.',
    },
    {
      engine: 'muse',
      coverage: 'uncovered',
      signals: [],
      reason:
        "Station receives muse's tool results by name but does not know which of its tools read the web, and muse has no hook Station can install. Nothing marks the conversation.",
    },
  ];
}
