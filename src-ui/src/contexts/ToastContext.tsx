import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
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
  onClick: () => unknown;
  variant?: 'primary' | 'secondary' | 'danger';
};

type ToastTone = 'info' | 'success' | 'warning' | 'error';

type Toast = {
  id: string;
  stationScope?: string;
  dedupeKey?: string;
  recallText?: string;
  occurrences?: number;
  pendingAction?: number;
  actionError?: string;
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
  type?:
    | ToastTone
    | 'tool-approval'
    | 'tool-activity'
    | 'turn-activity'
    | 'pairing-request';
  toolName?: string;
  /**
   * #1545: a bounded, single-line, redacted preview naming which command, or
   * which file, the tool call will touch — derived by
   * `@kontourai/station-shared/tool-request-preview`, never composed here. The
   * tool name alone cannot tell an operator whether they are approving
   * `git status` or `rm -rf /`. It is not the whole call: for a write it names
   * the file and never the content (see that module's docblock).
   */
  toolPreview?: string;
  /**
   * A 'tool-approval' toast's own request: `sessionId` is the request's
   * thread, this is its `requestId`. The toast is dismissed by this identity
   * (`dismissApprovalRequest`), never only through a chat's side map — a map
   * that a conversation switch, a handoff or a closed tab resets or removes
   * left the toast, and the header "Approval needed" count, outliving its
   * request.
   */
  approvalRequestId?: string;
  agentName?: string;
  conversationTitle?: string;
  actions?: ToastAction[];
  onNavigate?: () => void;
  /** Opaque metadata from server-side notifications (e.g. navigateTo for cross-project routing) */
  metadata?: Record<string, unknown>;
};

export type ToastOptions = {
  id?: string;
  stationScope?: string;
  dedupeKey?: string;
  message: string;
  tone?: ToastTone;
  duration?: number;
  sessionId?: string;
  actions?: ToastAction[];
  detail?: string;
  /** Explicitly safe text for recall; never pass raw diagnostics or credentials. */
  recallText?: string;
};

type Expiration = {
  remaining: number;
  started?: number;
  visible: boolean;
  paused: Set<string>;
};
const RECALL_KEY = 'station:toast-recall:v1:';
const RECALL_LIMIT = 50;
const RECALL_AGE = 7 * 24 * 60 * 60 * 1000;
const ordinary = (toast: Toast) =>
  ['info', 'success', 'warning', 'error'].includes(toast.type ?? 'info');

class ToastStore {
  private toasts: Toast[] = [];
  private history: (Toast & { timestamp: number; dismissed: boolean })[] = [];
  private listeners = new Set<() => void>();
  private historyListeners = new Set<() => void>();
  private snapshot = this.toasts;
  private historySnapshot = this.history;
  private timeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private maxHistory = 100;
  private expirations = new Map<string, Expiration>();
  private stationScope =
    typeof location === 'undefined' ? 'local' : location.origin;
  private hidden = typeof document !== 'undefined' && document.hidden;

