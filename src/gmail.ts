import type { Collector, CollectorContext } from './collector.ts';
import type { GoogleTokenProvider } from './googleTokens.ts';
import type { RawItem } from './writeRawMarkdown.ts';

type GmailHeader = { name?: string; value?: string };
type GmailPart = {
  mimeType?: string;
  headers?: GmailHeader[];
  body?: { data?: string };
  parts?: GmailPart[];
};
type GmailMessage = {
  id?: string;
  threadId?: string;
  internalDate?: string;
  snippet?: string;
  payload?: GmailPart;
};

export type GmailCollectorOptions = {
  tokens: GoogleTokenProvider;
  fetch?: typeof fetch;
  apiBaseUrl?: string;
  defaultMaxMessages?: number;
  hardMaxMessages?: number;
};

export class GmailCollector implements Collector {
  readonly connectorId = 'google';
  readonly #tokens: GoogleTokenProvider;
  readonly #fetch: typeof fetch;
  readonly #apiBaseUrl: string;
  readonly #defaultMaxMessages: number;
  readonly #hardMaxMessages: number;

  constructor(options: GmailCollectorOptions) {
    this.#tokens = options.tokens;
    this.#fetch = options.fetch ?? fetch;
    this.#apiBaseUrl = (options.apiBaseUrl ?? 'https://gmail.googleapis.com').replace(/\/+$/, '');
    this.#defaultMaxMessages = options.defaultMaxMessages ?? 50;
    this.#hardMaxMessages = options.hardMaxMessages ?? 500;
  }

  async collect(
    args: Record<string, unknown>,
    context: CollectorContext,
  ): Promise<RawItem[]> {
    const maxMessages = boundedInteger(
      args.maxMessages,
      this.#defaultMaxMessages,
      1,
      this.#hardMaxMessages,
      'maxMessages',
    );
    const query = optionalString(args.query);
    const includeSpamTrash = args.includeSpamTrash === true;
    let accessToken = await this.#tokens.getAccessToken(
      context.workspace.name,
      context.instanceId,
    );
    let refreshedAfterUnauthorized = false;

    const googleFetch = async (url: URL): Promise<Response> => {
      let response = await this.#fetch(url, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (response.status === 401 && !refreshedAfterUnauthorized) {
        refreshedAfterUnauthorized = true;
        accessToken = await this.#tokens.getAccessToken(
          context.workspace.name,
          context.instanceId,
          { forceRefresh: true },
        );
        response = await this.#fetch(url, {
          headers: { authorization: `Bearer ${accessToken}` },
        });
      }
      if (!response.ok) throw new Error(`gmail_api_failed:${response.status}`);
      return response;
    };

    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(`${this.#apiBaseUrl}/gmail/v1/users/me/messages`);
      url.searchParams.set('maxResults', String(Math.min(500, maxMessages - ids.length)));
      if (query) url.searchParams.set('q', query);
      if (includeSpamTrash) url.searchParams.set('includeSpamTrash', 'true');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const payload = (await (await googleFetch(url)).json()) as {
        messages?: Array<{ id?: string }>;
        nextPageToken?: string;
      };
      const pageMessages = payload.messages ?? [];
      if (pageMessages.length === 0) break;
      for (const entry of pageMessages) {
        if (typeof entry.id === 'string' && entry.id) ids.push(entry.id);
        if (ids.length >= maxMessages) break;
      }
      pageToken = optionalString(payload.nextPageToken);
    } while (pageToken && ids.length < maxMessages);

    const items: RawItem[] = [];
    for (const id of ids) {
      const url = new URL(
        `${this.#apiBaseUrl}/gmail/v1/users/me/messages/${encodeURIComponent(id)}`,
      );
      url.searchParams.set('format', 'full');
      const message = (await (await googleFetch(url)).json()) as GmailMessage;
      items.push(renderGmailMessage(message, context.instanceId));
    }
    return items;
  }
}

