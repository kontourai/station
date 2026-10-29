export type ProjectDestination = 'overview' | 'room' | 'tasks' | 'sources';

/** Existing Starter Work links must still open their task creation handoff. */
export function projectDestination(search: string): ProjectDestination {
  const params = new URLSearchParams(search);
  const destination = params.get('section');
  if (
    destination === 'room' ||
    destination === 'tasks' ||
    destination === 'sources'
  ) {
    return destination;
  }
  if (!destination && params.get('starter') === 'start-task') return 'tasks';
  return 'overview';
}
