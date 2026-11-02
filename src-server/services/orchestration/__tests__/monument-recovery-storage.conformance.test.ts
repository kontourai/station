import {
  createRecoveryHarness,
  registerRecoveryConformance,
} from '@kontourai/monument/testing';
import { describe, it } from 'vitest';
import {
  ensureOrchestrationRecoverySettlementColumns,
  ORCHESTRATION_EVENT_STORE_MIGRATION,
} from '../../../domain/migrations/003-orchestration-events.js';

for (const via of ['sync', 'async'] as const) {
  registerRecoveryConformance(
    { describe, it },
    createRecoveryHarness('sqlite', via, {
      table: 'orchestration_recovery_intents',
      prepare: (database) => {
        database.exec(ORCHESTRATION_EVENT_STORE_MIGRATION);
        ensureOrchestrationRecoverySettlementColumns(database);
      },
    }),
  );
}
