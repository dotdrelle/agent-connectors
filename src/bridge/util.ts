/** A network failure's code (ECONNREFUSED, TimeoutError…), never its message — it can carry a URL. */
export function errorCode(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown } })?.cause;
  if (typeof cause?.code === 'string') return cause.code;
  const name = (error as { name?: unknown })?.name;
  return typeof name === 'string' ? name : 'network_error';
}

/** An error's message, or the value itself as text. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Wait `ms`, or less if `signal` aborts first; never rejects. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
