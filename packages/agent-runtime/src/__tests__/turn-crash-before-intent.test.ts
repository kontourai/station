import { afterEach, expect, it } from 'vitest';
import { turnFixture } from './turn-fixture.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const intent = {
  id: 'tool:write-1',
  input: { value: 'hello' },
  replay: 'unsafe' as const,
};
it('a crash before tool intent commits reruns the step and executes its body once', async () => {
  const f = await turnFixture();
  cleanup.push(() => f.close());
  let effects = 0;
  const held = f.crash.holdNextCommit();
  const pending = f.lease.tool(intent, async () => ++effects);
  const failure = expect(pending).rejects.toThrow('crashed');
  await held.entered;
  const restored = await f.recover();
  await failure;
  expect(effects).toBe(0);
  expect(await restored.tool(intent, async () => ++effects)).toBe(1);
  expect(effects).toBe(1);
});
