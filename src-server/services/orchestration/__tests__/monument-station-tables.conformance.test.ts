import {
  createSqliteKernelHarness,
  kernelConformanceCasesFor,
  registerKernelConformance,
} from '@kontourai/monument/testing';
import { describe, it } from 'vitest';
import { ORCHESTRATION_EVENT_STORE_MIGRATION } from '../../../domain/migrations/003-orchestration-events.js';
import {
  SESSION_CONTROL_REQUEST_KEY_KERNEL_TABLES,
  SESSION_CONTROL_REQUEST_KEY_SCHEMA,
} from '../session-control-request-keys.js';
import { STATION_TURN_DEDUP_KERNEL_TABLES } from '../sqlite-turn-dedup-persistence.js';

/**
 * Monument's own conformance suite, run against the adapter Station uses: the
 * same table bindings `EventStore` opens, over Station's real DDL, through
 * both the asynchronous port and `executeSync`. A binding that drifted from
 * the kernel's rules (a renamed column, a different owner encoding, a purge
 * that spares unresolved rows) fails here, not in production.
 *
 * Each runtime keeps only the machines it uses, so each runs the cases for
 * those. Turn boundaries are not Station's here, so none of their cases run.
 */
for (const via of ['execute', 'executeSync'] as const) {
  registerKernelConformance(
    { describe, it },
    createSqliteKernelHarness({
      name: `Station turn dedup tables (${via})`,
      via,
      tables: STATION_TURN_DEDUP_KERNEL_TABLES,
      prepare: (database) => database.exec(ORCHESTRATION_EVENT_STORE_MIGRATION),
    }),
    kernelConformanceCasesFor(['turnDedup']),
  );
  registerKernelConformance(
    { describe, it },
    createSqliteKernelHarness({
      name: `Station session-control request-key table (${via})`,
      via,
      tables: SESSION_CONTROL_REQUEST_KEY_KERNEL_TABLES,
      prepare: (database) => database.exec(SESSION_CONTROL_REQUEST_KEY_SCHEMA),
    }),
    kernelConformanceCasesFor(['requestKeys']),
  );
}
