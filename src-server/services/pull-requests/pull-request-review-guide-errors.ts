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
    'The model returned invalid guide output or excerpts. Rewrite with a model that supports structured output.',
  'stored-too-large':
    'The serialized guide exceeds the storage limit. Use a shorter guide.',
  timeout: 'Guide generation exceeded its time budget.',
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
export function reviewGuideFailureDetail(error: unknown): string {
  return error instanceof ReviewGuideError ? error.detail : DETAILS.model;
}
