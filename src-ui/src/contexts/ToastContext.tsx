import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
} from 'react';

// Provider CLIs (e.g. Codex) emit colorized stderr; piped verbatim into a toast
// the ANSI escape sequences render as literal `[31m…` garbage. Strip all CSI
// sequences so error text is human-readable.
// Build the CSI matcher from the ESC code point so no raw control char
// lives in source (and no lint suppression is needed).
const ANSI_CSI_PATTERN = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`,
  'g',
);

export function stripAnsi(input: string): string {
  return input.replace(ANSI_CSI_PATTERN, '');
}

type ToastAction = {
  label: string;
  onClick: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
};

type Toast = {
  id: string;
  message: string;
  sessionId?: string;
  duration?: number;
// 'pairing-request' (archive#1982): NotificationContainer.tsx already
// renders a dedicated Allow/Deny card for this variant — grouped into the
// persistent approval queue alongside 'tool-approval', never the ephemeral
// toast stack — and routes both actions through the same
// `/api/notifications/:id/action/:actionId` handler `handleAction` already
// calls. No producer constructs one yet (nothing calls `show` with this
// type), so it is currently unreachable at runtime; it belongs in this
// union regardless, because the rendering code already switches on it and
// a real device-pairing notification producer is meant to opt into this
// exact shape next, not invent a second one.
  type?: 'info' | 'tool-approval' | 'tool-activity' | 'pairing-request';
  toolName?: string;
  agentName?: string;
  conversationTitle?: string;
  actions?: ToastAction[];
  onNavigate?: () => void;
/** Opaque metadata from server-side notifications (e.g. navigateTo for cross-project routing) */
  metadata?: Record<string, unknown>;
};

class ToastStore {
  private toasts: Toast[] = [];
  private history: (Toast & { timestamp: number; dismissed: boolean })[] = [];
  private listeners = new Set<() => void>();
  private historyListeners = new Set<() => void>();
  private snapshot = this.toasts;
  private historySnapshot = this.history;
  private timeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private maxHistory = 100; // Keep last 100 notifications

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  subscribeHistory = (listener: () => void) => {
    this.historyListeners.add(listener);
    return () => this.historyListeners.delete(listener);
  };

  getSnapshot = () => {
    return this.snapshot;
  };

  getHistorySnapshot = () => {
    return this.historySnapshot;
  };

  private notify = () => {
    this.snapshot = [...this.toasts];
    this.listeners.forEach((listener) => listener());
  };

  private notifyHistory = () => {
    this.historySnapshot = [...this.history];
    this.historyListeners.forEach((listener) => listener());
  };

  show(
    message: string,
    sessionId?: string,
    duration = 5000,
    actions?: ToastAction[],
    metadata?: Record<string, unknown>,
  ) {
    const clean = stripAnsi(message);

// Collapse rapid duplicates (a provider error retried in a loop would
// otherwise stack identical toasts until they cover the viewport). Refresh
// the existing toast's auto-dismiss timer instead of adding another copy.
    const existing = this.toasts.find(
      (t) =>
        t.type === 'info' && t.message === clean && t.sessionId === sessionId,
    );
    if (existing) {
      const prevTimeout = this.timeouts.get(existing.id);
      if (prevTimeout) clearTimeout(prevTimeout);
      if (duration > 0) {
        this.timeouts.set(
          existing.id,
          setTimeout(() => this.dismiss(existing.id), duration),
        );
      }
      return existing.id;
    }

    const id = `${Date.now()}-${Math.random()}`;
    const toast: Toast = {
      id,
      message: clean,
      sessionId,
      duration,
      type: 'info',
      actions,
      metadata,
    };

    this.toasts.push(toast);
    this.history.unshift({ ...toast, timestamp: Date.now(), dismissed: false });

// Keep history size limited
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(0, this.maxHistory);
    }

    this.notify();
    this.notifyHistory();

 // archive#4512 — `duration > 0` guards this the same way
// the existing-toast refresh path above already does. Before this fix,
// `duration: 0` (the "sticky, no auto-dismiss" contract `showToolApproval`
// below establishes by never scheduling a timeout at all) instead
// scheduled `setTimeout(dismiss, 0)` here — a toast asking for NO
// auto-dismiss dismissed itself on the very next macrotask, faster than
// the 5-second default it was meant to opt out of.
    if (duration > 0) {
      const timeout = setTimeout(() => {
        this.dismiss(id);
      }, duration);
      this.timeouts.set(id, timeout);
    }

    return id;
  }

  showToolApproval(options: {
    sessionId: string;
    toolName: string;
    server?: string;
    tool?: string;
    agentName: string;
    conversationTitle?: string;
    actions: ToastAction[];
    onNavigate?: () => void;
  }) {
    const id = `approval-${Date.now()}-${Math.random()}`;

// Format tool display: [server] tool or just toolName
    const toolDisplay =
      options.server && options.tool
        ? `[${options.server}] ${options.tool}`
        : options.toolName;

    const conversationInfo = options.conversationTitle || 'Conversation';

    const toast: Toast = {
      id,
      message: `${options.agentName} wants to use ${toolDisplay}`,
      sessionId: options.sessionId,
      type: 'tool-approval',
      toolName: toolDisplay,
      agentName: options.agentName,
      conversationTitle: conversationInfo,
      actions: options.actions,
      onNavigate: options.onNavigate,
      duration: 0, // No auto-dismiss for approvals
    };

    this.toasts.push(toast);
    this.history.unshift({ ...toast, timestamp: Date.now(), dismissed: false });

    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(0, this.maxHistory);
    }

    this.notify();
    this.notifyHistory();

    return id;
  }

  showToolActivity(options: {
    sessionId: string;
    toolName: string;
    agentName: string;
    conversationTitle?: string;
    detail?: string;
    status: 'completed' | 'cancelled' | 'error';
    onNavigate?: () => void;
    duration?: number;
  }) {
    const id = `tool-${Date.now()}-${Math.random()}`;
    const verb =
      options.status === 'error'
        ? 'failed'
        : options.status === 'cancelled'
          ? 'cancelled'
          : 'finished';

    const toast: Toast = {
      id,
      message: `${options.agentName} ${verb} ${options.toolName}`,
      sessionId: options.sessionId,
      type: 'tool-activity',
      toolName: options.toolName,
      agentName: options.agentName,
      conversationTitle: options.conversationTitle,
      onNavigate: options.onNavigate,
      duration:
        options.duration ??
        (options.status === 'error'
          ? 9000
          : options.status === 'cancelled'
            ? 7000
            : 6000),
      metadata: options.detail ? { detail: options.detail } : undefined,
    };

    this.toasts.push(toast);
    this.history.unshift({ ...toast, timestamp: Date.now(), dismissed: false });

    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(0, this.maxHistory);
    }

    this.notify();
    this.notifyHistory();

    if (toast.duration && toast.duration > 0) {
      const timeout = setTimeout(() => {
        this.dismiss(id);
      }, toast.duration);
      this.timeouts.set(id, timeout);
    }

    return id;
  }

  dismiss(id: string) {
    const timeout = this.timeouts.get(id);
    if (timeout) {
      clearTimeout(timeout);
      this.timeouts.delete(id);
    }

// Mark as dismissed in history
    const historyItem = this.history.find((h) => h.id === id);
    if (historyItem) {
      historyItem.dismissed = true;
      this.notifyHistory();
    }

    this.toasts = this.toasts.filter((t) => t.id !== id);
    this.notify();
  }

  clear() {
    this.timeouts.forEach((timeout) => clearTimeout(timeout));
    this.timeouts.clear();
    this.toasts = [];
    this.notify();
  }

// Dismiss every currently-visible notification at once. The container renders
// from history (filtered by `dismissed`), so clearing live toasts alone is not
// enough — mark the active history entries dismissed too.
  dismissAll() {
    this.timeouts.forEach((timeout) => clearTimeout(timeout));
    this.timeouts.clear();
    this.toasts = [];
    for (const item of this.history) {
      if (!item.dismissed) item.dismissed = true;
    }
    this.notify();
    this.notifyHistory();
  }

  clearHistory() {
    this.history = [];
    this.notifyHistory();
  }
}

export const toastStore = new ToastStore();

const ToastContext = createContext<{
  showToast: (
    message: string,
    sessionId?: string,
    duration?: number,
    actions?: ToastAction[],
  ) => string;
  showToolApproval: (options: {
    sessionId: string;
    toolName: string;
    server?: string;
    tool?: string;
    agentName: string;
    conversationTitle?: string;
    actions: ToastAction[];
    onNavigate?: () => void;
  }) => string;
  showToolActivity: (options: {
    sessionId: string;
    toolName: string;
    agentName: string;
    conversationTitle?: string;
    detail?: string;
    status: 'completed' | 'cancelled' | 'error';
    onNavigate?: () => void;
    duration?: number;
  }) => string;
  dismissToast: (id: string) => void;
  dismissAllToasts: () => void;
  clearToasts: () => void;
  clearHistory: () => void;
} | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const showToast = useCallback(
    (
      message: string,
      sessionId?: string,
      duration?: number,
      actions?: ToastAction[],
    ) => {
      return toastStore.show(message, sessionId, duration, actions);
    },
    [],
  );

  const showToolApproval = useCallback(
    (options: {
      sessionId: string;
      toolName: string;
      server?: string;
      tool?: string;
      agentName: string;
      conversationTitle?: string;
      actions: ToastAction[];
      onNavigate?: () => void;
    }) => {
      return toastStore.showToolApproval(options);
    },
    [],
  );

  const showToolActivity = useCallback(
    (options: {
      sessionId: string;
      toolName: string;
      agentName: string;
      conversationTitle?: string;
      detail?: string;
      status: 'completed' | 'cancelled' | 'error';
      onNavigate?: () => void;
      duration?: number;
    }) => {
      return toastStore.showToolActivity(options);
    },
    [],
  );

  const dismissToast = useCallback((id: string) => {
    toastStore.dismiss(id);
  }, []);

  const dismissAllToasts = useCallback(() => {
    toastStore.dismissAll();
  }, []);

  const clearToasts = useCallback(() => {
    toastStore.clear();
  }, []);

  const clearHistory = useCallback(() => {
    toastStore.clearHistory();
  }, []);

// archive#3796: one memoised value per provider — a fresh object literal
// here republishes the context to every consumer on any render of this
// provider, whatever the render was actually about.
  const value = useMemo(
    () => ({
      showToast,
      showToolApproval,
      showToolActivity,
      dismissToast,
      dismissAllToasts,
      clearToasts,
      clearHistory,
    }),
    [
      showToast,
      showToolApproval,
      showToolActivity,
      dismissToast,
      dismissAllToasts,
      clearToasts,
      clearHistory,
    ],
  );

  return (
    <ToastContext.Provider value={value}>{children}</ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within ToastProvider');
  }
  return context;
}

export function useNotificationHistory() {
  return useSyncExternalStore(
    toastStore.subscribeHistory,
    toastStore.getHistorySnapshot,
  );
}
