import { describe, it } from 'vitest';
import {
  memoryKernelHarness,
  registerKernelConformance,
} from '../testing/index.js';

registerKernelConformance({ describe, it }, memoryKernelHarness);
