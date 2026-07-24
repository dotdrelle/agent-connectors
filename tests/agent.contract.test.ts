import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { ConnectorsAgent, type ExecuteResponse } from '../src/agent.ts';
import { loadConfig } from '../src/config.ts';
import { JobStore } from '../src/jobs.ts';

async function makeWorkspace(): Promise<{ root: string; workspace: string; dataDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'connectors-root-'));
  const workspace = path.join(root, 'demo');
  const dataDir = path.join(root, 'agent-data');
  await mkdir(path.join(workspace, 'raw', 'untracked'), { recursive: true });
  return { root, workspace, dataDir };
}

function newAgent(
  workspacesRoot = mkdtempSync(path.join(tmpdir(), 'connectors-root-')),
  dataDir = mkdtempSync(path.join(tmpdir(), 'connectors-data-')),
) {
  return new ConnectorsAgent(
    loadConfig({ WORKSPACES_ROOT: workspacesRoot, AGENT_DATA_DIR: dataDir }),
  );
}

async function runToTerminal(agent: ConnectorsAgent, accepted: ExecuteResponse) {
  assert.ok(accepted.jobId, 'execute must return a jobId');
  // Poll agent_status until terminal, mirroring the orchestrator dispatcher.
  for (let i = 0; i < 50; i += 1) {
    const status = agent.status(accepted.jobId) as { terminal?: boolean; status?: string; result?: unknown };
    if (status.terminal) return status;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('job did not reach a terminal status in time');
}

test('agent_describe advertises an executor-only external-source.collect contract', () => {
  const description = newAgent().describe() as any;
  assert.equal(description.contractVersion, '1');
  assert.equal(description.orchestration.canPlan, false);
  assert.equal(description.orchestration.canExecute, true);
  assert.equal(description.orchestration.canCancel, true);
  assert.equal(description.orchestration.supportsIdempotency, true);

  const capability = description.capabilities[0];
  assert.equal(capability.id, 'external-source.collect');
  assert.equal(capability.defaultRequiresApproval, true);
  assert.equal(capability.mutationClass, 'external-source');
  assert.deepEqual(capability.supportedOperations, ['collect']);

  assert.ok(description.limits.maxConcurrency >= description.limits.recommendedConcurrency);
});

test('agent_execute collects fixture items and writes real OKF markdown via the sink', async () => {
  const { root, workspace } = await makeWorkspace();
  const scopedAgent = newAgent(root);

  const accepted = await scopedAgent.execute({
    taskId: 't-1',
    operation: 'collect',
    workspace: { name: 'demo', path: workspace },
    arguments: { label: 'inbox-batch' },
  });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.status, 'queued');

  const status = (await runToTerminal(scopedAgent, accepted)) as any;
  assert.equal(status.status, 'succeeded');
  assert.equal(status.result.written.length, 1);

  const dir = path.join(workspace, 'raw', 'untracked', 'connectors', 'fixture');
  const files = await readdir(dir);
  assert.equal(files.length, 1);
  const content = await readFile(path.join(dir, files[0]!), 'utf8');
  assert.match(content, /^---\ntype: "connector-fixture"/);
  assert.match(content, /# inbox-batch/);
});

test('idempotencyKey deduplicates: same key returns the same job, no second write', async () => {
  const { root, workspace, dataDir } = await makeWorkspace();
  const agent = newAgent(root, dataDir);
  const request = {
    taskId: 't-2',
    idempotencyKey: 'key-abc',
    operation: 'collect' as const,
    workspace: { name: 'demo', path: workspace },
    arguments: {
      items: [
        { logicalName: 'note-1', okf: { type: 'note', title: 'One' }, body: 'hello' },
      ],
    },
  };

  const first = await agent.execute(request);
  await runToTerminal(agent, first);

  const second = await agent.execute(request);
  assert.equal(second.idempotent, true);
  assert.equal(second.jobId, first.jobId);
  assert.equal(second.terminal, true);

  const dir = path.join(workspace, 'raw', 'untracked', 'connectors', 'fixture');
  const files = await readdir(dir);
  assert.equal(files.length, 1, 'idempotent replay must not create a second source file');
});

test('idempotency survives restart and rejects a changed payload', async () => {
  const { root, workspace, dataDir } = await makeWorkspace();
  const request = {
    idempotencyKey: 'persistent-key',
    operation: 'collect',
    workspace: { name: 'demo', path: workspace },
    arguments: {
      items: [{ logicalName: 'stable', okf: { type: 'note' }, body: 'stable' }],
    },
  };
  const firstAgent = newAgent(root, dataDir);
  const first = await firstAgent.execute(request);
  await runToTerminal(firstAgent, first);

  const restartedAgent = newAgent(root, dataDir);
  const replay = await restartedAgent.execute(request);
  assert.equal(replay.idempotent, true);
  assert.equal(replay.jobId, first.jobId);
  assert.equal(replay.status, 'succeeded');

  const mismatch = await restartedAgent.execute({
    ...request,
    arguments: {
      items: [{ logicalName: 'stable', okf: { type: 'note' }, body: 'changed' }],
    },
  });
  assert.equal(mismatch.accepted, false);
  assert.equal(mismatch.error, 'idempotency_key_payload_mismatch');
});

test('an ambiguous queued job is not executed again after restart', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'connectors-data-'));
  const firstStore = new JobStore(dataDir);
  const { job } = firstStore.create({
    operation: 'collect',
    workspace: 'demo',
    idempotencyKey: 'ambiguous-key',
    requestFingerprint: 'fingerprint',
  });

  const restartedStore = new JobStore(dataDir);
  const recovered = restartedStore.findByIdempotencyKey('demo', 'ambiguous-key');
  assert.equal(recovered?.jobId, job.jobId);
  assert.equal(recovered?.status, 'failed');
  assert.equal(recovered?.result?.error, 'interrupted_by_restart');
});

