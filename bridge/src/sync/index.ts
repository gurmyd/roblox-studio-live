/**
 * Rojo-lite two-way script sync between a directory and the open place, as a client of the
 * bridge's `POST /rpc` (docs/sync.md). Push (default) mirrors disk → Studio; `pull` mirrors
 * Studio → disk.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Puller } from './pull.js';
import { Pusher } from './push.js';
import { RpcClient, sleep } from './rpc.js';
import { Debouncer, watchDir, type Watcher } from './scan.js';
import { loadState } from './state.js';
import { SYNC_TUNING } from './tuning.js';

export interface SyncOptions {
  dir: string;
  port: number;
  pull?: boolean;
  once?: boolean;
  hotpatch?: boolean;
  log?: (line: string) => void;
}

export interface SyncHandle {
  stop(): Promise<void>;
  stats(): { pushed: number; pulled: number; errors: number; lastEvent?: string };
}

export { SYNC_TUNING } from './tuning.js';

const defaultLog = (line: string): void => {
  process.stderr.write(`[sync] ${line}\n`);
};

export async function startSync(opts: SyncOptions): Promise<SyncHandle> {
  const dir = path.resolve(opts.dir);
  const userLog = opts.log ?? defaultLog;
  const stats = { pushed: 0, pulled: 0, errors: 0, lastEvent: undefined as string | undefined };
  const log = (line: string): void => {
    stats.lastEvent = line;
    userLog(line);
  };
  if (opts.pull) await fsp.mkdir(dir, { recursive: true });
  const stat = await fsp.stat(dir).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`sync: ${dir} is not a directory`);

  const abort = new AbortController();
  const rpc = new RpcClient(opts.port);
  const state = await loadState(dir);
  const once = opts.once === true;
  let stopped = false;
  let inFlight: Promise<unknown> = Promise.resolve();
  let watcher: Watcher | null = null;
  let debouncer: Debouncer | null = null;
  let pollTimer: NodeJS.Timeout | null = null;

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    abort.abort();
    debouncer?.cancel();
    watcher?.close();
    if (pollTimer) clearTimeout(pollTimer);
    await inFlight.catch(() => undefined);
  };
  const handle: SyncHandle = { stop, stats: () => ({ ...stats }) };

  if (opts.pull) {
    const puller = new Puller({
      dir,
      rpc,
      state,
      log,
      signal: abort.signal,
      onPulled: (n) => {
        stats.pulled += n;
      },
      onError: () => {
        stats.errors += 1;
      },
    });
    log(`pull mode: ${dir} ← Studio (bridge http://127.0.0.1:${opts.port}/rpc)${once ? ', once' : ''}`);
    const written = await puller.pullOnce();
    if (written === null) {
      if (once) throw new Error('sync: the initial pull failed (see the log)');
    } else {
      log(`initial pull complete: ${written} file(s) written`);
    }
    if (once) return handle;
    const tick = async (): Promise<void> => {
      if (stopped) return;
      inFlight = puller.pullOnce().catch((err: unknown) => {
        stats.errors += 1;
        log(`ERROR pull tick failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      await inFlight;
      if (!stopped) pollTimer = setTimeout(() => void tick(), puller.intervalMs);
    };
    pollTimer = setTimeout(() => void tick(), puller.intervalMs);
    return handle;
  }

  const pusher = new Pusher({
    dir,
    rpc,
    state,
    log,
    hotpatch: opts.hotpatch !== false,
    signal: abort.signal,
    onPushed: (n) => {
      stats.pushed += n;
    },
    onError: () => {
      stats.errors += 1;
    },
  });
  log(`push mode: ${dir} → Studio (bridge http://127.0.0.1:${opts.port}/rpc)${once ? ', once' : ''}${opts.hotpatch === false ? ', hotpatch off' : ''}`);
  const dirty = new Set<string>();
  let flushPromise: Promise<void> | null = null;
  let backoff = SYNC_TUNING.retryBaseMs;

  // Pushes everything dirty; a retryable failure keeps the files queued and tries again with back-off
  // for as long as the sync runs (a bridge restart or a Studio reconnect never loses an edit).
  const runFlush = async (): Promise<void> => {
    while (dirty.size > 0 && !stopped) {
      const batch = [...dirty];
      dirty.clear();
      const outcome = await pusher.pushBatch(batch);
      if (outcome.retry) {
        for (const rel of batch) dirty.add(rel);
        if (stopped) return;
        log(`${dirty.size} file(s) kept for retry in ${backoff} ms`);
        await sleep(backoff, abort.signal);
        backoff = Math.min(SYNC_TUNING.retryMaxMs, backoff * 2);
      } else {
        backoff = SYNC_TUNING.retryBaseMs;
      }
    }
  };
  const flush = (): Promise<void> => {
    flushPromise ??= runFlush()
      .catch((err: unknown) => {
        stats.errors += 1;
        log(`ERROR ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        flushPromise = null;
      });
    inFlight = flushPromise;
    return flushPromise;
  };

  const initial = await pusher.pushAll();
  if (initial.retry && once) throw new Error('sync: the initial push failed (see the log)');
  if (once) return handle;
  if (initial.retry) {
    log('initial push failed; every file stays queued and is retried until the bridge answers');
    for (const rel of pusher.knownFiles()) dirty.add(rel);
    void flush();
  }

  // fs.watch → debounce → rescan (stat + hash) → push the files whose content actually changed.
  debouncer = new Debouncer(SYNC_TUNING.debounceMs, () => {
    void (async () => {
      try {
        for (const rel of await pusher.detectChanges()) dirty.add(rel);
      } catch (err) {
        stats.errors += 1;
        log(`ERROR rescan failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (dirty.size > 0) void flush();
    })();
  });
  const d = debouncer;
  watcher = watchDir(dir, () => d.trigger(), SYNC_TUNING.fsPollMs);
  return handle;
}
