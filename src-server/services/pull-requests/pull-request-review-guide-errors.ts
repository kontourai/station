const DETAILS = {
  disabled:
    'Enable review guides and configure a review guide or structure model.',
  access: 'Station access changed. The guide was not saved.',
  capacity:
    'Two review guides are already running. Try again when one finishes.',
  'older-revision':
    'A guide is running for an older revision. Wait for it to finish, then request the current head.',
  revisions: 'Exact local head and base commits are required.',
  'missing-commits':
    'The head or base commit is missing locally. Fetch the pull request commits, then retry.',
  'diff-too-large': 'The change exceeds the guide diff or changed-file limit.',
  'git-timeout':
    'Reading the local Git change timed out. Try again when the server is less busy.',
  'git-read': 'The local Git change could not be read safely.',
  'invalid-output':
    'The model returned guide output that did not match the bounded schema or the diff. Rewrite the guide.',
  'excerpt-too-long':
    'The model returned an excerpt exceeding 25 lines. Rewrite the guide using shorter excerpts.',
  'stored-too-large':
    'The serialized guide exceeds the storage limit. Use a shorter guide.',
  timeout: 'Guide generation exceeded its time budget.',
  read: 'The saved guide could not be read. Check server storage or rewrite the guide.',
  request:
    'The guide request could not be completed. Check server configuration and retry.',
  model:
    'The guide model could not complete the request. Check model access and retry.',
} as const;
export class ReviewGuideError extends Error {
  readonly detail: string;
  constructor(readonly code: keyof typeof DETAILS) {
    super(DETAILS[code]);
    this.detail = DETAILS[code];
  }
}
/** Only fixed, reviewed copy crosses the route/model error boundary. */
export function reviewGuideFailureDetail(
  error: unknown,
  fallback: 'model' | 'read' | 'request' = 'model',
): string {
  return error instanceof ReviewGuideError ? error.detail : DETAILS[fallback];
}
