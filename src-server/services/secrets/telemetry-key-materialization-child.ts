import { materializeAuthRef } from '@kontourai/station-contracts/datum-secret-reference';

process.once('disconnect', () => {
  if (process.platform !== 'win32') {
    try {
      process.kill(-process.pid, 'SIGKILL');
    } catch {
      /* already stopped */
    }
  }
  process.exit(1);
});

process.once('message', (message: unknown) => {
  try {
    const authRef =
      message && typeof message === 'object' && 'authRef' in message
        ? message.authRef
        : undefined;
    const key = materializeAuthRef(authRef);
    process.send?.({ key }, () => process.exit(0));
  } catch {
    process.send?.({ failed: true }, () => process.exit(1));
  }
});
