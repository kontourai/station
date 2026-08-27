import type {
  Notification,
  ScheduleNotificationOpts,
} from '@kontourai/station-contracts/notification';
import { apiErrorMessage } from '../api-core';

export class NotificationsAPI {
  constructor(
    private apiBase: string,
    private authToken?: string,
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.authToken) h.Authorization = `Bearer ${this.authToken}`;
    return h;
  }

  async list(opts?: {
    status?: string[];
    category?: string[];
  }): Promise<Notification[]> {
    const params = new URLSearchParams();
    opts?.status?.forEach((s) => params.append('status', s));
    opts?.category?.forEach((c) => params.append('category', c));
    const qs = params.toString();
    const res = await fetch(
      `${this.apiBase}/notifications${qs ? `?${qs}` : ''}`,
      { headers: this.headers() },
    );
    if (!res.ok)
      throw new Error(`Failed to list notifications: ${res.statusText}`);
    const result = (await res.json()) as {
      success: boolean;
      data?: Notification[];
      error?: string;
    };
    if (!result.success) {
      throw new Error(apiErrorMessage(result, 'Failed to list notifications'));
    }
    return result.data ?? [];
  }

  async schedule(opts: ScheduleNotificationOpts): Promise<Notification> {
    const res = await fetch(`${this.apiBase}/notifications`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(opts),
    });
    if (!res.ok)
      throw new Error(`Failed to schedule notification: ${res.statusText}`);
    const result = (await res.json()) as {
      success: boolean;
      data?: Notification;
      error?: string;
    };
    if (!result.success || !result.data) {
      throw new Error(
        apiErrorMessage(result, 'Failed to schedule notification'),
      );
    }
    return result.data;
  }

  async dismiss(id: string): Promise<void> {
    const res = await fetch(`${this.apiBase}/notifications/${id}`, {
      method: 'DELETE',
      headers: this.headers(),
    });
    if (!res.ok)
      throw new Error(`Failed to dismiss notification: ${res.statusText}`);
  }

  async action(id: string, actionId: string): Promise<void> {
    const res = await fetch(
      `${this.apiBase}/notifications/${id}/action/${actionId}`,
      {
        method: 'POST',
        headers: this.headers(),
      },
    );
    if (!res.ok)
      throw new Error(
        `Failed to execute notification action: ${res.statusText}`,
      );
  }

  async snooze(id: string, until: string): Promise<void> {
    const res = await fetch(`${this.apiBase}/notifications/${id}/snooze`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ until }),
    });
    if (!res.ok)
      throw new Error(`Failed to snooze notification: ${res.statusText}`);
  }

  async clearAll(): Promise<void> {
    const res = await fetch(`${this.apiBase}/notifications`, {
      method: 'DELETE',
      headers: this.headers(),
    });
    if (!res.ok)
      throw new Error(`Failed to clear notifications: ${res.statusText}`);
  }

  async clearActivity(): Promise<void> {
    const res = await fetch(`${this.apiBase}/notifications/activity`, {
      method: 'DELETE',
      headers: this.headers(),
    });
    if (!res.ok)
      throw new Error(
        `Failed to clear notification activity: ${res.statusText}`,
      );
  }
}
