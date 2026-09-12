import { afterEach, describe, expect, test, vi } from 'vitest';
import { _resetUnboundExtensionNotices } from '../../../src-shared/extension-notification-bindings.js';
import { observeInboundExtensionNotification } from '../extension-notification-observe.js';

describe('observeInboundExtensionNotification', () => {
  afterEach(() => {
    _resetUnboundExtensionNotices();
  });

  test('bound tuples do not warn', () => {
    const warn = vi.fn();
    expect(
      observeInboundExtensionNotification({
        provider: 'acp',
        namespace: '_kiro.dev',
        type: 'compaction/status',
        logger: { warn },
      }),
    ).toBe('bound');
    expect(warn).not.toHaveBeenCalled();
  });

  test('unbound tuples warn once with namespace and type, never the payload', () => {
    const warn = vi.fn();
    expect(
      observeInboundExtensionNotification({
        provider: 'acp',
        namespace: '_x.ai',
        type: 'never/seen',
        logger: { warn },
      }),
    ).toBe('unbound');
    expect(
      observeInboundExtensionNotification({
        provider: 'acp',
        namespace: '_x.ai',
        type: 'never/seen',
        logger: { warn },
      }),
    ).toBe('unbound');
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('Unbound extension.notification');
    expect(warn.mock.calls[0][1]).toEqual({
      provider: 'acp',
      namespace: '_x.ai',
      type: 'never/seen',
    });
  });
});
