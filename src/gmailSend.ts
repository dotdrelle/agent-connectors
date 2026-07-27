import { createHash } from 'node:crypto';

import { createGoogleFetch } from './googleFetch.ts';
import type { GoogleTokenProvider } from './googleTokens.ts';
import type { SendContext, Sender, SendOutcome, SendRequest } from './sender.ts';
import { extractMailbox } from './sender.ts';

export type GmailSenderOptions = {
  tokens: GoogleTokenProvider;
  fetch?: typeof fetch;
  apiBaseUrl?: string;
};

/**
 * Gmail implementation of `Sender`.
 *
 * The message is assembled locally as RFC 5322 and handed to Gmail as a single
 * base64url blob. `From` is deliberately absent: Gmail stamps the authenticated
 * mailbox, so the agent cannot be talked into spoofing a sender it does not own.
 */
export class GmailSender implements Sender {
  readonly connectorId = 'google';
  readonly #tokens: GoogleTokenProvider;
  readonly #fetch: typeof fetch;
  readonly #apiBaseUrl: string;

  constructor(options: GmailSenderOptions) {
    this.#tokens = options.tokens;
    this.#fetch = options.fetch ?? fetch;
    this.#apiBaseUrl = (options.apiBaseUrl ?? 'https://gmail.googleapis.com').replace(
      /\/+$/,
      '',
    );
  }

  async send(request: SendRequest, context: SendContext): Promise<SendOutcome> {
    const messageId = context.idempotencyKey
      ? deterministicMessageId(context.idempotencyKey)
      : undefined;
    const mime = buildMimeMessage(request, messageId);
    const recipients = request.to.length + request.cc.length + request.bcc.length;
    const bytes = Buffer.byteLength(mime, 'utf8');

    if (request.dryRun) {
      // Deliberately no messageId: a dry run produced no provider message, and
      // reporting the RFC 5322 header here would read like a delivery receipt.
      return { recipients, bytes, dryRun: true };
    }

    const googleFetch = createGoogleFetch({
      tokens: this.#tokens,
      workspace: context.workspace.name,
      instanceId: context.instanceId,
      requiredGrants: ['send'],
      fetch: this.#fetch,
      errorPrefix: 'gmail_send_failed',
    });
    const url = new URL(`${this.#apiBaseUrl}/gmail/v1/users/me/messages/send`);
    const response = await googleFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ raw: Buffer.from(mime, 'utf8').toString('base64url') }),
    });
    const payload = (await response.json()) as { id?: string; threadId?: string };
    return {
      recipients,
      bytes,
      ...(payload.id ? { messageId: payload.id } : {}),
      ...(payload.threadId ? { threadId: payload.threadId } : {}),
    };
  }
}

/**
 * A Message-ID derived from the idempotency key, not from a random value.
 *
 * The job store already prevents a replayed key from sending twice within a
 * live process. This header is the audit trail for the case it cannot cover:
 * a crash between the API call and the job settling. The operator can search
 * the sent mailbox for `rfc822msgid:` and tell "never sent" from "sent, then
 * lost the acknowledgement" — the one distinction that matters after a send.
 */
export function deterministicMessageId(idempotencyKey: string): string {
  const digest = createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32);
  return `<${digest}@connectors.wikillm.invalid>`;
}

/**
 * Build an RFC 5322 message: UTF-8 plain text, base64 transfer encoding.
 *
 * Base64 rather than 8bit or quoted-printable because it is the only encoding
 * that is simultaneously safe for arbitrary Unicode, immune to the 998-octet
 * line limit, and impossible to misread as header content.
 */
export function buildMimeMessage(request: SendRequest, messageId?: string): string {
  const headers: string[] = [];
  if (messageId) headers.push(`Message-ID: ${messageId}`);
  headers.push(foldAddressHeader('To', request.to));
  if (request.cc.length > 0) headers.push(foldAddressHeader('Cc', request.cc));
  if (request.bcc.length > 0) headers.push(foldAddressHeader('Bcc', request.bcc));
  if (request.replyTo) headers.push(foldAddressHeader('Reply-To', [request.replyTo]));
  headers.push(`Subject: ${encodeHeaderValue(request.subject)}`);
  headers.push('MIME-Version: 1.0');
  headers.push('Content-Type: text/plain; charset="UTF-8"');
  headers.push('Content-Transfer-Encoding: base64');

  const body = wrapBase64(Buffer.from(request.body, 'utf8').toString('base64'));
  return `${headers.join('\r\n')}\r\n\r\n${body}`;
}

/** `Name <a@b>` with the display name encoded only when it needs to be. */
export function encodeAddress(address: string): string {
  const mailbox = extractMailbox(address);
  if (mailbox === address.trim()) return mailbox;
  const displayName = address.slice(0, address.lastIndexOf('<')).trim();
  const unquoted = displayName.replace(/^"(.*)"$/s, '$1');
  if (!unquoted) return mailbox;
  if (isAscii(unquoted)) {
    // Specials must be quoted; a quoted string cannot contain a bare quote or
    // backslash, so both are escaped rather than dropped.
    return /[()<>@,;:\\".\[\]]/.test(unquoted)
      ? `"${unquoted.replace(/([\\"])/g, '\\$1')}" <${mailbox}>`
      : `${unquoted} <${mailbox}>`;
  }
  return `${encodeHeaderValue(unquoted)} <${mailbox}>`;
}

/**
 * RFC 2047 encoded-word for non-ASCII header text.
 *
 * Chunking is done on UTF-8 byte boundaries computed per code point: splitting
 * a multi-byte character across two encoded words produces mojibake in every
 * client, and is the classic bug in hand-rolled MIME encoders.
 */
export function encodeHeaderValue(value: string): string {
  if (isAscii(value)) return value;
  const words: string[] = [];
  let chunk = '';
  let chunkBytes = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char, 'utf8');
    if (chunkBytes + size > 30) {
      words.push(encodedWord(chunk));
      chunk = '';
      chunkBytes = 0;
    }
    chunk += char;
    chunkBytes += size;
  }
  if (chunk) words.push(encodedWord(chunk));
  // Encoded words are separated by CRLF + space: a folded header, which every
  // reader joins back without inserting the whitespace into the decoded text.
  return words.join('\r\n ');
}

function encodedWord(value: string): string {
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function foldAddressHeader(name: string, addresses: readonly string[]): string {
  const encoded = addresses.map(encodeAddress);
  const lines: string[] = [];
  let current = `${name}:`;
  encoded.forEach((address, index) => {
    const separator = index === encoded.length - 1 ? '' : ',';
    if (current.length + address.length + 1 > 76 && current !== `${name}:`) {
      lines.push(current);
      current = ' ';
    } else {
      current += ' ';
    }
    current += `${address}${separator}`;
  });
  lines.push(current);
  return lines.join('\r\n');
}

function wrapBase64(value: string): string {
  return (value.match(/.{1,76}/g) ?? ['']).join('\r\n');
}

function isAscii(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /^[ -~]*$/.test(value);
}
