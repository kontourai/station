/** @vitest-environment jsdom */
import { afterEach, expect, test, vi } from 'vitest';
import { bannerStore } from '../contexts/banner-store';

afterEach(() => bannerStore.reset());

test('updating a condition replaces its action with the current remedy', () => {
  const stale = vi.fn();
  const current = vi.fn();
  const condition = {
    id: 'station-repair',
    priority: 100,
    tone: 'error' as const,
    message: 'Pair this Station',
  };
  bannerStore.present({
    ...condition,
    actions: [{ label: 'Pair', onClick: stale }],
  });
  bannerStore.present({
    ...condition,
    actions: [{ label: 'Pair', onClick: current }],
  });
  const action = bannerStore.getSnapshot()[0]?.actions?.[0];
  action?.onClick?.();
  expect(current).toHaveBeenCalledOnce();
  expect(stale).not.toHaveBeenCalled();
  expect(bannerStore.getSnapshot()).toHaveLength(1);
});

test('clearing one source preserves unrelated active conditions', () => {
  const condition = {
    priority: 40,
    tone: 'warning' as const,
    message: 'Check Station',
  };
  bannerStore.present({ ...condition, id: 'connection:repair' });
  bannerStore.present({ ...condition, id: 'recovery:copy' });
  bannerStore.clear('connection:');
  expect(bannerStore.getSnapshot().map((item) => item.id)).toEqual([
    'recovery:copy',
  ]);
});

test('an old persisted banner dismissal cannot hide a live Station condition', async () => {
  localStorage.setItem(
    'station.banners.dismissed',
    JSON.stringify({ 'chrome:onboarding:credential': 'same-incident' }),
  );
  vi.resetModules();
  const { bannerStore: reloaded } = await import('../contexts/banner-store');
  reloaded.present({
    id: 'chrome:onboarding:credential',
    occurrence: 'same-incident',
    priority: 100,
    tone: 'blocked',
    message: 'Request access to this Station.',
    dismissible: false,
  });
  expect(reloaded.getSnapshot()[0]?.message).toBe(
    'Request access to this Station.',
  );
  reloaded.reset();
  localStorage.removeItem('station.banners.dismissed');
});
