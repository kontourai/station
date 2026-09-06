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

test('pending readers observe the latest base at continuation rather than a superseded publication', async () => {
  vi.useFakeTimers();
  _setApiBase('');
  const pending = _getApiBase();
  _setApiBase('https://first.example.test');
  _setApiBase('https://latest.example.test');
  expect(await pending).toBe('https://latest.example.test');
  _setApiBase('');
  const cleared = _getApiBase();
  _setApiBase('https://superseded.example.test');
  _setApiBase('');
  await Promise.resolve();
  _setApiBase('https://restored.example.test');
  expect(await cleared).toBe('https://restored.example.test');
});
