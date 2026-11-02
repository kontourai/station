export class TaskBrowserRecordingError extends Error {
  readonly response: { code: string; error: string };
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TaskBrowserRecordingError';
    this.response = { code, error: message };
  }
}
