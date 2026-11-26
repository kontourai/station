/**
 * `@kontourai/flow-agents` modules that only async callers need, imported on
 * first use so the server does not load them at boot
 * (scripts/lib/server-static-imports.mjs). Each loader names the narrowest
 * subpath that exports what its callers use; the package root is far heavier
 * than any of them. A failed load rejects where the call would have thrown
 * and is not memoized, so the next caller retries it.
 */
function onFirstUse<T>(load: () => Promise<T>): () => Promise<T> {
  let loaded: Promise<T> | undefined;
  return () => {
    loaded ??= load().catch((error: unknown) => {
      loaded = undefined;
      throw error;
    });
    return loaded;
  };
}

export const loadNarrativeRetainedReader = onFirstUse(
  () => import('@kontourai/flow-agents/narrative-retained-reader'),
);

export const loadNarrativeRetainedProcessProjection = onFirstUse(
  () => import('@kontourai/flow-agents/narrative-retained-process-projection'),
);

export const loadSurveyFlowGateAdapter = onFirstUse(
  () => import('@kontourai/flow-agents/survey-flow-gate-adapter'),
);

export const loadSurveyFlowGateReviewWork = onFirstUse(
  () => import('@kontourai/flow-agents/survey-flow-gate-review-work'),
);
