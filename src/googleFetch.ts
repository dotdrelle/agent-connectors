import type { GoogleGrant, GoogleTokenProvider } from './googleTokens.ts';

export type GoogleFetchOptions = {
  tokens: GoogleTokenProvider;
  workspace: string;
  instanceId: string;
  /** Grants asserted before the first call; a missing one fails fast. */
  requiredGrants: readonly GoogleGrant[];
  fetch?: typeof fetch;
  /** Error prefix used for non-2xx responses, e.g. `gmail_api_failed`. */
  errorPrefix: string;
};

/**
 * A bearer-authenticated fetch bound to one workspace/instance.
 *
 * Access tokens are refreshed lazily by the provider, but Google can still
 * reject a token it considers stale; a single 401 therefore triggers one forced
 * refresh and one retry. The retry is deliberately once-only and shared per
 * call site, so a genuinely revoked authorization surfaces as an error instead
 * of spinning. Non-2xx responses become `<errorPrefix>:<status>` — a coarse,
 * non-secret code the agent maps to a stable failure class, never the provider
 * body (which can echo the request, including recipients).
 */
export function createGoogleFetch(
  options: GoogleFetchOptions,
): (url: URL | string, init?: RequestInit) => Promise<Response> {
  const doFetch = options.fetch ?? fetch;
  let accessToken: string | undefined;
  let refreshed = false;

  return async function googleFetch(url, init = {}) {
    accessToken ??= await options.tokens.getAccessToken(
      options.workspace,
      options.instanceId,
      { requiredGrants: options.requiredGrants },
    );
    const call = (token: string) =>
      doFetch(url as never, {
        ...init,
        headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
      });

    let response = await call(accessToken);
    if (response.status === 401 && !refreshed) {
      refreshed = true;
      accessToken = await options.tokens.getAccessToken(
        options.workspace,
        options.instanceId,
        { forceRefresh: true, requiredGrants: options.requiredGrants },
      );
      response = await call(accessToken);
    }
    if (!response.ok) throw new Error(`${options.errorPrefix}:${response.status}`);
    return response;
  };
}
