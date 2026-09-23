/**
 * Compile-checked copy of the "Agents & Chat" example in
 * docs/guides/plugins.md (#2400). The guide's code block must equal this file
 * from its first `import` on: scripts/__tests__/docs-snippets.test.ts holds the
 * two together, and `npm run typecheck:examples` compiles this one.
 */
import { useAgentInvokeMutation, useSendToChat } from '@kontourai/station-sdk';

export function SummarizeActions() {
  // Send a message to an Agent your plugin contributes. The qualified form
  // names the plugin too, and sends only when the named plugin contributed
  // that Agent.
  const sendToChat = useSendToChat('my-plugin:assistant');

  // Invoke an Agent programmatically (no chat UI), by its Agent id.
  const invoke = useAgentInvokeMutation('assistant');

  return (
    <>
      <button
        type="button"
        onClick={() => sendToChat('Summarize this document')}
      >
        Summarize in chat
      </button>
      <button type="button" onClick={() => invoke.mutate('Hello')}>
        Invoke without chat
      </button>
    </>
  );
}
