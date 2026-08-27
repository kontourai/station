const REMOTE_AUTH_PROTOCOL_VERSION = 1;

export interface WebSocketCredentialResolver {
  getCredential(): string | undefined;
  getProtocolVersion(): number | undefined;
}

export function isRemoteEndpoint(apiBase: string, pageHref: string): boolean {
  const hostname = new URL(apiBase || '/', pageHref).hostname
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  return !(
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1'
  );
}

export function websocketCloseError(code: number): string {
  if (code === 4401) return 'Station credential required or expired';
  if (code === 4429) return 'Too many authentication attempts; try again later';
  return `Connection lost (code ${code})`;
}

/** Gates all business frames behind Station's first-frame authentication. */
export class BrowserWebSocketAuthGate {
  private authenticated: boolean;
  private awaitingAcknowledgement = false;

  constructor(
    private readonly remote: boolean,
    private readonly credentials: WebSocketCredentialResolver,
    private readonly onAuthenticated: () => void,
    private readonly onError: (message: string) => void,
  ) {
    this.authenticated = !remote;
  }

  open(socket: Pick<WebSocket, 'send'>): void {
    if (!this.remote) {
      this.onAuthenticated();
      return;
    }
    const credential = this.credentials.getCredential();
    if (!credential) {
      this.onError('Station credential required');
      return;
    }
    const protocolVersion =
      this.credentials.getProtocolVersion() ?? REMOTE_AUTH_PROTOCOL_VERSION;
    this.awaitingAcknowledgement = true;
    socket.send(JSON.stringify({ type: 'auth', protocolVersion, credential }));
  }

  /** Returns true when a pre-authentication frame was consumed. */
  consume(raw: string): boolean {
    if (!this.remote || this.authenticated) return false;
    if (!this.awaitingAcknowledgement) return true;

    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      this.onError('Invalid authentication response');
      return true;
    }
    if (
      typeof message === 'object' &&
      message !== null &&
      (message as Record<string, unknown>).type === 'authenticated' &&
      (message as Record<string, unknown>).protocolVersion ===
        (this.credentials.getProtocolVersion() ?? REMOTE_AUTH_PROTOCOL_VERSION)
    ) {
      this.authenticated = true;
      this.awaitingAcknowledgement = false;
      this.onAuthenticated();
    } else {
      this.onError('Station credential was rejected');
    }
    return true;
  }

  canSendBusinessData(): boolean {
    return this.authenticated;
  }
}
