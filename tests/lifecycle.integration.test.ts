import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { IngestService } from '../../../llm-wiki/src/services/ingestService.ts';
import type { LLMService } from '../../../llm-wiki/src/services/llmService.ts';
import type { RefreshService } from '../../../llm-wiki/src/services/refreshService.ts';
import type { RetrievalService } from '../../../llm-wiki/src/services/retrievalService.ts';
import type { TraceLogger } from '../../../llm-wiki/src/services/traceLogger.ts';
import { WorkspaceService } from '../../../llm-wiki/src/services/workspaceService.ts';
import type { AppConfig } from '../../../llm-wiki/src/types.ts';
import { writeRawMarkdown, type RawItem } from '../src/writeRawMarkdown.ts';

function createConfig(wikiRoot: string): AppConfig {
  return {
    wikiRoot,
    language: 'fr',
    llm: {
      provider: 'ollama',
      model: 'unused',
      apiKey: 'unused',
      baseUrl: 'http://127.0.0.1:11434/v1',
      temperature: 0,
      timeoutMs: 1_000,
    },
    limits: {
      requestsPerMinute: 10,
      maxInputTokensPerCall: 50_000,
      targetInputTokensPerCall: 40_000,
      maxProfileChars: 4_000,
    },
    build: {
      refreshOnIngest: false,
      slotBatchSize: 5,
      maxBuildContextChars: 12_000,
    },
    retrieval: {
      maxContextFiles: 8,
      maxChunksPerPage: 2,
      maxChunkChars: 3_000,
      maxSourceChars: 8_000,
      buildStrategy: 'bm25',
      vector: {
        enabled: false,
        baseUrl: 'http://127.0.0.1:11434/v1',
        timeoutMs: 1_000,
        embeddingModel: 'unused',
        rerankEnabled: false,
        rerankerModel: 'unused',
        topK: 10,
        rerankTopK: 5,
        maxResults: 5,
      },
    },
    mcp: {},
  };
}

const ITEM: RawItem = {
  logicalName: 'gmail-message-42',
  okf: {
    type: 'Email',
    title: 'Lifecycle proof',
    'source-connector': 'google-1',
    'source-id': '42',
  },
  body: '# Corps\n\nContenu stable.',
};

test('a collected item recreated after archival is recognized as unchanged', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-connectors-lifecycle-'));
  const config = createConfig(root);
  const workspace = new WorkspaceService(config);
  await workspace.initWorkspace({});

  const first = await writeRawMarkdown({
    workspacePath: root,
    connectorId: 'google',
    instanceId: 'google-1',
    items: [ITEM],
  });
  const firstSource = await workspace.readSourceDocument(path.join(root, first.written[0]));
  assert.equal(await workspace.isSourceUnchangedSinceIngest(firstSource), false);
  await workspace.archiveSource(firstSource);

  const second = await writeRawMarkdown({
    workspacePath: root,
    connectorId: 'google',
    instanceId: 'google-1',
    items: [ITEM],
  });
  assert.equal(second.written.length, 1);
  const recreatedSource = await workspace.readSourceDocument(
    path.join(root, second.written[0]),
  );
  assert.equal(await workspace.isSourceUnchangedSinceIngest(recreatedSource), true);

  const archivedPath = path.join(root, recreatedSource.archiveRelativePath);
  const archivedBefore = await readFile(archivedPath, 'utf8');
  let llmCalls = 0;
  const llm = {
    async completeJson() {
      llmCalls += 1;
      throw new Error('The LLM must not be called for an unchanged archived source.');
    },
  } as unknown as LLMService;
  const noOp = {} as RetrievalService & RefreshService;
  const logger = {
    async info() {},
    async warn() {},
    async error() {},
  } as unknown as TraceLogger;
  const ingest = new IngestService(config, workspace, llm, noOp, noOp, logger);
  const results = await ingest.ingest([path.join(root, second.written[0])], {});

  assert.equal(results.length, 1);
  assert.equal(results[0].skipped, true);
  assert.equal(llmCalls, 0);
  assert.equal(await readFile(archivedPath, 'utf8'), archivedBefore);
});
