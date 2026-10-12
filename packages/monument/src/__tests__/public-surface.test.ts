import { describe, expect, it } from 'vitest';
import * as adapter from '../adapter.js';
import * as root from '../index.js';
import { MemoryKernelVolume } from '../memory.js';
import * as sqlite from '../sqlite.js';
import * as testing from '../testing/index.js';

/** The package's entry points expose what a consumer needs and no more. */
describe('public surface', () => {
  it('keeps the adapter SPI behind ./adapter', () => {
    expect(Object.keys(root)).not.toContain('runKernelTransactionStep');
    expect(Object.keys(adapter)).toContain('runKernelTransactionStep');
  });

  it('keeps sqlite test helpers in ./testing', () => {
    expect(Object.keys(sqlite)).not.toContain('createSqliteKernelLocation');
    expect(Object.keys(sqlite)).not.toContain('createSqliteKernelHarness');
    expect(Object.keys(testing)).toContain('createSqliteKernelLocation');
    expect(Object.keys(testing)).toContain('createSqliteKernelHarness');
  });

  it("does not expose a memory volume's state", () => {
    const volume = new MemoryKernelVolume() as unknown as Record<
      string,
      unknown
    >;
    expect(Object.keys(volume)).toEqual([]);
    expect(volume.committed).toBeUndefined();
    expect(volume.inFlight).toBeUndefined();
  });
});
