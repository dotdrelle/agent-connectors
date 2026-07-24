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

  return {
    logicalName: id,
    okf: {
      type: 'Email',
      title: subject,
      description: cleanInline(message.snippet).slice(0, 500),
      resource: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(id)}`,
      tags: ['gmail'],
      ...(timestamp ? { timestamp } : {}),
      'source-connector': instanceId,
      'source-id': id,
    },
    body: metadata.join('\n'),
  };
}

function extractBody(part: GmailPart | undefined): string {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body?.data) {
    return cleanBody(decodeBase64Url(part.body.data));
  }
  for (const child of part.parts ?? []) {
    const plain = findMime(child, 'text/plain');
    if (plain) return cleanBody(decodeBase64Url(plain));
  }
  const htmlData =
    part.mimeType === 'text/html' ? part.body?.data : findMime(part, 'text/html');
  return htmlData ? htmlToText(decodeBase64Url(htmlData)) : '';
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

function htmlToText(html: string): string {
  return cleanBody(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p\s*>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'"),
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
