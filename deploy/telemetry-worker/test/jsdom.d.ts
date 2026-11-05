// The repository installs jsdom without its type package; this is the
// surface the page tests use.
declare module 'jsdom' {
  export class JSDOM {
    constructor(html: string, options?: Record<string, unknown>);
    readonly window: Window & typeof globalThis;
  }
}