export function renderGmailMessage(message: GmailMessage, instanceId: string): RawItem {
  const id = optionalString(message.id);
  if (!id) throw new Error('gmail_message_id_missing');
  const headers = new Map(
    (message.payload?.headers ?? [])
      .filter((header) => optionalString(header.name))
      .map((header) => [header.name!.toLowerCase(), optionalString(header.value) ?? '']),
  );
  const subject = cleanInline(headers.get('subject')) || '(no subject)';
  const from = cleanInline(headers.get('from'));
  const to = cleanInline(headers.get('to'));
  const cc = cleanInline(headers.get('cc'));
  const headerDate = cleanInline(headers.get('date'));
  const timestamp = gmailTimestamp(message.internalDate, headerDate);
  const body = extractBody(message.payload);
  const metadata = [
    '# Metadata',
    '',
    from ? `- **From:** ${from}` : undefined,
    to ? `- **To:** ${to}` : undefined,
    cc ? `- **Cc:** ${cc}` : undefined,
    headerDate ? `- **Date:** ${headerDate}` : undefined,
    message.threadId ? `- **Thread:** ${cleanInline(message.threadId)}` : undefined,
    '',
    '# Body',
    '',
    body || cleanInline(message.snippet) || '(empty message)',
  ].filter((line): line is string => line !== undefined);

  const snippet = cleanInline(message.snippet);
  const description = snippet ? truncateOnWord(snippet, 200) : undefined;

  return {
    logicalName: id,
    fileNameHint: subject,
    okf: {
      type: 'Email',
      title: subject,
      ...(from ? { author: from } : {}),
      ...(description ? { description } : {}),
      resource: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(id)}`,
      tags: ['gmail'],
      ...(timestamp ? { timestamp } : {}),
      'source-connector': instanceId,
      'source-id': id,
    },
    body: metadata.join('\n'),
  };
}

/** Trim to a whole-word boundary near `max`, adding an ellipsis when cut. */
function truncateOnWord(value: string, max: number): string {
  if (value.length <= max) return value;
  const slice = value.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  const trimmed = (lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice).trimEnd();
  return `${trimmed}…`;
}

function extractBody(part: GmailPart | undefined): string {
  if (!part) return '';
  const plainData = findMime(part, 'text/plain');
  const htmlData =
    part.mimeType === 'text/html' ? part.body?.data : findMime(part, 'text/html');
  const plain = plainData ? cleanBody(decodeBase64Url(plainData)) : '';

  // Some newsletter providers label their generated HTML/CSS source as
  // text/plain. Prefer the real HTML alternative in that case so invisible
  // styles and markup do not become the visible Markdown body.
  if (plain && (!htmlData || !looksLikeGeneratedMarkup(plain))) return plain;
  if (htmlData) return htmlToText(decodeBase64Url(htmlData));
  return plain;
}

function findMime(part: GmailPart, mimeType: string): string | undefined {
  if (part.mimeType === mimeType && part.body?.data) return part.body.data;
  for (const child of part.parts ?? []) {
    const found = findMime(child, mimeType);
    if (found) return found;
  }
  return undefined;
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function looksLikeGeneratedMarkup(value: string): boolean {
  const tagMatches = value.match(/<\/?(?:html|head|body|style|table|tbody|tr|td|div|a|img)\b[^>]*>/gi)?.length ?? 0;
  const cssSignals = value.match(/(?:@media\b|!important\b|#[\w-]+\s*\{|(?:^|[;}])\s*\.[\w-]+\s*\{)/gim)?.length ?? 0;
  return tagMatches >= 2 || cssSignals >= 3;
}

function htmlToText(html: string): string {
  return cleanBody(
    html
      // Remove <script>/<style> AND their content. The close is tolerant
      // (whitespace or attributes), and an unclosed tag is consumed to the end
      // of input, so no executable JS or CSS source can leak into the body even
      // as inert text.
      .replace(/<script\b[^>]*>[\s\S]*?(?:<\/script\b[^>]*>|$)/gi, '')
      .replace(/<style\b[^>]*>[\s\S]*?(?:<\/style\b[^>]*>|$)/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p\s*>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&#(?:x([0-9a-f]+)|([0-9]+));/gi, (entity, hex, decimal) => {
        const codePoint = Number.parseInt(hex ?? decimal, hex ? 16 : 10);
        // Never reconstruct angle brackets: encoded HTML must remain inert in
        // the Markdown renderer.
        if (!Number.isSafeInteger(codePoint) || codePoint === 60 || codePoint === 62) {
          return entity;
        }
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return entity;
        }
      })
      // HTML table indentation is presentation whitespace, not Markdown code.
      .split('\n')
      .map((line) => line.trim())
      .join('\n'),
  );
}

function cleanBody(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function cleanInline(value: unknown): string {
  return typeof value === 'string'
    ? value
        .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    : '';
}

function gmailTimestamp(internalDate: unknown, headerDate: string): string | undefined {
  const millis =
    typeof internalDate === 'string' && /^\d+$/.test(internalDate)
      ? Number(internalDate)
      : Number.NaN;
  const date = Number.isFinite(millis) ? new Date(millis) : new Date(headerDate);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function boundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}
