/**
 * Push direction: disk → open place. One `run` per batch (one undo step), optional
 * hot-patch into a running playtest for server-side scripts.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { isHotpatchable, mapFiles, type FileEntry } from './layout.js';
import { pushRunArgs, splitBatches, type PushItem, type PushOutcome, type PushResult } from './luau.js';
import { callWithRetry, type RpcClient, type RpcOutcome } from './rpc.js';
import { scanDir, type ScannedFile } from './scan.js';
import { hashSource, normalizeSource, saveState, type SyncState } from './state.js';
import { SYNC_TUNING } from './tuning.js';

export interface PusherDeps {
  dir: string;
  rpc: RpcClient;
  state: SyncState;
  log: (line: string) => void;
  hotpatch: boolean;
  signal: AbortSignal;
  onPushed: (count: number) => void;
  onError: () => void;
}

export interface PushBatchOutcome {
  /** True when the batch must stay dirty and be retried later. */
  retry: boolean;
  pushed: number;
}

interface Snapshot extends ScannedFile {
  hash: string | null;
}

export class Pusher {
  /** Last known files with their content hash (null = not read yet). */
  private snapshot = new Map<string, Snapshot>();
  private warnedIssues = new Set<string>();

  constructor(private readonly deps: PusherDeps) {}

  /** Initial scan: every file is pushed (the program skips unchanged ones). */
  async pushAll(): Promise<PushBatchOutcome> {
    const files = await scanDir(this.deps.dir);
    this.snapshot = new Map([...files].map(([rel, f]) => [rel, { ...f, hash: null }]));
    return this.pushBatch([...files.keys()]);
  }

  /** Files seen by the last scan. */
  knownFiles(): string[] {
    return [...this.snapshot.keys()];
  }

  /**
   * Rescans the directory, returns the files whose content changed since the snapshot
   * (new files included) and warns about deletions, which are never propagated.
   */
  async detectChanges(): Promise<string[]> {
    const files = await scanDir(this.deps.dir);
    const changed: string[] = [];
    for (const [rel, file] of files) {
      const prev = this.snapshot.get(rel);
      if (prev && prev.hash !== null && prev.mtimeMs === file.mtimeMs && prev.size === file.size) continue;
      const hash = await this.readHash(rel);
      if (hash === null) continue;
      if (!prev || prev.hash !== hash) changed.push(rel);
      this.snapshot.set(rel, { ...file, hash });
    }
    for (const rel of [...this.snapshot.keys()]) {
      if (files.has(rel)) continue;
      this.snapshot.delete(rel);
      delete this.deps.state.files[rel];
      this.deps.log(`WARN deleted on disk: ${rel} — deletions are not propagated to Studio (deleteOrphans is not implemented); remove the instance in Studio yourself`);
    }
    return changed;
  }

  private async readHash(rel: string): Promise<string | null> {
    try {
      const text = await fsp.readFile(path.join(this.deps.dir, ...rel.split('/')), 'utf8');
      return hashSource(normalizeSource(text));
    } catch {
      return null;
    }
  }

