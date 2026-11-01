import { afterEach, expect, it } from 'vitest';
import { gate, turnFixture } from './turn-fixture.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const intent = {
  id: 'tool:write-1',
  input: { value: 'hello' },
  replay: 'unsafe' as const,
};
for (const replay of ['unsafe', 'safe'] as const) {
  it(`a crash after ${replay} intent ${replay === 'safe' ? 'reruns once' : 'surfaces interruption without replay'}`, async () => {
    const f = await turnFixture();
    cleanup.push(() => f.close());
    const entered = gate();
    const release = gate();
    let effects = 0;
    const call = { ...intent, replay };
    const pending = f.lease.tool(call, async () => {
      effects++;
      entered.resolve();
      await release.promise;
      return 'old-result';
    });
    const oldFailure = expect(pending).rejects.toThrow('STALE');
    cleanup.push(async () => {
      release.resolve();
      await oldFailure;
    });
    await entered.promise;
    const restored = await f.recover();
    const invoke = () =>
      restored.tool(call, async () => {
        effects++;
        return 'restored-result';
      });
    const results = await Promise.all([invoke(), invoke()]);
    if (replay === 'unsafe') {
      expect(results).toEqual([
        expect.objectContaining({
          status: 'interrupted',
          outcome: 'indeterminate',
        }),
        expect.objectContaining({
          status: 'interrupted',
          outcome: 'indeterminate',
        }),
      ]);
      expect(effects).toBe(1);
    } else {
      expect(results).toEqual(['restored-result', 'restored-result']);
      expect(effects).toBe(2);
    }
    release.resolve();
    await oldFailure;
  });
}
