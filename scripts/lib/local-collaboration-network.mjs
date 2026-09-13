import { Socket } from 'node:net';

/** Diagnostic guard in disposable lab children, not a hostile-code sandbox. */
export function restrictAccountLabTcp(ports) {
  const allowed = new Set(ports);
  const connect = Socket.prototype.connect;
  Socket.prototype.connect = function (...input) {
    const args = Array.isArray(input[0]) ? input[0] : input;
    const value = args[0];
    const options =
      value && typeof value === 'object'
        ? value
        : {
            port: value,
            host: typeof args[1] === 'string' ? args[1] : 'localhost',
          };
    const host = options.host ?? 'localhost';
    if (
      options.path ||
      !['localhost', '127.0.0.1', '::1'].includes(host) ||
      !allowed.has(Number(options.port))
    ) {
      const error = new Error('Account lab refused an unowned TCP destination');
      error.code = 'ACCOUNT_LAB_TCP_REFUSED';
      throw error;
    }
    return connect.apply(this, input);
  };
}
