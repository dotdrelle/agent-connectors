/**
 * Donna answers in Markdown. Tchap renders `formatted_body` (a small HTML
 * subset); a plain `body` is always sent too. The conversion is deliberately
 * small — bold, italic, inline code, code blocks, headings as bold, lists as
 * lines, links — and escapes everything else: the text is untrusted, and an
 * unescaped `<` from a wiki page must never become markup.
 */

const MAX_CHUNK = 12_000;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inline(line: string): string {
  let html = escapeHtml(line);
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  return html;
}

export function markdownToHtml(markdown: string): string {
  const out: string[] = [];
  let inCode = false;
  let code: string[] = [];
  for (const raw of markdown.split('\n')) {
    if (/^```/.test(raw.trim())) {
      if (inCode) {
        out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
        code = [];
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      code.push(raw);
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(raw);
    if (heading) {
      out.push(`<strong>${inline(heading[1] ?? '')}</strong>`);
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(raw);
    if (bullet) {
      out.push(`• ${inline(bullet[1] ?? '')}`);
      continue;
    }
    out.push(inline(raw));
  }
  if (inCode) out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
  return out.join('<br>').replace(/<br><pre>/g, '<pre>').replace(/<\/pre><br>/g, '</pre>');
}

/** Split on paragraph, then line, boundaries so no message exceeds the chunk size. */
export function splitMessage(text: string, max = MAX_CHUNK): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed ? [trimmed] : [];
  const chunks: string[] = [];
  let current = '';
  for (const paragraph of trimmed.split(/\n{2,}/)) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= max) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    if (paragraph.length <= max) {
      current = paragraph;
      continue;
    }
    current = '';
    for (let start = 0; start < paragraph.length; start += max) chunks.push(paragraph.slice(start, start + max));
  }
  if (current) chunks.push(current);
  return chunks;
}
