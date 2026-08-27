/**
 * Typed JSON-body test helper — reads a fetch-style Response body as JSON.
 *
 * The root tsconfig has no "DOM" lib (`lib: ["ES2022"]`), so `Response`
 * resolves to Node's/undici's fetch types, where `.json()` returns
 * `Promise<unknown>` rather than lib.dom's `Promise<any>`. Route tests
 * previously worked around this with 37 independently copy-pasted local
 * `async function json(res: Response) { return res.json(); }` helpers,
 * each implicitly relying on the pre-strict `unknown` being usable like
 * `any`. This shared helper keeps the exact same runtime behavior
 * (`return res.json()`, no parsing/validation change) and just gives the
 * result a caller-supplied type so `body.foo` accesses type-check without
 * per-file duplication.
 */
export async function readJson<T = any>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}
