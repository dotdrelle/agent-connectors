/** A network failure's code (ECONNREFUSED, TimeoutError…), never its message — it can carry a URL. */
export function errorCode(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown } })?.cause;
  if (typeof cause?.code === 'string') return cause.code;
  const name = (error as { name?: unknown })?.name;
  return typeof name === 'string' ? name : 'network_error';
}
