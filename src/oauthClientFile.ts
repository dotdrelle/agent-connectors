import { readFileSync } from 'node:fs';

/**
 * Application OAuth embarquée dans l'image, lue depuis un fichier.
 *
 * Elle vivait dans un couple `ARG`/`ENV` du Dockerfile, ce que BuildKit signale
 * à juste titre (`SecretsUsedInArgOrEnv`) : un `ENV` reste inscrit dans les
 * métadonnées de l'image, visible par `docker inspect` et par toute couche
 * ultérieure. Un fichier copié dans l'image, en lecture seule et détenu par
 * l'utilisateur d'exécution, porte la même valeur sans la publier dans la
 * configuration du conteneur.
 *
 * Ce n'est pas du chiffrement et cela ne prétend pas l'être : le client Google
 * distribué est de type Desktop/public, ces deux valeurs ne sont pas une
 * frontière de sécurité. Le but est de ne plus les exposer là où les outils
 * s'attendent à ne trouver que de la configuration.
 *
 * C'est un DÉFAUT : `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`,
 * quand l'opérateur les renseigne dans le `.env` du manager, l'emportent.
 */
export const DEFAULT_OAUTH_CLIENT_FILE = '/app/.oauth-client.json';

export type BakedOAuthClient = {
  clientId?: string;
  clientSecret?: string;
};

/**
 * @param filePath fichier à lire ; `GOOGLE_OAUTH_CLIENT_FILE` le remplace, ce
 *   qui permet de monter une autre application sans reconstruire l'image.
 * @returns les valeurs trouvées, ou un objet vide. Un fichier absent est le cas
 *   NORMAL (image construite sans identifiants) et ne doit jamais empêcher
 *   l'agent de démarrer : seule l'autorisation Google devient indisponible, et
 *   `index.ts` le dit au démarrage.
 */
export function readBakedOAuthClient(filePath = DEFAULT_OAUTH_CLIENT_FILE): BakedOAuthClient {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Un fichier illisible est une erreur de construction, pas une panne
    // d'exécution : on le signale sans faire tomber l'agent.
    console.warn(`agent-connectors: ${filePath} is not valid JSON — ignoring the baked OAuth client.`);
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const record = parsed as Record<string, unknown>;
  const clientId = typeof record.clientId === 'string' ? record.clientId.trim() : '';
  const clientSecret = typeof record.clientSecret === 'string' ? record.clientSecret.trim() : '';
  return {
    ...(clientId ? { clientId } : {}),
    ...(clientSecret ? { clientSecret } : {}),
  };
}
