import { loadConfig } from './config.ts';
import { startServer } from './server.ts';

const { port } = await startServer();
// eslint-disable-next-line no-console
console.log(`agent-connectors MCP listening on http://0.0.0.0:${port}/mcp`);

// State of the OAuth client, announced at startup.
//
// The client_id and client_secret are baked into the image at build time, and
// can be overridden by the manager `.env`. Without this line, their absence
// only showed up after Google consent, as
// `oauth_code_exchange_failed:401` — a code that looks like an account problem
// while the container simply never received credentials. Neither value is a
// security secret (public Desktop-type client), but we only display the tail
// of the client_id and the presence of the secret.
const config = loadConfig();
const clientIdTail = config.googleClientId ? `…${config.googleClientId.slice(-14)}` : null;
if (!clientIdTail) {
  console.warn(
    'agent-connectors: no Google OAuth client configured — authorization cannot work. Set GOOGLE_OAUTH_CLIENT_ID/SECRET at image build time (they are baked in, not read at runtime).',
  );
} else if (!config.googleClientSecret) {
  console.warn(
    `agent-connectors: Google client ${clientIdTail} has NO client secret — the consent screen will work and the token exchange will then fail with 401. Rebuild the image with GOOGLE_OAUTH_CLIENT_SECRET set.`,
  );
} else {
  console.log(`agent-connectors: Google OAuth client ${clientIdTail} configured (secret present).`);
}
