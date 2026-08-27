import debug from 'debug';

// Create namespaced loggers
export const log = {
  context: debug('app:context'),
  api: debug('app:api'),
  chat: debug('app:chat'),
  workflow: debug('app:workflow'),
  plugin: debug('app:plugin'),
  auth: debug('app:auth'),
};

// Enable all logs in development by default
if (import.meta.env.DEV && !localStorage.getItem('debug')) {
  debug.enable('app:*');
}
