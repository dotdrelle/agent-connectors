/** An MCP tool result carrying one JSON payload as text. */
export function jsonResult(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}
