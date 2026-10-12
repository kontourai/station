import { describe, it } from 'vitest';
import {
  createSqliteKernelHarness,
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
