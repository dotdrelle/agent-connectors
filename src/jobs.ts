import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set([
  'succeeded',
  'failed',
  'cancelled',
]);

export type JobResult = {
  status: JobStatus;
  written?: string[];
  skipped?: string[];
  /** Outcome of a communication.send-email task (never the message content). */
  sent?: {
    messageId?: string;
    threadId?: string;
    recipients: number;
    dryRun?: boolean;
    bytes?: number;
  };
  error?: string;
};

export type Job = {
  jobId: string;
  taskId?: string;
  operation: string;
  workspace: string;
  idempotencyKey?: string;
  requestFingerprint: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  result?: JobResult;
  done: Promise<Job>;
  cancelRequested: boolean;
};

type PersistedJob = Omit<Job, 'done' | 'cancelRequested'>;
type PersistedStore = { version: 1; jobs: PersistedJob[] };

/**
 * Workspace-scoped persistent job registry.
 *
 * Each workspace owns `<dataDir>/<workspace>/jobs/jobs.json`. Writes use a
 * synced temporary file followed by rename. Jobs found queued/running after a
 * process restart become terminal failures: their outcome is ambiguous, so
 * replaying the same idempotency key must never launch a second collection.
 */
export class JobStore {
  readonly #dataDir: string;
  #jobs = new Map<string, Job>();
  #byIdempotencyKey = new Map<string, string>();

  constructor(dataDir: string) {
    this.#dataDir = path.resolve(dataDir);
    mkdirSync(this.#dataDir, { recursive: true });
    this.#load();
  }

  create(input: {
    taskId?: string;
    operation: string;
    workspace: string;
    idempotencyKey?: string;
    requestFingerprint: string;
  }): { job: Job; settle: (result: JobResult) => void } {
    const now = new Date().toISOString();
    let resolveDone!: (job: Job) => void;
    const done = new Promise<Job>((resolve) => {
      resolveDone = resolve;
    });
    const job: Job = {
      jobId: randomUUID(),
      taskId: input.taskId,
      operation: input.operation,
      workspace: input.workspace,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      cancelRequested: false,
      done,
    };
    const settle = (result: JobResult) => {
      const current = this.#jobs.get(job.jobId);
      if (!current || TERMINAL_STATUSES.has(current.status)) return;
      current.status = result.status;
      current.result = result;
      current.updatedAt = new Date().toISOString();
      this.#persistWorkspace(current.workspace);
      resolveDone(current);
    };
    this.#jobs.set(job.jobId, job);
    if (input.idempotencyKey) {
      this.#byIdempotencyKey.set(this.#scope(input.workspace, input.idempotencyKey), job.jobId);
    }
    this.#persistWorkspace(job.workspace);
    return { job, settle };
  }

  get(jobId: string): Job | undefined {
    return this.#jobs.get(jobId);
  }

  findByIdempotencyKey(workspace: string, key: string): Job | undefined {
    const jobId = this.#byIdempotencyKey.get(this.#scope(workspace, key));
    return jobId ? this.#jobs.get(jobId) : undefined;
  }

  markRunning(jobId: string): void {
    const job = this.#jobs.get(jobId);
    if (job && job.status === 'queued') {
      job.status = 'running';
      job.updatedAt = new Date().toISOString();
      this.#persistWorkspace(job.workspace);
    }
  }

  requestCancel(jobId: string): Job | undefined {
    const job = this.#jobs.get(jobId);
    if (job && !TERMINAL_STATUSES.has(job.status)) {
      job.cancelRequested = true;
      job.updatedAt = new Date().toISOString();
      this.#persistWorkspace(job.workspace);
    }
    return job;
  }

  list(): Job[] {
    return [...this.#jobs.values()];
  }

  #scope(workspace: string, key: string): string {
    return `${workspace}\u0000${key}`;
  }

  #storePath(workspace: string): string {
    return path.join(this.#dataDir, workspace, 'jobs', 'jobs.json');
  }

  #persistWorkspace(workspace: string): void {
    const filePath = this.#storePath(workspace);
    mkdirSync(path.dirname(filePath), { recursive: true });
    const payload: PersistedStore = {
      version: 1,
      jobs: [...this.#jobs.values()]
        .filter((job) => job.workspace === workspace)
        .map(({ done: _done, cancelRequested: _cancelRequested, ...job }) => job),
    };
    atomicWriteJson(filePath, payload);
  }

  #load(): void {
    if (!existsSync(this.#dataDir)) return;
    for (const workspace of readdirSync(this.#dataDir, { withFileTypes: true })) {
      if (!workspace.isDirectory()) continue;
      const filePath = this.#storePath(workspace.name);
      if (!existsSync(filePath)) continue;
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as PersistedStore;
      if (parsed.version !== 1 || !Array.isArray(parsed.jobs)) {
        throw new Error(`Unsupported job store format: ${filePath}`);
      }
      let changed = false;
      for (const persisted of parsed.jobs) {
        if (persisted.workspace !== workspace.name) {
          throw new Error(`Job workspace mismatch in ${filePath}`);
        }
        if (this.#jobs.has(persisted.jobId)) {
          throw new Error(`Duplicate persisted job id: ${persisted.jobId}`);
        }
        if (!TERMINAL_STATUSES.has(persisted.status)) {
          persisted.status = 'failed';
          persisted.result = { status: 'failed', error: 'interrupted_by_restart' };
          persisted.updatedAt = new Date().toISOString();
          changed = true;
        }
        let resolveDone!: (job: Job) => void;
        const done = new Promise<Job>((resolve) => {
          resolveDone = resolve;
        });
        const job: Job = {
          ...persisted,
          cancelRequested: false,
          done,
        };
        this.#jobs.set(job.jobId, job);
        if (job.idempotencyKey) {
          this.#byIdempotencyKey.set(
            this.#scope(job.workspace, job.idempotencyKey),
            job.jobId,
          );
        }
        resolveDone(job);
      }
      if (changed) this.#persistWorkspace(workspace.name);
    }
  }
}

function atomicWriteJson(filePath: string, payload: PersistedStore): void {
  const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  let fd: number | undefined;
  try {
    fd = openSync(tempPath, 'wx', 0o600);
    writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, filePath);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    rmSync(tempPath, { force: true });
    throw error;
  }
}