  private async readItem(entry: FileEntry): Promise<PushItem | null> {
    let text: string;
    try {
      text = await fsp.readFile(path.join(this.deps.dir, ...entry.rel.split('/')), 'utf8');
    } catch (err) {
      this.deps.log(`WARN cannot read ${entry.rel}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    const src = normalizeSource(text);
    const snap = this.snapshot.get(entry.rel);
    if (snap) snap.hash = hashSource(src);
    return {
      rel: entry.rel,
      service: entry.service,
      parents: entry.parents,
      name: entry.name,
      class: entry.class,
      src,
      prev: this.deps.state.files[entry.rel]?.hash ?? null,
    };
  }

  /** Pushes the given files (relative paths) in as many programs as the 400 KB cap requires. */
  async pushBatch(rels: readonly string[]): Promise<PushBatchOutcome> {
    if (rels.length === 0) return { retry: false, pushed: 0 };
    const allRels = [...new Set([...this.snapshot.keys(), ...rels])];
    const layout = mapFiles(allRels);
    for (const issue of layout.issues) {
      const key = `${issue.rel}|${issue.reason}`;
      if (this.warnedIssues.has(key)) continue;
      this.warnedIssues.add(key);
      this.deps.log(`WARN ${issue.rel}: ${issue.reason}`);
    }
    const items: PushItem[] = [];
    for (const rel of rels) {
      const entry = layout.entries.get(rel);
      if (!entry) continue;
      const item = await this.readItem(entry);
      if (item) items.push(item);
    }
    // Parents before children so a new init directory exists before its members are placed.
    items.sort((a, b) => a.parents.length - b.parents.length || a.rel.localeCompare(b.rel));
    if (items.length === 0) return { retry: false, pushed: 0 };

    let pushed = 0;
    let retry = false;
    for (const batch of splitBatches(items, SYNC_TUNING.maxProgramBytes)) {
      const outcome = await this.runBatch(batch, layout);
      if (outcome.retry) retry = true;
      pushed += outcome.pushed;
    }
    return { retry, pushed };
  }

  private async runBatch(items: PushItem[], layout: ReturnType<typeof mapFiles>, depth = 0): Promise<PushBatchOutcome> {
    const t0 = Date.now();
    const outcome = await callWithRetry(this.deps.rpc, 'run', pushRunArgs(items), {
      budgetMs: SYNC_TUNING.retryBudgetMs,
      baseMs: SYNC_TUNING.retryBaseMs,
      maxMs: SYNC_TUNING.retryMaxMs,
      signal: this.deps.signal,
      onRetry: (failure, attempt, delay) => {
        if (attempt === 1 || attempt % 5 === 0) this.deps.log(`bridge not ready (${failure.code}: ${failure.message}); retrying in ${delay} ms`);
      },
      // The run outlived the tool's wait (queued behind a long program, or thousands of scripts):
      // follow the job instead of re-sending the same batch behind itself.
      onJob: (jobId) => this.deps.log(`push of ${items.length} file(s) is still running in Studio as job ${jobId}; waiting for it`),
    });
    if (!outcome.ok) {
      // `not_found` after a job handle: the bridge restarted while the push ran; its fate is unknown, so retry
      // (the program skips unchanged scripts, so a repeat is harmless).
      const retry = outcome.code !== 'cancelled' && (outcome.transport || outcome.code === 'not_found' || isRetryableCode(outcome.code));
      this.deps.log(`ERROR push of ${items.length} file(s) failed (${outcome.code}): ${outcome.message}${retry ? ' — will retry' : ''}`);
      this.deps.onError();
      return { retry, pushed: 0 };
    }
    const result = outcome.value.value as (Partial<PushResult> & { truncated?: unknown }) | undefined;
    if (!result || !Array.isArray(result.outcomes)) {
      this.deps.log(`ERROR push program returned an unexpected value: ${JSON.stringify(outcome.value).slice(0, 300)}`);
      this.deps.onError();
      return { retry: false, pushed: 0 };
    }
    const pushedItems: PushItem[] = [];
    const unreported: PushItem[] = [];
    items.forEach((item, i) => {
      const o = result.outcomes?.[i];
      if (!isPushOutcome(o)) {
        // Cut by the bridge's result budget (a `…[+N more]` marker) or missing: the script was pushed but
        // its outcome is unknown, so it stays dirty and the next run records it (as `unchanged`).
        unreported.push(item);
        return;
      }
      if (o === 'skipped') {
        const why = result.skipped?.find((s) => s.i === i + 1)?.why ?? 'skipped';
        this.deps.log(`WARN ${item.rel}: ${why}`);
        return;
      }
      this.deps.state.files[item.rel] = { hash: hashSource(item.src), mtime: this.snapshot.get(item.rel)?.mtimeMs ?? Date.now() };
      // On a re-check (depth > 0) `unchanged` means "written by the program whose outcome was cut": still a push.
      if (o !== 'unchanged' || depth > 0) pushedItems.push(item);
    });
    if (unreported.length > 0 || result.truncated === true) {
      this.deps.log(`WARN push result was truncated: ${unreported.length} of ${items.length} outcome(s) missing; re-checking those files now`);
    }
    for (const i of result.conflicts ?? []) {
      const item = items[i - 1];
      if (item) this.deps.log(`WARN conflict: ${item.rel} — Studio's copy changed since the last sync; the disk version was pushed (push mode: disk wins)`);
    }
    if ((result.overwrote?.length ?? 0) > 0) {
      const names = (result.overwrote ?? []).map((i) => items[i - 1]?.rel ?? `#${i}`);
      this.deps.log(`note: ${names.length} Studio script(s) had no sync record and were replaced by the disk copy: ${names.slice(0, 5).join(', ')}${names.length > 5 ? ', …' : ''}`);
    }
    const undo = typeof outcome.value.undo === 'string' ? outcome.value.undo : 'n/a';
    this.deps.log(
      `pushed ${items.length} file(s) in ${Date.now() - t0} ms: created ${result.created ?? 0}, updated ${result.updated ?? 0}, replaced ${result.replaced ?? 0}, unchanged ${result.unchanged ?? 0}, parents ${result.parents ?? 0}, undo ${undo}`,
    );
    try {
      await saveState(this.deps.dir, this.deps.state);
    } catch (err) {
      this.deps.log(`WARN cannot write sync state: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.deps.onPushed(pushedItems.length);
    if (pushedItems.length > 0) await this.hotpatch(pushedItems, layout);
    if (unreported.length > 0 && depth === 0) {
      // Their sources are already in Studio; a second, smaller program answers `unchanged` and records them.
      const again = await this.runBatch(unreported, layout, depth + 1);
      return { retry: again.retry, pushed: pushedItems.length + again.pushed };
    }
    return { retry: unreported.length > 0, pushed: pushedItems.length };
  }

  /** Server-side Scripts / ModuleScripts go into the live play-server DM when a playtest is running. */
  private async hotpatch(items: PushItem[], layout: ReturnType<typeof mapFiles>): Promise<void> {
    if (!this.deps.hotpatch) return;
    const status = await this.deps.rpc.call('observe', { what: 'status' }, { signal: this.deps.signal });
    if (!status.ok) return;
    const playtest = status.value.playtest as { running?: unknown } | undefined;
    if (playtest?.running !== true) return;
    const eligible: FileEntry[] = [];
    const clientSide: string[] = [];
    for (const item of items) {
      const entry = layout.entries.get(item.rel);
      if (!entry) continue;
      if (isHotpatchable(entry)) eligible.push(entry);
      else clientSide.push(item.rel);
    }
    if (clientSide.length > 0) {
      this.deps.log(`playtest running: ${clientSide.length} client-side script(s) not hot-applied (existing clients cannot be reached): ${clientSide.slice(0, 5).join(', ')}${clientSide.length > 5 ? ', …' : ''}`);
    }
    for (const entry of eligible) {
      const item = items.find((i) => i.rel === entry.rel);
      if (!item) continue;
      const res: RpcOutcome = await this.deps.rpc.call(
        'playtest',
        { action: 'hotpatch', dm: 'server', path: entry.instancePath, source: item.src, restart: true },
        { signal: this.deps.signal },
      );
      if (!res.ok) {
        this.deps.log(`WARN hotpatch ${entry.instancePath} failed (${res.code}): ${res.message}`);
        continue;
      }
      const note = typeof res.value.note === 'string' ? ` (${res.value.note})` : '';
      this.deps.log(`hotpatched ${entry.instancePath} in the play server${note}`);
    }
  }
}

function isRetryableCode(code: string): boolean {
  return code === 'no_session' || code === 'busy' || code === 'timeout' || code === 'disconnected' || code === 'unreachable' || code === 'proxy_unreachable';
}

const PUSH_OUTCOMES: ReadonlySet<string> = new Set(['created', 'updated', 'unchanged', 'replaced', 'skipped']);

function isPushOutcome(value: unknown): value is PushOutcome {
  return typeof value === 'string' && PUSH_OUTCOMES.has(value);
}
