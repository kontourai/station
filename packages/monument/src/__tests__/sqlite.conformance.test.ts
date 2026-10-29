import { describe, it } from 'vitest';
import {
  createSqliteKernelHarness,
  kernelConformanceCasesFor,
  registerKernelConformance,
} from '../testing/index.js';

// The same cases through the portable async port and through the
// node:sqlite-only synchronous extension: identical expectations prove the
// two paths agree.
registerKernelConformance({ describe, it }, createSqliteKernelHarness());
registerKernelConformance(
  { describe, it },
  createSqliteKernelHarness({ via: 'executeSync' }),
);

// The existing host receipt layout is consumed in place, with no shadow table.
registerKernelConformance(
  { describe, it },
  createSqliteKernelHarness({
    name: 'bound steer receipts',
    tables: {
      turnDedup: 'unused',
      turnBoundary: 'unused',
      requestKeys: 'unused',
      inbox: 'unused',
      steerReceipts: { table: 'host_steer_inputs' },
    },
    prepare: (database) =>
      database.exec(`CREATE TABLE host_steer_inputs (
      thread_id TEXT NOT NULL, client_input_id TEXT NOT NULL, input_digest TEXT NOT NULL,
      confirmed_turn_id TEXT, PRIMARY KEY(thread_id, client_input_id)
    )`),
  }),
  kernelConformanceCasesFor(['steerReceipts']),
);
