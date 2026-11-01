import { beforeEach, expect, test, vi } from 'vitest';

const ports = vi.hoisted(() => ({
  findFreePortBlock: vi.fn(),
  findFreePortOutside: vi.fn(),
}));
vi.mock('../lib/free-ports.mjs', () => ports);

import { choosePortableSmokePorts } from '../lib/portable-smoke-ports.mjs';

beforeEach(() => vi.resetAllMocks());

test('skips a block containing a reserved port and a reserved UI candidate', async () => {
  ports.findFreePortBlock
    .mockResolvedValueOnce(37998)
    .mockResolvedValueOnce(42000)
    .mockResolvedValueOnce(43000);
  ports.findFreePortOutside
    .mockResolvedValueOnce(38000)
    .mockResolvedValueOnce(44000);
  await expect(choosePortableSmokePorts()).resolves.toEqual({
    serverPort: 43000,
    uiPort: 44000,
  });
  expect(ports.findFreePortOutside).toHaveBeenCalledTimes(2);
  expect(ports.findFreePortOutside).toHaveBeenLastCalledWith(43000, 4);
});

test('fails closed when every candidate block contains a reserved port', async () => {
  ports.findFreePortBlock.mockResolvedValue(37998);
  await expect(choosePortableSmokePorts()).rejects.toThrow(
    'unable to allocate non-reserved portable smoke ports',
  );
  expect(ports.findFreePortBlock).toHaveBeenCalledTimes(100);
  expect(ports.findFreePortOutside).not.toHaveBeenCalled();
});
