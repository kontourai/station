import { useCustomAppearanceQuery } from '@kontourai/station-sdk';
import { useEffect } from 'react';
import { useHostRequestAuthorityScope } from '../contexts/ApiBaseContext';
import { setActiveCustomAppearance } from '../lib/custom-appearance/controller';

/** A definite answer that this caller has no custom appearance here. */
function definitelyNone(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return (
    typeof status === 'number' &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429
  );
}

/**
 * Applies the signed-in person's custom appearance once `/api/me/appearance`
 * answers, and whenever it changes. `main.tsx` applies the cached copy before
 * the first render; this replaces it with the server's answer, so a different
 * person's appearance never outlives that answer. A refusal (no person, an
 * older Station without the route) turns it off; a network failure keeps
 * what is shown.
 */
export function CustomAppearanceBridge(): null {
  const scope = useHostRequestAuthorityScope();
  const query = useCustomAppearanceQuery(scope ?? undefined);
  const data = query.data;
  const error = query.error;
  useEffect(() => {
    if (data) setActiveCustomAppearance(data.active);
  }, [data]);
  useEffect(() => {
    if (definitelyNone(error)) setActiveCustomAppearance(null);
  }, [error]);
  return null;
}
