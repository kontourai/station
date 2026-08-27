import { describe, expect, test, vi } from 'vitest';
import { ApprovalRegistry } from '../../approvals/approval-registry.js';
import { ACPManager } from '../acp-bridge.js';

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe('ACPManager', () => {
  test('getStatus returns empty connections array', () => {
    const mgr = new ACPManager(
      new ApprovalRegistry(mockLogger),
      mockLogger,
      '/tmp',
    );
    expect(mgr.getStatus().connections).toEqual([]);
  });

  test('shutdown without error', async () => {
    const mgr = new ACPManager(
      new ApprovalRegistry(mockLogger),
      mockLogger,
      '/tmp',
    );
    await expect(mgr.shutdown()).resolves.toBeUndefined();
  });

  test('removeConnection is no-op for unknown id', async () => {
    const mgr = new ACPManager(
      new ApprovalRegistry(mockLogger),
      mockLogger,
      '/tmp',
    );
    await expect(mgr.removeConnection('nonexistent')).resolves.toBeUndefined();
  });
});
