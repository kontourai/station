import { afterEach, expect, test, vi } from 'vitest';
import { _getApiBase, _setApiBase } from '../api-core';

afterEach(() => {
  _setApiBase('');
  vi.useRealTimers();
});

test('publication releases concurrent API readers without a polling tick', async () => {
  vi.useFakeTimers();
  _setApiBase('');
  const reads = Array.from({ length: 100 }, () => _getApiBase());
  expect(vi.getTimerCount()).toBe(100);
  _setApiBase('https://first.example.test');
  expect(await Promise.all(reads)).toEqual(
    Array(100).fill('https://first.example.test'),
  );
  expect(vi.getTimerCount()).toBe(0);
  _setApiBase('https://second.example.test');
  expect(await _getApiBase()).toBe('https://second.example.test');
});

test('unconfigured readers expire and do not poison a later initialization', async () => {
  vi.useFakeTimers();
  _setApiBase('');
  const refusal = expect(_getApiBase()).rejects.toThrow(
    'API base not configured',
  );
  await vi.advanceTimersByTimeAsync(500);
  await refusal;
  expect(vi.getTimerCount()).toBe(0);
  const later = _getApiBase();
  _setApiBase('');
  expect(vi.getTimerCount()).toBe(1);
  _setApiBase('https://ready.example.test');
  expect(await later).toBe('https://ready.example.test');
  expect(vi.getTimerCount()).toBe(0);
});
