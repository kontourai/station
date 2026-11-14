import { vi } from 'vitest';

export function useAdvancingHistoricalClock(startAt: number) {
  const OriginalDate = Date;
  const started = performance.now();
  const now = () => startAt + Math.floor(performance.now() - started);
  vi.stubGlobal(
    'Date',
    new Proxy(OriginalDate, {
      construct(target, args, newTarget) {
        return Reflect.construct(
          target,
          args.length ? args : [now()],
          newTarget,
        );
      },
      apply() {
        return new OriginalDate(now()).toString();
      },
      get(target, key, receiver) {
        return key === 'now' ? now : Reflect.get(target, key, receiver);
      },
    }),
  );
}
