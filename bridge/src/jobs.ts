import type { JsonValue, ResError } from './protocol.js';

export const JOB_EXPIRY_MS = 10 * 60 * 1000;
export const MAX_PROGRESS_NOTES = 50;
export const MAX_JOB_WAIT_MS = 50_000;
export const JOB_LIST_LIMIT = 50;

export type JobStatus = 'running' | 'done' | 'error';
/** Which client created the job: the MCP stdio session of this process, or another process via POST /rpc. */
export type JobOrigin = 'stdio' | 'rpc';

export interface ProgressNote {
  t: number;
  note?: string;
  pct?: number;
}

export interface JobSnapshot {
  job_id: string;
  status: JobStatus;
  op: string;
  dm: string;
  session: string;
  origin: JobOrigin;
  started_ms: number;
  finished_ms?: number;
  elapsed_ms: number;
  cancel_requested: boolean;
  progress?: ProgressNote;
  notes: ProgressNote[];
  result?: JsonValue;
  error?: ResError;
  /** `dm` reported by the responder (e.g. `client:1` when the request said `client`). */
  responder?: string;
}

export interface JobInit {
  id: string;
  op: string;
  dm: string;
  session: string;
  origin: JobOrigin;
  /** Sends the `cancel` frame; called at most once, only while running. */
  onCancel: () => void;
}

/** One in-flight (or recently finished) request. */
export class Job {
  readonly id: string;
  readonly op: string;
  readonly dm: string;
  readonly session: string;
  readonly origin: JobOrigin;
  readonly startedAt: number;
  readonly notes: ProgressNote[] = [];
  finishedAt: number | null = null;
  result: JsonValue | undefined = undefined;
  error: ResError | undefined = undefined;
  responder: string | undefined = undefined;
  cancelRequested = false;

  private readonly onCancel: () => void;
  private readonly waiters = new Set<() => void>();
  private readonly finishHooks: Array<(job: Job) => void> = [];

  constructor(init: JobInit) {
    this.id = init.id;
    this.op = init.op;
    this.dm = init.dm;
    this.session = init.session;
    this.origin = init.origin;
    this.onCancel = init.onCancel;
    this.startedAt = Date.now();
  }

  get status(): JobStatus {
    if (this.finishedAt === null) return 'running';
    return this.error ? 'error' : 'done';
  }

  get running(): boolean {
    return this.finishedAt === null;
  }

  complete(result: JsonValue | undefined, responder?: string): void {
    if (!this.running) return;
    this.result = result;
    this.responder = responder;
    this.finish();
  }

  fail(error: ResError, responder?: string): void {
    if (!this.running) return;
    this.error = error;
    this.responder = responder;
    this.finish();
  }

  note(note: string | undefined, pct: number | undefined): void {
    if (!this.running) return;
    const entry: ProgressNote = { t: Date.now() };
    if (note !== undefined) entry.note = note;
    if (pct !== undefined) entry.pct = pct;
    this.notes.push(entry);
    if (this.notes.length > MAX_PROGRESS_NOTES) this.notes.splice(0, this.notes.length - MAX_PROGRESS_NOTES);
  }

  /** Asks the executor to stop; the job finishes when the hub answers `cancelled` (or the deadline hits). */
  cancel(): boolean {
    if (!this.running || this.cancelRequested) return false;
    this.cancelRequested = true;
    this.onCancel();
    return true;
  }

  /** Resolves true once the job has finished, false if `ms` elapsed first. */
  wait(ms: number): Promise<boolean> {
    if (!this.running) return Promise.resolve(true);
    if (ms <= 0) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.waiters.delete(done);
        resolve(false);
      }, ms);
      this.waiters.add(done);
    });
  }

  onFinish(hook: (job: Job) => void): void {
    if (!this.running) {
      hook(this);
      return;
    }
    this.finishHooks.push(hook);
  }

  snapshot(): JobSnapshot {
    const now = this.finishedAt ?? Date.now();
    const snap: JobSnapshot = {
      job_id: this.id,
      status: this.status,
      op: this.op,
      dm: this.dm,
      session: this.session,
      origin: this.origin,
      started_ms: this.startedAt,
      elapsed_ms: now - this.startedAt,
      cancel_requested: this.cancelRequested,
      notes: [...this.notes],
    };
    if (this.finishedAt !== null) snap.finished_ms = this.finishedAt;
    const last = this.notes[this.notes.length - 1];
    if (last) snap.progress = last;
    if (this.result !== undefined) snap.result = this.result;
    if (this.error) snap.error = this.error;
    if (this.responder) snap.responder = this.responder;
    return snap;
  }

  private finish(): void {
    this.finishedAt = Date.now();
    for (const hook of this.finishHooks.splice(0)) hook(this);
    for (const waiter of [...this.waiters]) waiter();
  }
}

/** Compact row for `job list`: enough to find a job id without the result payload. */
export interface JobListEntry {
  job_id: string;
  status: JobStatus;
  op: string;
  dm: string;
  session: string;
  origin: JobOrigin;
  started_ms: number;
  elapsed_ms: number;
  cancel_requested: boolean;
  progress?: ProgressNote;
  error_code?: string;
}

/** Registry of jobs; finished jobs expire JOB_EXPIRY_MS after completion. */
export class JobStore {
  private readonly jobs = new Map<string, Job>();
  private readonly expiryTimers = new Map<string, NodeJS.Timeout>();

  create(init: JobInit): Job {
    if (this.jobs.has(init.id)) throw new Error(`duplicate job id ${init.id}`);
    const job = new Job(init);
    this.jobs.set(init.id, job);
    job.onFinish(() => this.scheduleExpiry(job.id));
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  get size(): number {
    return this.jobs.size;
  }

  running(): Job[] {
    return [...this.jobs.values()].filter((job) => job.running);
  }

  /** Running jobs first, then the most recently finished ones, newest first. */
  list(limit: number = JOB_LIST_LIMIT): JobListEntry[] {
    const rows = [...this.jobs.values()]
      .sort((a, b) => Number(b.running) - Number(a.running) || b.startedAt - a.startedAt)
      .slice(0, limit);
    return rows.map((job) => {
      const snap = job.snapshot();
      const entry: JobListEntry = {
        job_id: snap.job_id,
        status: snap.status,
        op: snap.op,
        dm: snap.responder ?? snap.dm,
        session: snap.session,
        origin: snap.origin,
        started_ms: snap.started_ms,
        elapsed_ms: snap.elapsed_ms,
        cancel_requested: snap.cancel_requested,
      };
      if (snap.progress) entry.progress = snap.progress;
      if (snap.error) entry.error_code = snap.error.code;
      return entry;
    });
  }

  /**
   * Waits until no running job satisfies `filter`, or `maxMs` elapses.
   * Returns the jobs still running when it gave up (empty when fully drained).
   */
  async drain(filter: (job: Job) => boolean, maxMs: number): Promise<Job[]> {
    const deadline = Date.now() + maxMs;
    for (;;) {
      const pending = this.running().filter(filter);
      const remaining = deadline - Date.now();
      if (pending.length === 0 || remaining <= 0) return pending;
      await Promise.race(pending.map((job) => job.wait(remaining)));
    }
  }

  close(): void {
    for (const timer of this.expiryTimers.values()) clearTimeout(timer);
    this.expiryTimers.clear();
    this.jobs.clear();
  }

  private scheduleExpiry(id: string): void {
    const timer = setTimeout(() => {
      this.expiryTimers.delete(id);
      this.jobs.delete(id);
    }, JOB_EXPIRY_MS);
    timer.unref();
    this.expiryTimers.set(id, timer);
  }
}
