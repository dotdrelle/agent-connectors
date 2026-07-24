import { GMAIL_READONLY_SCOPE } from './googleTokens.ts';

export type OAuthProvider = {
  id: string;
  authorizationUrl: string;
  tokenUrl: string;
  scopes: readonly string[];
  authorizationParams: Readonly<Record<string, string>>;
};

/**
 * Declarative provider table. Gmail is the first consumer; future Slack,
 * Notion and X integrations can add provider-specific endpoints and token
 * response mapping without duplicating the PKCE/state machinery.
 */
export const AUTH_PROVIDERS = {
  google: {
    id: 'google',
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: [GMAIL_READONLY_SCOPE],
    authorizationParams: {
      access_type: 'offline',
      prompt: 'consent',
    },
  },
} as const satisfies Record<string, OAuthProvider>;
