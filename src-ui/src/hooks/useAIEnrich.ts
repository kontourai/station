import { invoke } from '@kontourai/station-sdk';
import { useCallback, useRef, useState } from 'react';

/**
 * Hook for AI-enriching form fields via POST /invoke.
 * Returns { enrich, isEnriching } where enrich(prompt) returns the generated text.
 */
export function useAIEnrich() {
  const [isEnriching, setIsEnriching] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const enrich = useCallback(async (prompt: string): Promise<string> => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setIsEnriching(true);

    try {
      const result = await Promise.race([
        invoke({
          prompt,
          system:
            'You are a concise content generator for a UI form. Output ONLY the requested text. No questions, no preamble, no explanation, no markdown formatting unless requested.',
        }),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener(
            'abort',
            () => reject(new Error('Aborted')),
            { once: true },
          );
        }),
      ]);

      return typeof result === 'string' ? result : '';
    } finally {
      setIsEnriching(false);
      abortRef.current = null;
    }
  }, []);

  return { enrich, isEnriching };
}
