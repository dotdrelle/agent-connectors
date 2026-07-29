import { createGoogleFetch } from './googleFetch.ts';
import type { GoogleTokenProvider } from './googleTokens.ts';

type Context = { workspace: string; instanceId: string };
type GmailLabel = { id?: string; name?: string; type?: string };

export class GmailMailbox {
  readonly #tokens: GoogleTokenProvider;
  readonly #fetch: typeof fetch;
  readonly #apiBaseUrl: string;

  constructor(options: {
    tokens: GoogleTokenProvider;
    fetch?: typeof fetch;
    apiBaseUrl?: string;
  }) {
    this.#tokens = options.tokens;
    this.#fetch = options.fetch ?? fetch;
    this.#apiBaseUrl = (options.apiBaseUrl ?? 'https://gmail.googleapis.com').replace(/\/+$/, '');
  }

  async summary(context: Context): Promise<Record<string, unknown>> {
    const gmailFetch = this.#gmailFetch(context, ['read']);
    const profile = await this.#json(gmailFetch, '/gmail/v1/users/me/profile');
    const unread = await this.#list(gmailFetch, 'is:unread', 1);
    const inboxUnread = await this.#list(gmailFetch, 'in:inbox is:unread', 1);
    return {
      emailAddress: profile.emailAddress ?? null,
      messagesTotal: profile.messagesTotal ?? 0,
      threadsTotal: profile.threadsTotal ?? 0,
      unread: unread.resultSizeEstimate ?? 0,
      inboxUnread: inboxUnread.resultSizeEstimate ?? 0,
    };
  }

  async search(
    context: Context,
    options: { query?: string; maxMessages?: number; includeSpamTrash?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const gmailFetch = this.#gmailFetch(context, ['read']);
    const maxMessages = Math.max(1, Math.min(100, Math.trunc(options.maxMessages ?? 20)));
    const listed = await this.#list(
      gmailFetch,
      options.query,
      maxMessages,
      options.includeSpamTrash === true,
    );
    const messages = [];
    for (const entry of (listed.messages as Array<{ id?: string }> | undefined) ?? []) {
      if (!entry.id) continue;
      const url = `/gmail/v1/users/me/messages/${encodeURIComponent(entry.id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`;
      const message = await this.#json(gmailFetch, url);
      const headers = new Map(
        ((message.payload as { headers?: Array<{ name?: string; value?: string }> } | undefined)?.headers ?? [])
          .map((header) => [String(header.name ?? '').toLowerCase(), String(header.value ?? '')]),
      );
      messages.push({
        id: message.id,
        threadId: message.threadId,
        labelIds: message.labelIds ?? [],
        from: headers.get('from') ?? '',
        to: headers.get('to') ?? '',
        subject: headers.get('subject') ?? '(no subject)',
        date: headers.get('date') ?? '',
        snippet: message.snippet ?? '',
      });
    }
    return { query: options.query ?? '', resultSizeEstimate: listed.resultSizeEstimate ?? 0, messages };
  }

  async labels(context: Context): Promise<Record<string, unknown>> {
    const gmailFetch = this.#gmailFetch(context, ['read']);
    const payload = await this.#json(gmailFetch, '/gmail/v1/users/me/labels');
    return {
      labels: ((payload.labels as GmailLabel[] | undefined) ?? [])
        .filter((label) => label.id && label.name)
        .map((label) => ({ id: label.id, name: label.name, type: label.type ?? 'user' })),
    };
  }

  async modify(
    context: Context,
    messageId: string,
    action: string,
    labelIds: string[] = [],
  ): Promise<Record<string, unknown>> {
    const gmailFetch = this.#gmailFetch(context, ['modify']);
    const encoded = encodeURIComponent(messageId);
    if (action === 'trash' || action === 'untrash') {
      const result = await this.#json(
        gmailFetch,
        `/gmail/v1/users/me/messages/${encoded}/${action}`,
        { method: 'POST' },
      );
      return { ok: true, messageId: result.id ?? messageId, action };
    }
    const changes: Record<string, { addLabelIds?: string[]; removeLabelIds?: string[] }> = {
      mark_read: { removeLabelIds: ['UNREAD'] },
      mark_unread: { addLabelIds: ['UNREAD'] },
      archive: { removeLabelIds: ['INBOX'] },
      move_to_inbox: { addLabelIds: ['INBOX'] },
      star: { addLabelIds: ['STARRED'] },
      unstar: { removeLabelIds: ['STARRED'] },
      add_labels: { addLabelIds: labelIds },
      remove_labels: { removeLabelIds: labelIds },
    };
    const body = changes[action];
    if (!body) throw new Error(`unsupported_gmail_action:${action}`);
    if ((action === 'add_labels' || action === 'remove_labels') && labelIds.length === 0) {
      throw new Error('labelIds is required for label actions');
    }
    const result = await this.#json(
      gmailFetch,
      `/gmail/v1/users/me/messages/${encoded}/modify`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    );
    return { ok: true, messageId: result.id ?? messageId, action, labelIds: result.labelIds ?? [] };
  }

  #gmailFetch(context: Context, requiredGrants: Array<'read' | 'modify'>) {
    return createGoogleFetch({
      tokens: this.#tokens,
      workspace: context.workspace,
      instanceId: context.instanceId,
      requiredGrants,
      fetch: this.#fetch,
      errorPrefix: 'gmail_api_failed',
    });
  }

  async #list(
    gmailFetch: ReturnType<typeof createGoogleFetch>,
    query = '',
    maxResults = 20,
    includeSpamTrash = false,
  ): Promise<Record<string, unknown>> {
    const params = new URLSearchParams({ maxResults: String(maxResults) });
    if (query) params.set('q', query);
    if (includeSpamTrash) params.set('includeSpamTrash', 'true');
    return this.#json(gmailFetch, `/gmail/v1/users/me/messages?${params}`);
  }

  async #json(
    gmailFetch: ReturnType<typeof createGoogleFetch>,
    pathname: string,
    init?: RequestInit,
  ): Promise<Record<string, any>> {
    const response = await gmailFetch(new URL(`${this.#apiBaseUrl}${pathname}`), init);
    return await response.json() as Record<string, any>;
  }
}
