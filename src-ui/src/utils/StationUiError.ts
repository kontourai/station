/** Curated application copy. Never construct this from a caught diagnostic. */
export class StationUiError extends Error {
  constructor(readonly userMessage: string) {
    super(userMessage);
    this.name = 'StationUiError';
  }
}