  constructor() {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        this.hidden = document.hidden;
        for (const id of this.expirations.keys()) this.schedule(id);
      });
    }
    this.loadRecall();
    this.historySnapshot = [...this.history];
  }

  isCurrentScope(scope?: string) {
    return scope === undefined || scope === this.stationScope;
  }

  bindScope(scope: string) {
    if (scope === this.stationScope) return;
    this.clear();
    this.history = [];
    this.stationScope = scope;
    this.loadRecall();
    this.notifyHistory();
  }

  private loadRecall() {
    try {
      const raw: unknown = JSON.parse(
        localStorage.getItem(RECALL_KEY + this.stationScope) ?? '[]',
      );
      if (!Array.isArray(raw)) return;
      this.history = raw.slice(0, RECALL_LIMIT).flatMap((item) => {
        if (
          !item ||
          typeof item !== 'object' ||
          typeof item.message !== 'string' ||
          typeof item.id !== 'string' ||
          typeof item.timestamp !== 'number' ||
          !Number.isFinite(item.timestamp) ||
          item.timestamp < Date.now() - RECALL_AGE ||
          item.timestamp > Date.now() ||
          !['info', 'success', 'warning', 'error'].includes(item.type)
        )
          return [];
        return [
          {
            id: item.id.slice(0, 160),
            message: item.message.slice(0, 500),
            recallText: item.message.slice(0, 500),
            timestamp: item.timestamp,
            type: item.type as ToastTone,
            stationScope: this.stationScope,
            dismissed: true,
          },
        ];
      });
    } catch {
      /* Storage can be unavailable or contain invalid data. */
    }
  }

  private persistRecall() {
    try {
      const entries = this.history
        .filter(
          (item) =>
            ordinary(item) &&
            item.recallText &&
            item.timestamp >= Date.now() - RECALL_AGE,
        )
        .slice(0, RECALL_LIMIT);
      const key = RECALL_KEY + this.stationScope;
      if (entries.length === 0 && localStorage.getItem(key) === null) return;
      localStorage.setItem(
        key,
        JSON.stringify(
          entries.map((item) => ({
            id: item.id.slice(0, 160),
            message: item.recallText!.slice(0, 500),
            type: item.type ?? 'info',
            timestamp: item.timestamp,
          })),
        ),
      );
    } catch {
      /* Recall is optional when storage is full or disabled. */
    }
  }

  private schedule(id: string) {
    const timer = this.timeouts.get(id);
    if (timer) clearTimeout(timer);
    this.timeouts.delete(id);
    const expiration = this.expirations.get(id);
    if (!expiration) return;
    if (expiration.started !== undefined) {
      expiration.remaining = Math.max(
        0,
        expiration.remaining - (Date.now() - expiration.started),
      );
      expiration.started = undefined;
    }
    if (
      !expiration.visible ||
      expiration.paused.size ||
      this.hidden ||
      !Number.isFinite(expiration.remaining)
    )
      return;
    expiration.started = Date.now();
    this.timeouts.set(
      id,
      setTimeout(() => this.dismiss(id), expiration.remaining),
    );
  }

  private resetExpiration(toast: Toast) {
    const previous = this.expirations.get(toast.id);
    const timer = this.timeouts.get(toast.id);
    if (timer) clearTimeout(timer);
    this.timeouts.delete(toast.id);
    this.expirations.delete(toast.id);
    const paused = new Set(previous?.paused);
    paused.delete('action');
    this.expirations.set(toast.id, {
      remaining:
        !toast.duration || toast.duration <= 0
          ? Infinity
          : toast.actions?.length ||
              toast.onNavigate ||
              toast.metadata?.navigateTo
            ? Math.max(12000, toast.duration)
            : toast.duration,
      visible: previous?.visible ?? false,
      paused,
    });
    this.schedule(toast.id);
  }

  setVisible(id: string, visible: boolean) {
    const expiration = this.expirations.get(id);
    if (!expiration || expiration.visible === visible) return;
    expiration.visible = visible;
    this.schedule(id);
  }

  pause(id: string, reason: string, paused: boolean) {
    const expiration = this.expirations.get(id);
    if (!expiration) return;
    if (paused) expiration.paused.add(reason);
    else expiration.paused.delete(reason);
    this.schedule(id);
  }

  upsert(options: ToastOptions) {
    const scope = options.stationScope ?? this.stationScope;
    if (scope !== this.stationScope) return options.id ?? '';
    const existing = this.toasts.find(
      (item) =>
        ordinary(item) &&
        (options.id
          ? item.id === options.id
          : options.dedupeKey &&
            item.dedupeKey === options.dedupeKey &&
            item.sessionId === options.sessionId),
    );
    const id = existing?.id ?? options.id ?? crypto.randomUUID();
    const toast: Toast = {
      id,
      stationScope: scope,
      dedupeKey: options.dedupeKey,
      message: stripAnsi(options.message),
      type: options.tone ?? 'info',
      sessionId: options.sessionId,
      duration: options.duration ?? 5000,
      actions: options.actions,
      metadata: options.detail
        ? { detail: stripAnsi(options.detail) }
        : undefined,
      recallText: options.recallText
        ? stripAnsi(options.recallText).slice(0, 500)
        : undefined,
      occurrences: existing
        ? (existing.occurrences ?? 1) +
          (!options.id && options.dedupeKey ? 1 : 0)
        : 1,
    };
    if (existing) {
      this.toasts = this.toasts.map((item) =>
        item === existing ? toast : item,
      );
      this.history = this.history.map((item) =>
        item.id === id
          ? { ...toast, timestamp: item.timestamp, dismissed: false }
          : item,
      );
    } else {
      this.toasts.push(toast);
      this.history = this.history.filter((item) => item.id !== id);
      this.history.unshift({
        ...toast,
        timestamp: Date.now(),
        dismissed: false,
      });
    }
    this.resetExpiration(toast);
    const transients = this.toasts.filter(
      (item) =>
        item.type !== 'tool-approval' && item.type !== 'pairing-request',
    );
    for (const item of transients.slice(
      0,
      Math.max(0, transients.length - this.maxHistory),
    ))
      this.dismiss(item.id);
    this.notify();
    this.notifyHistory();
    return id;
  }

  update(id: string, patch: Partial<Omit<ToastOptions, 'id'>>) {
    const toast = this.toasts.find((item) => item.id === id && ordinary(item));
    if (
      !toast ||
      (patch.stationScope && patch.stationScope !== this.stationScope)
    )
      return;
    this.upsert({
      id,
      stationScope: toast.stationScope,
      message: toast.message,
      tone: toast.type as ToastTone,
      duration: toast.duration,
      actions: toast.actions,
      dedupeKey: toast.dedupeKey,
      sessionId: toast.sessionId,
      detail:
        typeof toast.metadata?.detail === 'string'
          ? toast.metadata.detail
          : undefined,
      recallText: toast.recallText,
      ...patch,
    });
  }

  runAction(id: string, index: number) {
    const toast = this.toasts.find((item) => item.id === id);
    const action = toast?.actions?.[index];
    if (
      !toast ||
      !action ||
      toast.pendingAction !== undefined ||
      (toast.stationScope && toast.stationScope !== this.stationScope)
    )
      return;
    const publish = () => {
      this.history = this.history.map((item) =>
        item.id === id ? { ...item, ...toast } : item,
      );
      this.notify();
      this.notifyHistory();
    };
    const fail = () => {
      if (!this.toasts.includes(toast)) return;
      toast.pendingAction = undefined;
      toast.actionError = 'Action failed. Try again.';
      toast.duration = 0;
      this.resetExpiration(toast);
      publish();
    };
    try {
      const result = action.onClick();
      if (!this.toasts.includes(toast)) {
        if (result) void Promise.resolve(result).catch(() => undefined);
        return;
      }
      if (
        result instanceof Promise ||
        (typeof result === 'object' &&
          result !== null &&
          'then' in result &&
          typeof result.then === 'function')
      ) {
        toast.pendingAction = index;
        toast.actionError = undefined;
        this.pause(id, 'action', true);
        publish();
        void Promise.resolve(result).then(() => {
          if (this.toasts.includes(toast)) this.dismiss(id);
        }, fail);
      } else if (this.toasts.includes(toast)) this.dismiss(id);
    } catch {
      fail();
    }
  }

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
    // Active approvals cannot be evicted by transient traffic.
    const active = this.history.filter((item) => !item.dismissed);
    const recent = this.history
      .filter((item) => item.dismissed)
      .slice(0, this.maxHistory);
    this.history = [...active, ...recent].sort(
      (a, b) => b.timestamp - a.timestamp,
    );
    this.persistRecall();
    this.historySnapshot = [...this.history];
    this.historyListeners.forEach((listener) => listener());
  };

  show(
    message: string,
    sessionId?: string,
    duration = 5000,
    actions?: ToastAction[],
    metadata?: Record<string, unknown>,
    tone: ToastTone = 'info',
  ) {
    const clean = stripAnsi(message);
    const existing = actions?.length
      ? undefined
      : this.toasts.find(
          (toast) =>
            ordinary(toast) &&
            !toast.actions?.length &&
            toast.type === tone &&
            toast.message === clean &&
            toast.sessionId === sessionId,
        );
    const id = this.upsert({
      id: existing?.id,
      message: clean,
      sessionId,
      duration,
      actions,
      tone,
    });
    if (metadata) {
      const toast = this.toasts.find((item) => item.id === id);
      if (toast) {
        toast.metadata = metadata;
        this.history = this.history.map((item) =>
          item.id === id ? { ...item, metadata } : item,
        );
        this.resetExpiration(toast);
        this.notify();
        this.notifyHistory();
      }
    }
    return id;
  }

  showToolApproval(options: {
    sessionId: string;
    /** See `Toast.approvalRequestId`. */
    requestId?: string;
    toolName: string;
    /** See `Toast.toolPreview`. */
    toolPreview?: string;
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
      stationScope: this.stationScope,
      message: `${options.agentName} wants to use ${toolDisplay}`,
      sessionId: options.sessionId,
      type: 'tool-approval',
      ...(options.requestId ? { approvalRequestId: options.requestId } : {}),
      toolName: toolDisplay,
      ...(options.toolPreview ? { toolPreview: options.toolPreview } : {}),
      agentName: options.agentName,
      conversationTitle: conversationInfo,
      actions: options.actions,
      onNavigate: options.onNavigate,
      duration: 0, // No auto-dismiss for approvals
    };

    this.toasts.push(toast);
    this.history.unshift({ ...toast, timestamp: Date.now(), dismissed: false });

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
    status: 'completed' | 'cancelled' | 'error' | 'unresolved';
    onNavigate?: () => void;
    duration?: number;
  }) {
    const id = `tool-${Date.now()}-${Math.random()}`;
    const verb =
      options.status === 'error'
        ? 'failed'
        : options.status === 'cancelled'
          ? 'cancelled'
          : // station#1558: the session ended with this call still open, so
            // there is no outcome to name. "reported no result for" says
            // exactly what happened — it does not claim the tool failed, and
            // it does not claim it finished.
            options.status === 'unresolved'
            ? 'reported no result for'
            : 'finished';

    const toast: Toast = {
      id,
      stationScope: this.stationScope,
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
          : options.status === 'cancelled' || options.status === 'unresolved'
            ? 7000
            : 6000),
      metadata: options.detail ? { detail: options.detail } : undefined,
    };

    this.toasts.push(toast);
    this.history.unshift({ ...toast, timestamp: Date.now(), dismissed: false });

    this.resetExpiration(toast);
    this.notify();
    this.notifyHistory();

    return id;
  }

  /**
   * A background chat's turn ended and it needs its user: finished, failed,
   * stopped, or replied on its own. Composed by `turnAttentionNotifications`;
   * this only stores and times it. `Open` and the conversation link both run
   * `onNavigate`.
   */
  showTurnActivity(options: {
    sessionId: string;
    message: string;
    conversationTitle: string;
    detail?: string;
    /** A failure stays up longer, as a tool failure does. */
    failed: boolean;
    onNavigate: () => void;
  }) {
    const id = `turn-${Date.now()}-${Math.random()}`;
    const duration = options.failed ? 9000 : 7000;
    const toast: Toast = {
      id,
      stationScope: this.stationScope,
      message: stripAnsi(options.message),
      sessionId: options.sessionId,
      type: 'turn-activity',
      conversationTitle: options.conversationTitle,
      onNavigate: options.onNavigate,
      actions: [
        { label: 'Open', variant: 'primary', onClick: options.onNavigate },
      ],
      duration,
      metadata: options.detail ? { detail: options.detail } : undefined,
    };

    this.toasts.push(toast);
    this.history.unshift({ ...toast, timestamp: Date.now(), dismissed: false });
    this.resetExpiration(toast);
    this.notify();
    this.notifyHistory();
    return id;
  }

  dismiss(id: string) {
    this.expirations.delete(id);
    const timeout = this.timeouts.get(id);
    if (timeout) {
      clearTimeout(timeout);
      this.timeouts.delete(id);
    }

    // Mark as dismissed in history
    const historyItem = this.history.find((h) => h.id === id);
    if (historyItem) {
      historyItem.dismissed = true;
      historyItem.actions = undefined;
      historyItem.onNavigate = undefined;
      historyItem.metadata = undefined;
      this.notifyHistory();
    }

    this.toasts = this.toasts.filter((t) => t.id !== id);
    this.notify();
  }

  /**
   * Dismiss every approval toast for one request, by the request's identity.
   * Idempotent, and independent of any chat's state: a request settles
   * whether or not the chat that first showed it is still open or still
   * bound to that thread.
   */
  dismissApprovalRequest(threadId: string, requestId: string) {
    for (const item of this.history) {
      if (
        item.type === 'tool-approval' &&
        !item.dismissed &&
        item.sessionId === threadId &&
        item.approvalRequestId === requestId
      )
        this.dismiss(item.id);
    }
  }

  clear() {
    this.timeouts.forEach((timeout) => clearTimeout(timeout));
    this.timeouts.clear();
    this.expirations.clear();
    this.toasts = [];
    this.notify();
  }

  // Dismiss every currently-visible notification at once. The container renders
  // from history (filtered by `dismissed`), so clearing live toasts alone is not
  // enough — mark the active history entries dismissed too.
  dismissAll() {
    this.timeouts.forEach((timeout) => clearTimeout(timeout));
    this.timeouts.clear();
    this.expirations.clear();
    this.toasts = [];
    for (const item of this.history) {
      if (!item.dismissed) item.dismissed = true;
      item.actions = undefined;
      item.onNavigate = undefined;
      item.metadata = undefined;
    }
    this.notify();
    this.notifyHistory();
  }

  clearRecentMessages() {
    this.history = this.history.filter((item) => !ordinary(item));
    for (const toast of [...this.toasts])
      if (ordinary(toast)) this.dismiss(toast.id);
    this.notifyHistory();
  }

  clearHistory() {
    this.history = [];
    this.notifyHistory();
  }
}

