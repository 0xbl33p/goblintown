/**
 * Debounced "thinking" relay for streaming creature responses to a UI.
 * - Accumulates token chunks.
 * - Flushes the cumulative text at most every `intervalMs` (default 120ms)
 *   OR once an additional `chunkBytes` of text has arrived since last flush.
 * - Always flushes once at the end via `done()`.
 */
export function makeThinkingRelay(
  emit: (text: string) => void,
  opts: { intervalMs?: number; chunkBytes?: number } = {},
): {
  onChunk: (delta: string) => void;
  done: () => void;
} {
  const intervalMs = opts.intervalMs ?? 120;
  const chunkBytes = opts.chunkBytes ?? 80;

  let cumulative = "";
  let lastFlushAt = 0;
  let lastFlushedLen = 0;
  let pending: NodeJS.Timeout | null = null;

  function flush(): void {
    if (cumulative.length === lastFlushedLen) return;
    lastFlushedLen = cumulative.length;
    lastFlushAt = Date.now();
    if (pending) {
      clearTimeout(pending);
      pending = null;
    }
    emit(cumulative);
  }

  function onChunk(delta: string): void {
    cumulative += delta;
    const sinceFlush = cumulative.length - lastFlushedLen;
    const elapsed = Date.now() - lastFlushAt;
    if (sinceFlush >= chunkBytes || elapsed >= intervalMs) {
      flush();
      return;
    }
    if (!pending) {
      pending = setTimeout(() => {
        pending = null;
        flush();
      }, intervalMs - elapsed);
    }
  }

  function done(): void {
    flush();
  }

  return { onChunk, done };
}
