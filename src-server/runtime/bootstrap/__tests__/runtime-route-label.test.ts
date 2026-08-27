import { redactDeep } from '@kontourai/station-shared/redaction';
import { describe, expect, test } from 'vitest';
import {
  buildRuntimeRouteVocabulary,
  labelRuntimeRoutePath,
} from '../runtime-route-label.js';

describe('runtime security audit route labels', () => {
  const vocabulary = buildRuntimeRouteVocabulary([
    { method: 'GET', path: '/api/agents/:id/chat' },
    { method: 'GET', path: '/config/app' },
    { method: 'GET', path: '/notifications' },
    { method: 'GET', path: '/files/*' },
  ]);

  test('builds vocabulary from static route segments only', () => {
    expect([...vocabulary].sort()).toEqual([
      'agents',
      'api',
      'app',
      'chat',
      'config',
      'files',
      'notifications',
    ]);
    expect(vocabulary.has(':id')).toBe(false);
    expect(vocabulary.has('*')).toBe(false);
  });

  test('renders paths made entirely from mounted server literals', () => {
    expect(labelRuntimeRoutePath('/api/notifications', vocabulary)).toBe(
      'api/notifications',
    );
    expect(labelRuntimeRoutePath('/config/app', vocabulary)).toBe('config/app');
  });

  test('masks caller-supplied segments even when they look like secrets', () => {
    const label = labelRuntimeRoutePath(
      '/api/agents/sk-live-abc123/chat',
      vocabulary,
    );

    expect(label).toBe('api/agents/*/chat');
    expect(label).not.toContain('sk-live-abc123');
  });

  test('leaks no caller text when no path segment is known', () => {
    const label = labelRuntimeRoutePath(
      '/caller-only/secret-shaped-value',
      vocabulary,
    );

    expect(label).toBe('*/*');
    expect(label).not.toContain('caller-only');
    expect(label).not.toContain('secret-shaped-value');
  });

  test('survives deep redaction byte-identically', () => {
    const routeLabel = labelRuntimeRoutePath(
      '/api/agents/sk-live-abc123/chat',
      vocabulary,
    );
    const redacted = redactDeep({ routeLabel });

    expect(redacted.routeLabel).toBe(routeLabel);
  });
});
