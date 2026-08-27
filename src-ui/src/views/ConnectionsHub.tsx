import { useEffect } from 'react';
import { useNavigation } from '../contexts/NavigationContext';
import { useConnectionSectionSignals } from './connections-hub/connection-section-signals';

/**
 * `/connections` is a resolver, not a sixth scrollable destination.
 *
 * Which section it resolves to is the SAME question the rail's warn dots
 * answer, so it asks the same derivation (sol review finding 6). Its own
 * copy read `/api/connections` raw for Models and Engines and did not look
 * at Knowledge at all, so the rail could show a dot on Knowledge while this
 * sent the visitor to Models.
 */
export function ConnectionsHub() {
  const { navigate } = useNavigation();
  const { firstNeedingAttention } = useConnectionSectionSignals();
  useEffect(() => {
    navigate(firstNeedingAttention?.path ?? '/connections/models');
  }, [firstNeedingAttention?.path, navigate]);
  return null;
}
