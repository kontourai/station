/**
 * The `@kontourai/flow-agents` root barrel, imported on first use. Its async
 * callers load it here so that once the synchronous callers that still import
 * the root statically move to narrower subpaths, the barrel is no longer
 * imported when the server boots (scripts/lib/server-static-imports.mjs). A
 * failed load rejects where the call would have thrown and is not memoized.
 */
type FlowAgentsRoot = typeof import('@kontourai/flow-agents');

let flowAgentsRoot: Promise<FlowAgentsRoot> | undefined;

export function loadFlowAgentsRoot(): Promise<FlowAgentsRoot> {
  flowAgentsRoot ??= import('@kontourai/flow-agents').catch(
    (error: unknown) => {
      flowAgentsRoot = undefined;
      throw error;
    },
  );
  return flowAgentsRoot;
}
