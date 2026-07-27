/**
 * Outbound counterpart of `Collector`.
 *
 * A collector turns provider content into workspace files; a sender turns
 * orchestrated arguments into one delivered message and nothing else. Keeping
 * the two shapes separate is what lets the agent expose an irreversible action
 * without giving the collection path any way to write to the outside world.
 */
export type SendContext = {
  workspace: { name: string; path: string };
  instanceId: string;
  /** Stable key for the task; used to derive a deterministic Message-ID. */
  idempotencyKey?: string;
};

export type SendRequest = {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  replyTo?: string;
  dryRun: boolean;
};

export type SendOutcome = {
  messageId?: string;
  threadId?: string;
  recipients: number;
  dryRun?: boolean;
  bytes?: number;
};

export type Sender = {
  readonly connectorId: string;
  send(request: SendRequest, context: SendContext): Promise<SendOutcome>;
};

export type SendLimits = {
  maxRecipients: number;
  maxBodyBytes: number;
  allowedRecipients: readonly string[];
};

/**
 * Validate and normalize `communication.send-email` arguments.
 *
 * This runs synchronously in `agent_execute`, before a job exists: a malformed
 * request is a caller error, not a failed send, and the orchestrator should see
 * it rejected immediately rather than discover it by polling. Every thrown
 * message is a short, non-secret code — it travels back through the run log.
 */
const KNOWN_SEND_FIELDS = new Set([
  'to',
  'cc',
  'bcc',
  'subject',
  'body',
  'replyTo',
  'dryRun',
]);

export function parseSendRequest(
  args: Record<string, unknown>,
  limits: SendLimits,
): SendRequest {
  // The schema declares additionalProperties:false, so honour it here too.
  // Silently ignoring an `attachments` or `html` field would send a message
  // materially different from the one that was approved.
  for (const key of Object.keys(args)) {
    if (!KNOWN_SEND_FIELDS.has(key)) {
      throw new Error(`invalid_arguments:unsupported_field:${key}`);
    }
  }
  const to = addressList(args.to, 'to');
  if (to.length === 0) throw new Error('invalid_arguments:to_required');
  const cc = addressList(args.cc, 'cc');
  const bcc = addressList(args.bcc, 'bcc');
  const recipients = [...to, ...cc, ...bcc];
  if (recipients.length > limits.maxRecipients) {
    throw new Error('invalid_arguments:too_many_recipients');
  }
  for (const recipient of recipients) {
    if (!isAllowedRecipient(recipient, limits.allowedRecipients)) {
      throw new Error('invalid_arguments:recipient_not_allowed');
    }
  }

  const subject = headerText(args.subject, 'subject');
  if (!subject) throw new Error('invalid_arguments:subject_required');
  if (Buffer.byteLength(subject, 'utf8') > 900) {
    throw new Error('invalid_arguments:subject_too_long');
  }

  if (typeof args.body !== 'string' || args.body.trim() === '') {
    throw new Error('invalid_arguments:body_required');
  }
  if (Buffer.byteLength(args.body, 'utf8') > limits.maxBodyBytes) {
    throw new Error('invalid_arguments:body_too_large');
  }
  // Control characters other than tab/newline have no meaning in a plain-text
  // body and are a classic way to smuggle terminal escapes into a reader.
  const body = args.body
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '');

  const replyTo =
    args.replyTo === undefined ? undefined : addressList(args.replyTo, 'replyTo');
  if (replyTo && replyTo.length !== 1) {
    throw new Error('invalid_arguments:reply_to_single_address');
  }

  if (args.dryRun !== undefined && typeof args.dryRun !== 'boolean') {
    throw new Error('invalid_arguments:dry_run_must_be_boolean');
  }

  return {
    to,
    cc,
    bcc,
    subject,
    body,
    ...(replyTo ? { replyTo: replyTo[0]! } : {}),
    dryRun: args.dryRun === true,
  };
}

/**
 * An allow-list entry is either a full address or an `@domain` suffix. An
 * empty list means unrestricted — the operator opted out, explicitly.
 */
export function isAllowedRecipient(
  address: string,
  allowed: readonly string[],
): boolean {
  if (allowed.length === 0) return true;
  const mailbox = extractMailbox(address).toLowerCase();
  const domain = mailbox.slice(mailbox.lastIndexOf('@'));
  return allowed.some((entry) =>
    entry.startsWith('@') ? domain === entry : mailbox === entry,
  );
}

/** The bare `local@domain` part of a possibly display-named address. */
export function extractMailbox(address: string): string {
  const angled = /<([^<>]+)>\s*$/.exec(address);
  return (angled ? angled[1]! : address).trim();
}

function addressList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  const raw = Array.isArray(value) ? value : [value];
  const addresses: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      throw new Error(`invalid_arguments:${field}_must_be_string`);
    }
    // A single field may carry "a@x, b@y"; split before validating so a comma
    // can never survive into a header as an unchecked separator.
    for (const part of entry.split(',')) {
      const address = part.trim();
      if (address === '') continue;
      assertValidAddress(address, field);
      addresses.push(address);
    }
  }
  return [...new Set(addresses)];
}

const MAILBOX_PATTERN =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

function assertValidAddress(address: string, field: string): void {
  // Header injection first: a CR, LF or NUL anywhere in an address is an
  // attempt to append headers (Bcc, Content-Type) to the message we build.
  if (/[\r\n\u0000]/.test(address)) {
    throw new Error(`invalid_arguments:${field}_header_injection`);
  }
  const mailbox = extractMailbox(address);
  if (!MAILBOX_PATTERN.test(mailbox) || mailbox.length > 254) {
    throw new Error(`invalid_arguments:${field}_invalid_address`);
  }
  const displayName = address.endsWith('>')
    ? address.slice(0, address.lastIndexOf('<')).trim()
    : '';
  if (/[\u0000-\u001f\u007f]/u.test(displayName)) {
    throw new Error(`invalid_arguments:${field}_invalid_display_name`);
  }
}

function headerText(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`invalid_arguments:${field}_required`);
  if (/[\r\n\u0000]/.test(value)) {
    throw new Error(`invalid_arguments:${field}_header_injection`);
  }
  return value.trim();
}
