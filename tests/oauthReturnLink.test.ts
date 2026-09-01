import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import { handleGoogleOAuth } from '../src/server.ts';

type Recorder = {
  headers: Record<string, string>;
  status: number;
  body: string;
  setHeader: (name: string, value: string) => void;
  writeHead: (status: number, headers: Record<string, string>) => void;
  end: (body?: string) => void;
};

function recorder(): Recorder {
  const res: Recorder = {
    headers: {},
    status: 0,
    body: '',
    setHeader(name, value) {
      res.headers[name] = value;
    },
    writeHead(status, headers) {
      res.status = status;
      Object.assign(res.headers, headers);
    },
    end(body = '') {
      res.body = body;
    },
  };
  return res;
}

test('the OAuth callback page links back to the workspace URL carried by the state', async () => {
  const res = recorder();
  const req = Readable.from([]) as never;
  Object.assign(req, {
    method: 'GET',
    url: '/oauth/google/callback?code=abc&state=signed.value',
  });

  await handleGoogleOAuth(req as never, res as never, {
    workspacesRoot: '/tmp/connectors-test',
    oauth: {
      complete: async () => ({
        workspace: 'demo',
        instanceId: 'google-1',
        grants: ['read', 'send'],
        returnTo: 'https://wiki.example.test/',
      }),
    } as never,
  });

  assert.equal(res.status, 200);
  assert.match(res.body, /href="https:\/\/wiki\.example\.test\/"/);
  assert.match(res.body, /← Back to the workspace/);
});

test('the callback page renders no link when no returnTo was authorized', async () => {
  const res = recorder();
  const req = Readable.from([]) as never;
  Object.assign(req, {
    method: 'GET',
    url: '/oauth/google/callback?code=abc&state=signed.value',
  });

  await handleGoogleOAuth(req as never, res as never, {
    workspacesRoot: '/tmp/connectors-test',
    oauth: {
      complete: async () => ({
        workspace: 'demo',
        instanceId: 'google-1',
        grants: ['read'],
        returnTo: null,
      }),
    } as never,
  });

  assert.equal(res.status, 200);
  assert.doesNotMatch(res.body, /Back to the workspace/);
});
