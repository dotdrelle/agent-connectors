import { loadConfig } from './config.ts';
import { startServer } from './server.ts';

const { port } = await startServer();
// eslint-disable-next-line no-console
console.log(`agent-connectors MCP listening on http://0.0.0.0:${port}/mcp`);

// État du client OAuth, annoncé au démarrage.
//
// Le client_id et le client_secret sont cuits dans l'image au build, et
// surchargeables par le `.env` du manager. Sans cette ligne, leur absence ne se
// manifestait qu'après le consentement Google, en
// `oauth_code_exchange_failed:401` — un code qui ressemble à un problème de
// compte alors que le conteneur n'a simplement jamais reçu d'identifiants. Ni
// l'un ni l'autre n'est un secret de sécurité (client public de type Desktop),
// mais on n'affiche que la fin du client_id et la présence du second.
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
