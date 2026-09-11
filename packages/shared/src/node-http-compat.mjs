import { channel } from 'node:diagnostics_channel';
import { Socket } from 'node:net';

const installed = Symbol.for('station.undici-tos-compat.installed');
const guarded = Symbol.for('station.undici-tos-compat.socket');

/**
 * Node 24's bundled Undici 7 can crash outside the fetch promise when macOS
 * rejects optional packet-priority setup. Follow the narrow socket boundary
 * of https://github.com/nodejs/undici/pull/5547 without replacing dispatchers,
 * changing proxy policy, or swallowing uncaught exceptions/network failures.
 * Remove this compatibility path when supported Node builds include that fix.
 */
export function installNodeHttpCompatibility({
  platform = process.platform,
  undiciVersion = process.versions.undici,
} = {}) {
  if (
    globalThis[installed] ||
    platform !== 'darwin' ||
    !undiciVersion?.startsWith('7.') ||
    typeof Socket.prototype.setTypeOfService !== 'function'
  )
    return;

  channel('undici:client:connected').subscribe((message) => {
    const socket = message?.socket;
    if (
      !(socket instanceof Socket) ||
      socket[guarded] ||
      !Object.isExtensible(socket) ||
      typeof socket.setTypeOfService !== 'function' ||
      Object.getOwnPropertyDescriptor(socket, 'setTypeOfService')
        ?.configurable === false
    )
      return;
    const original = socket.setTypeOfService;
    Object.defineProperty(socket, 'setTypeOfService', {
      configurable: true,
      writable: true,
      value(tos) {
        try {
          return original.call(this, tos);
        } catch (error) {
          if (error?.code !== 'EINVAL' || error?.syscall !== 'setTypeOfService')
            throw error;
          return this;
        }
      },
    });
    Object.defineProperty(socket, guarded, { value: true });
  });
  globalThis[installed] = true;
}
