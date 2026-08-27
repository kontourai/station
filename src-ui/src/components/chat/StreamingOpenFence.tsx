/**
 * station#3354 — an in-progress (unclosed-fence) streaming code block: the
 * same chrome as a closed block, always plain — never tokenized, never
 * cached. Loaded lazily from StreamingMarkdown so the shared
 * `CodeBlockFrame` chrome stays out of the entry chunk.
 */
import { CodeBlockFrame } from './CodeBlockFrame';

export default function StreamingOpenFence({
  code,
  lang,
}: {
  code: string;
  lang?: string;
}) {
  return (
    <CodeBlockFrame
      lang={lang ?? 'text'}
      code={code.replace(/\n$/, '')}
      html={null}
    />
  );
}