test('the same idempotency key is isolated per workspace', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'connectors-root-'));
  const dataDir = path.join(root, 'agent-data');
  for (const name of ['one', 'two']) {
    await mkdir(path.join(root, name, 'raw', 'untracked'), { recursive: true });
  }
  const agent = newAgent(root, dataDir);
  const base = {
    idempotencyKey: 'shared-key',
    operation: 'collect',
    arguments: {
      items: [{ logicalName: 'stable', okf: { type: 'note' }, body: 'stable' }],
    },
  };
  const first = await agent.execute({
    ...base,
    workspace: { name: 'one', path: path.join(root, 'one') },
  });
  const second = await agent.execute({
    ...base,
    workspace: { name: 'two', path: path.join(root, 'two') },
  });
  assert.notEqual(first.jobId, second.jobId);
  await Promise.all([runToTerminal(agent, first), runToTerminal(agent, second)]);
});

test('workspace.path cannot escape WORKSPACES_ROOT', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'connectors-root-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'connectors-outside-'));
  const rejected = await newAgent(root).execute({
    operation: 'collect',
    workspace: { name: 'outside', path: outside },
  });
  assert.equal(rejected.accepted, false);
  assert.match(String(rejected.error), /escapes the workspaces root/);
});

test('agent_status without jobId returns capability discovery status', () => {
  const status = newAgent().capabilityStatus({ capability: 'external-source.collect', operation: 'collect' }) as any;
  assert.equal(status.capability, 'external-source.collect');
  assert.equal(status.available, true);
  assert.deepEqual(status.pendingInputs, []);
});

test('agent_execute rejects an unsupported operation', async () => {
  const rejected = await newAgent().execute({ taskId: 't-3', operation: 'delete' });
  assert.equal(rejected.accepted, false);
  assert.match(String(rejected.error), /unsupported_operation/);
});

test('agent_cancel on an unknown job reports ok:false', () => {
  const result = newAgent().cancel('does-not-exist') as any;
  assert.equal(result.ok, false);
  assert.equal(result.error, 'unknown_job');
});
