export class CodexRpcError extends Error {
  constructor(
    readonly code: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'CodexRpcError';
  }
}