export const toastStore = new ToastStore();

const ToastContext = createContext<{
  upsertToast: (options: ToastOptions) => string;
  updateToast: (id: string, patch: Partial<Omit<ToastOptions, 'id'>>) => void;
  showToast: (
    message: string,
    sessionId?: string,
    duration?: number,
    actions?: ToastAction[],
    tone?: ToastTone,
  ) => string;
  showToolApproval: (options: {
    sessionId: string;
    toolName: string;
    /** See `Toast.toolPreview`. */
    toolPreview?: string;
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
    status: 'completed' | 'cancelled' | 'error' | 'unresolved';
    onNavigate?: () => void;
    duration?: number;
  }) => string;
  dismissToast: (id: string) => void;
  dismissAllToasts: () => void;
  clearToasts: () => void;
  clearHistory: () => void;
} | null>(null);

export function ToastProvider({
  children,
  stationScope = typeof location === 'undefined' ? 'local' : location.origin,
}: {
  children: ReactNode;
  stationScope?: string;
}) {
  useLayoutEffect(() => {
    toastStore.bindScope(stationScope);
  }, [stationScope]);
  const upsertToast = useCallback(
    (options: ToastOptions) =>
      toastStore.upsert({
        ...options,
        stationScope: options.stationScope ?? stationScope,
      }),
    [stationScope],
  );
  const updateToast = useCallback(
    (id: string, patch: Partial<Omit<ToastOptions, 'id'>>) =>
      toastStore.update(id, {
        ...patch,
        stationScope: patch.stationScope ?? stationScope,
      }),
    [stationScope],
  );
  const showToast = useCallback(
    (
      message: string,
      sessionId?: string,
      duration?: number,
      actions?: ToastAction[],
      tone: ToastTone = 'info',
    ) => {
      if (!toastStore.isCurrentScope(stationScope)) return '';
      return toastStore.show(
        message,
        sessionId,
        duration,
        actions,
        undefined,
        tone,
      );
    },
    [stationScope],
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
      if (!toastStore.isCurrentScope(stationScope)) return '';
      return toastStore.showToolApproval(options);
    },
    [stationScope],
  );

  const showToolActivity = useCallback(
    (options: {
      sessionId: string;
      toolName: string;
      agentName: string;
      conversationTitle?: string;
      detail?: string;
      status: 'completed' | 'cancelled' | 'error' | 'unresolved';
      onNavigate?: () => void;
      duration?: number;
    }) => {
      if (!toastStore.isCurrentScope(stationScope)) return '';
      return toastStore.showToolActivity(options);
    },
    [stationScope],
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
      upsertToast,
      updateToast,
      showToast,
      showToolApproval,
      showToolActivity,
      dismissToast,
      dismissAllToasts,
      clearToasts,
      clearHistory,
    }),
    [
      upsertToast,
      updateToast,
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
