import { expect, test, vi } from 'vitest';

// A fresh module per test: the first-seen set is process state.
async function fresh() {
  vi.resetModules();
  return import('../extension-notification-bindings.js');
}

test('the unbound first-seen set stops growing at its cap and counts the overflow', async () => {
  const bindings = await fresh();
  expect(bindings.UNBOUND_EXTENSION_NOTICE_KEYS_MAX).toBe(256);
  const max = bindings.UNBOUND_EXTENSION_NOTICE_KEYS_MAX;
  for (let i = 0; i < max; i++)
    expect(
      bindings.takeUnboundExtensionNotice('acp', '_engine.chosen', `t${i}`),
    ).toBe(true);
  // A key already seen is still recognised.
  expect(
    bindings.takeUnboundExtensionNotice('acp', '_engine.chosen', 't0'),
  ).toBe(false);
  expect(bindings.unboundExtensionNoticeOverflow()).toBe(0);
  // Past the cap: not remembered, so a repeat is not "first" either.
  for (let i = 0; i < 3; i++)
    expect(
      bindings.takeUnboundExtensionNotice('acp', '_engine.chosen', 'beyond'),
    ).toBe(false);
  expect(bindings.unboundExtensionNoticeOverflow()).toBe(3);
});
