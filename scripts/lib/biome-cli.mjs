import { createRequire } from 'node:module';

const rootRequire = createRequire(import.meta.url);
const require = createRequire(
  rootRequire.resolve('@biomejs/biome/package.json'),
);

// Resolve the lockfile-installed native executable and cap its worker pool.
export function biomeCommand(environment = process.env) {
  const threads = Number(environment.BIOME_THREADS ?? 2);
  if (!Number.isSafeInteger(threads) || threads < 1)
    throw new Error('BIOME_THREADS must be a positive integer.');
  const env = { ...environment, BIOME_THREADS: String(Math.min(threads, 2)) };
  const musl =
    process.platform === 'linux' &&
    !process.report.getReport().header.glibcVersionRuntime;
  const platform = musl ? 'linux' : process.platform;
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const binary =
    environment.BIOME_BINARY ||
    require.resolve(
      `@biomejs/cli-${platform}-${process.arch}${musl ? '-musl' : ''}/biome${suffix}`,
    );
  return { binary, env };
}
