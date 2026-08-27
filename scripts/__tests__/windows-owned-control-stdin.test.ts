import { EventEmitter } from 'node:events';
import { expect, test } from 'vitest';
import { createWindowsOwnedControlStdin } from '../lib/windows-owned-control-stdin.mjs';

test('owns a closed guard stdin and suppresses asynchronous EPIPE', () => {
  const stdin = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    end: () => {},
    write: () => {
      throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    },
  });
  const control = createWindowsOwnedControlStdin(stdin);

  expect(control.writeAndEnd('ABORT')).toBe(false);
  expect(() => stdin.emit('error', new Error('write EPIPE'))).not.toThrow();
  expect(control.writeAndEnd('ABORT')).toBe(false);
});

test('does not write to an already-ended guard stdin', () => {
  let writes = 0;
  const stdin = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: true,
    end: () => {},
    write: () => {
      writes += 1;
    },
  });

  expect(createWindowsOwnedControlStdin(stdin).writeAndEnd('ABORT')).toBe(
    false,
  );
  expect(writes).toBe(0);
});
