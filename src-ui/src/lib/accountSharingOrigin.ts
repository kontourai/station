export function isLoopbackOrigin(origin: string): boolean {
  const host = new URL(origin).hostname;
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '[::1]' ||
    /^127\./.test(host)
  );
}
