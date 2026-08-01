import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { readBakedOAuthClient } from '../src/oauthClientFile.ts';

function fileWith(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'oauth-client-'));
  const filePath = join(dir, '.oauth-client.json');
  writeFileSync(filePath, content);
  return filePath;
}

const BASE_ENV = { WORKSPACES_ROOT: '/workspaces', AGENT_DATA_DIR: '/data' };

test('reads the baked client from its file', () => {
  const filePath = fileWith(JSON.stringify({ clientId: 'id-123', clientSecret: 'secret-456' }));
  assert.deepEqual(readBakedOAuthClient(filePath), {
    clientId: 'id-123',
    clientSecret: 'secret-456',
  });
});

test('a missing file is the normal case, not a failure', () => {
  // Image construite sans identifiants : l'agent doit démarrer et le dire,
  // seule l'autorisation Google devient indisponible.
  assert.deepEqual(readBakedOAuthClient('/nope/.oauth-client.json'), {});
});

test('a malformed file is ignored rather than fatal', () => {
  assert.deepEqual(readBakedOAuthClient(fileWith('{ not json')), {});
  assert.deepEqual(readBakedOAuthClient(fileWith('[]')), {});
  assert.deepEqual(readBakedOAuthClient(fileWith('{"clientId": 42}')), {});
});

test('the operator .env wins over the baked client', () => {
  const filePath = fileWith(JSON.stringify({ clientId: 'baked-id', clientSecret: 'baked-secret' }));
  const config = loadConfig({
    ...BASE_ENV,
    GOOGLE_OAUTH_CLIENT_FILE: filePath,
    GOOGLE_OAUTH_CLIENT_ID: 'own-id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'own-secret',
  });
  assert.equal(config.googleClientId, 'own-id');
  assert.equal(config.googleClientSecret, 'own-secret');
});

test('empty .env values fall back to the baked client instead of erasing it', () => {
  // C'est précisément ce que l'ancien montage rendait impossible : le fichier
  // Compose injectait `GOOGLE_OAUTH_CLIENT_ID=${...:-}`, une chaîne vide qui
  // écrasait le défaut porté par un ENV de l'image.
  const filePath = fileWith(JSON.stringify({ clientId: 'baked-id', clientSecret: 'baked-secret' }));
  const config = loadConfig({
    ...BASE_ENV,
    GOOGLE_OAUTH_CLIENT_FILE: filePath,
    GOOGLE_OAUTH_CLIENT_ID: '',
    GOOGLE_OAUTH_CLIENT_SECRET: '   ',
  });
  assert.equal(config.googleClientId, 'baked-id');
  assert.equal(config.googleClientSecret, 'baked-secret');
});

test('one override does not drag the other along', () => {
  const filePath = fileWith(JSON.stringify({ clientId: 'baked-id', clientSecret: 'baked-secret' }));
  const config = loadConfig({
    ...BASE_ENV,
    GOOGLE_OAUTH_CLIENT_FILE: filePath,
    GOOGLE_OAUTH_CLIENT_ID: 'own-id',
  });
  assert.equal(config.googleClientId, 'own-id');
  assert.equal(config.googleClientSecret, 'baked-secret');
});
