import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dockerfile = readFileSync(
  fileURLToPath(new URL('../Dockerfile', import.meta.url)),
  'utf8',
);

test('every COPY from the build context hands ownership to the runtime user', () => {
  // `COPY` conserve les permissions du fichier hôte et donne le fichier à root.
  // Avec `USER node` ensuite, une source en 600 sur la machine de build devient
  // illisible dans le conteneur : `EACCES: permission denied, open
  // '/app/src/index.ts'` au démarrage. La panne dépend de l'umask de qui
  // construit — invisible en CI, fatale en local.
  const lines = dockerfile.split('\n');
  const runtimeUser = lines.find((line) => /^USER\s+/.test(line))?.split(/\s+/)[1];
  assert.equal(runtimeUser, 'node', 'the container must not run as root');

  for (const line of lines) {
    if (!/^COPY\s/.test(line)) continue;
    // `COPY --from=<stage>` vient d'une étape de build, pas du contexte hôte.
    if (/--from=/.test(line)) continue;
    assert.match(
      line,
      new RegExp(`--chown=${runtimeUser}:`),
      `"${line.trim()}" must use --chown=${runtimeUser}:${runtimeUser}`,
    );
  }
});

test('no OAuth value passes through ARG or ENV', () => {
  // BuildKit le signale à raison (SecretsUsedInArgOrEnv) : un ENV reste inscrit
  // dans les métadonnées de l'image et ressort à chaque `docker inspect`.
  // L'application embarquée est un fichier en lecture seule, hors de la
  // configuration du conteneur.
  for (const line of dockerfile.split('\n')) {
    if (!/^(ARG|ENV)\s/.test(line)) continue;
    assert.doesNotMatch(line, /CLIENT_ID|CLIENT_SECRET|SECRET=/, `"${line.trim()}" leaks a credential into image metadata`);
  }
  assert.doesNotMatch(dockerfile, /WIKILLM_GOOGLE_OAUTH/);
  assert.match(dockerfile, /\.oauth-clien\[t\]\.json/, 'the baked client must be copied as an optional file');
});
