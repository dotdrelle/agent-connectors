import {
  GMAIL_READONLY_SCOPE,
  GMAIL_SEND_SCOPE,
  GMAIL_MODIFY_SCOPE,
  type GoogleGrant,
} from './googleTokens.ts';

export type OAuthProvider = {
  id: string;
  authorizationUrl: string;
  tokenUrl: string;
  /** Scopes requested when the caller does not name any grant. */
  scopes: readonly string[];
  /** Scope requested per grant; the authorization URL is built from these. */
  grantScopes: Readonly<Record<GoogleGrant, readonly string[]>>;
  authorizationParams: Readonly<Record<string, string>>;
};

/**
 * Declarative provider table. Gmail is the first consumer; future Slack,
 * Notion and X integrations can add provider-specific endpoints and token
 * response mapping without duplicating the PKCE/state machinery.
 *
 * `include_granted_scopes` makes every authorization *incremental*: a workspace
 * already connected for reading that later adds the `send` grant keeps its read
 * access instead of silently losing it on re-consent.
 */
export const AUTH_PROVIDERS = {
  google: {
    id: 'google',
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: [GMAIL_READONLY_SCOPE],
    grantScopes: {
      read: [GMAIL_READONLY_SCOPE],
      send: [GMAIL_SEND_SCOPE],
      modify: [GMAIL_MODIFY_SCOPE],
    },
    authorizationParams: {
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
    },
  },
} as const satisfies Record<string, OAuthProvider>;
