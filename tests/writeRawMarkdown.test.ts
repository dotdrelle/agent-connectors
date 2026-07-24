import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  serializeRawItem,
  writeRawMarkdown,
  type RawItem,
} from '../src/writeRawMarkdown.ts';

const ITEM: RawItem = {
  logicalName: '<gmail-message-42@example.test>',
  okf: {
    type: 'Email',
    title: 'Re: Contrat ACME',
    tags: ['gmail', 'acme'],
    timestamp: '2026-07-22T14:31:00Z',
    'source-connector': 'google-1',
    'source-id': '42',
  },
  body: '# Métadonnées\n\n- **De :** alice@example.test\n\n# Corps\n\nBonjour.',
};

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-connectors-'));
  await mkdir(path.join(root, 'raw', 'untracked'), { recursive: true });
  return root;
}

test('writes deterministic OKF Markdown and skips identical content', async () => {
  const workspacePath = await createWorkspace();
  const first = await writeRawMarkdown({
    workspacePath,
    connectorId: 'google',
    instanceId: 'google-1',
    items: [ITEM],
  });
  assert.equal(first.written.length, 1);
  assert.deepEqual(first.skipped, []);
  assert.match(
    first.written[0],
    /^raw\/untracked\/connectors\/google-1\/gmail-message-42exampletest-[a-f0-9]{16}\.md$/,
  );
  const absolutePath = path.join(workspacePath, first.written[0]);
  const content = await readFile(absolutePath, 'utf8');
  assert.equal(content, serializeRawItem(ITEM));
  assert.match(content, /^---\ntype: "Email"\n/m);
  assert.match(content, /\nsource-id: "42"\n/);
  assert.match(content, /\n---\n\n# Métadonnées\n/);

  const before = await stat(absolutePath);
  const second = await writeRawMarkdown({
    workspacePath,
    connectorId: 'google',
    instanceId: 'google-1',
    items: [ITEM],
  });
  const after = await stat(absolutePath);
  assert.deepEqual(second.written, []);
  assert.deepEqual(second.skipped, first.written);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test('uses a temp file without .md extension and leaves no temp artifact', async () => {
  const workspacePath = await createWorkspace();
  await writeRawMarkdown({
    workspacePath,
    connectorId: 'google',
    instanceId: 'google-1',
    items: [ITEM],
  });
  const entries = await readdir(
    path.join(workspacePath, 'raw', 'untracked', 'connectors', 'google-1'),
  );
  assert.equal(entries.length, 1);
  assert.match(entries[0], /\.md$/);
  assert.equal(entries.some((entry) => entry.startsWith('.tmp-')), false);
});

test('rejects traversal, invalid OKF, controls, oversized content and duplicates', async () => {
  const workspacePath = await createWorkspace();
  const base = {
    workspacePath,
    connectorId: 'google',
    instanceId: 'google-1',
  };
  await assert.rejects(
    writeRawMarkdown({ ...base, instanceId: '../google-1', items: [ITEM] }),
    /safe connector identifier/,
  );
  await assert.rejects(
    writeRawMarkdown({
      ...base,
      items: [{ ...ITEM, logicalName: '../../secret' }],
    }),
    /path separator/,
  );
  await assert.rejects(
    writeRawMarkdown({
      ...base,
      items: [{ ...ITEM, okf: { ...ITEM.okf, type: '' } }],
    }),
    /type.*required/,
  );
  await assert.rejects(
    writeRawMarkdown({
      ...base,
      items: [{ ...ITEM, body: 'bad\u0000body' }],
    }),
    /control characters/,
  );
  await assert.rejects(
    writeRawMarkdown({ ...base, items: [ITEM], maxItemBytes: 10 }),
    /exceeds 10 bytes/,
  );
  await assert.rejects(
    writeRawMarkdown({ ...base, items: [ITEM, ITEM] }),
    /duplicate logical names/,
  );
});
