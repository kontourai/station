// TypeScript 7 (TS2882) requires an explicit module declaration for
// side-effect imports of non-code assets. This package builds via `tsc`
// directly (no bundler-provided ambient types), so declare it here.
declare module '*.css';
