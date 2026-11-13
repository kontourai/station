import { useEffect, useRef, useState } from 'react';
import { SkeletonBlock } from '../components/state';
import { useNavigation } from '../contexts/NavigationContext';
import { useConnectionSectionSignals } from './connections-hub/connection-section-signals';

/**
 * How long `/connections` waits for its first reads before resolving with
 * what it knows. A slow list must not leave the visitor on a blank route.
 */
export const CONNECTIONS_RESOLVE_WAIT_MS = 1_500;

/**
 * `/connections` is a resolver, not a sixth scrollable destination.
 *
 * Which section it resolves to is the SAME question the rail's warn dots
 * answer, so it asks the same derivation. Its own
 * copy read `/api/connections` raw for Models and Engines and did not look
 * at Knowledge at all, so the rail could show a dot on Knowledge while this
 * sent the visitor to Models.
 */
export function ConnectionsHub() {
  const { navigate } = useNavigation();
  const { firstNeedingAttention, settled } = useConnectionSectionSignals();
  const [waited, setWaited] = useState(false);
  const resolved = useRef(false);
  useEffect(() => {
    const timer = setTimeout(
      () => setWaited(true),
      CONNECTIONS_RESOLVE_WAIT_MS,
    );
    return () => clearTimeout(timer);
  }, []);
  // Resolve once, when the reads have answered or the wait is over. On first
  // render every read is still pending and nothing "needs attention" yet, so
  // resolving then landed on Models before Engines or Knowledge could say
  // otherwise. After the wait it resolves with whatever has answered.
  useEffect(() => {
    if (resolved.current || (!settled && !waited)) return;
    resolved.current = true;
    navigate(firstNeedingAttention?.path ?? '/connections/models');
  }, [settled, waited, firstNeedingAttention?.path, navigate]);
  return <SkeletonBlock count={3} label="Loading connections" />;
}
