import { knowledgeOps } from '../../telemetry/metrics.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger({ name: 'knowledge-observability' });

/** Metrics observe knowledge outcomes; they never become operation authority. */
export function observeKnowledgeOperation(op: string): void {
  try {
    knowledgeOps.add(1, { op });
  } catch (error) {
    try {
      logger.warn('Knowledge operation metric observer failed', { op, error });
    } catch {
      // Logging is also an observer.
    }
  }
}

/** Reports rebuildable derived-index failure without changing authority. */
export function observeKnowledgeDerivedFailure(
  operation: string,
  error: unknown,
): void {
  observeKnowledgeOperation('derived_index_unavailable');
  try {
    logger.warn('Knowledge derived index update failed', { operation, error });
  } catch {
    // Logging is also an observer.
  }
}
