/**
 * SSEBroadcaster — fan-out to connected SSE clients.
 * Shared by BuiltinScheduler and SchedulerService (dedicated /scheduler/events endpoint).
 * NotificationService uses EventBus instead (main /events endpoint).
 */

export class SSEBroadcaster {
  private clients = new Set<(data: string) => void>();

  subscribe(send: (data: string) => void): () => void {
    this.clients.add(send);
    return () => this.clients.delete(send);
  }

  broadcast(event: Record<string, unknown>): void {
    const data = JSON.stringify(event);
    for (const send of this.clients) {
      try {
        send(data);
      } catch (e) {
        console.debug('Failed to broadcast SSE event, removing client:', e);
        this.clients.delete(send);
      }
    }
  }
}
