import { useRef } from 'react';

/**
 * Simple in-memory email→name cache for the current session.
 * Used to resolve display names for attendees without extra API calls.
 */
export function useLocalSalesState() {
  const cache = useRef<Map<string, string>>(new Map());

  function addEmailName(email: string, name: string): void {
    cache.current.set(email.toLowerCase(), name);
  }

  function getNameForEmail(email: string): string | undefined {
    return cache.current.get(email.toLowerCase());
  }

  return { addEmailName, getNameForEmail };
}
