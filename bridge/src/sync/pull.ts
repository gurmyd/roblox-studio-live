/**
 * Pull direction: open place → disk. A checksum listing decides what to fetch; sources
 * travel as ≤ 4 KB slices inside small pages so the bridge never truncates them.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileOfInstance, type ScriptClass } from './layout.js';
import { FETCH_BUDGET_BYTES, FETCH_PART_BYTES, LIST_PAGE, fetchRunArgs, listRunArgs, type FetchItem, type FetchRequest, type ListItem } from './luau.js';
import { callWithRetry, type RpcClient, type RpcOutcome } from './rpc.js';
import { hashSource, normalizeSource, saveState, writeFileAtomic, type SyncState } from './state.js';
import { SYNC_TUNING } from './tuning.js';

export interface PullerDeps {
  dir: string;
  rpc: RpcClient;
  state: SyncState;
  log: (line: string) => void;
  signal: AbortSignal;
  onPulled: (count: number) => void;
  onError: () => void;
}

interface RemoteScript {
  names: string[];
  class: ScriptClass;
  hash: string;
  rel: string;
}

const TRUNCATION_MARK = /…\[\+\d+( chars| more)?\]$/u;
/** Smallest listing page tried before giving up on a bridge that truncates everything. */
export const LIST_PAGE_MIN = 10;

export class Puller {
  private warned = new Set<string>();
  private budget = FETCH_BUDGET_BYTES;
  /** Listing page size; halved whenever the bridge cut a page to its result budget. */
  private listPage = LIST_PAGE;
  /** Set when a poll took long enough to stretch the interval. */
  intervalMs = SYNC_TUNING.pollMs;

  constructor(private readonly deps: PullerDeps) {}

  private warnOnce(key: string, line: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.deps.log(line);
  }

  private retryPolicy() {
    return {
      budgetMs: SYNC_TUNING.retryBudgetMs,
      baseMs: SYNC_TUNING.retryBaseMs,
      maxMs: SYNC_TUNING.retryMaxMs,
      signal: this.deps.signal,
      onRetry: (failure: Extract<RpcOutcome, { ok: false }>, attempt: number, delay: number) => {
        if (attempt === 1 || attempt % 5 === 0) this.deps.log(`bridge not ready (${failure.code}: ${failure.message}); retrying in ${delay} ms`);
      },
      // A dry_run refused for lack of a ChangeHistory recording stays refused while the playtest runs.
      retryIf: (failure: Extract<RpcOutcome, { ok: false }>) => !isDryRunRefusal(failure),
    };
  }

  /**
   * Runs one of the read-only programs as a dry run (the recording is always cancelled, so the
   * poll leaves no undo waypoint); while a playtest runs no recording can be opened and the
   * program runs without one instead (it changes nothing either way).
   */
  private async readOnlyRun(args: Record<string, unknown>): Promise<RpcOutcome> {
    if (!this.dryRunRefused) {
      const outcome = await callWithRetry(this.deps.rpc, 'run', args, this.retryPolicy());
      if (outcome.ok || !isDryRunRefusal(outcome)) return outcome;
      this.dryRunRefused = true;
    }
    const outcome = await callWithRetry(this.deps.rpc, 'run', { ...args, dry_run: false }, this.retryPolicy());
    // Try dry runs again on the next pass in case the playtest has ended.
    this.dryRunRefused = false;
    return outcome;
  }

  private dryRunRefused = false;

  /** Lists every script with its checksum, paging through the deterministic walk. */
  async listRemote(): Promise<Map<string, RemoteScript> | null> {
    const items: ListItem[] = [];
    let offset = 0;
    let slowest = 0;
    for (;;) {
      const outcome = await this.readOnlyRun(listRunArgs(offset, this.listPage));
      if (!outcome.ok) {
        this.deps.log(`ERROR listing scripts failed (${outcome.code}): ${outcome.message}`);
        this.deps.onError();
        return null;
      }
      const value = outcome.value.value as { total?: unknown; items?: unknown; truncated?: unknown } | undefined;
      const raw: unknown[] = Array.isArray(value?.items) ? value.items : [];
      // The bridge cuts big pages to its result budget (`truncated: true`, a `…[+N more]` string inside
      // items): advancing past such a page would silently skip the scripts it dropped.
      if (value?.truncated === true || raw.some((item) => typeof item !== 'object' || item === null)) {
        if (this.listPage <= LIST_PAGE_MIN) {
          this.deps.log(`ERROR the bridge truncates even ${LIST_PAGE_MIN}-item listing pages; cannot list scripts`);
          this.deps.onError();
          return null;
        }
        this.listPage = Math.max(LIST_PAGE_MIN, Math.floor(this.listPage / 2));
        this.deps.log(`listing page was truncated by the bridge; retrying with ${this.listPage}-item pages`);
        continue;
      }
      const page = raw as ListItem[];
      const total = typeof value?.total === 'number' ? value.total : page.length;
      if (typeof outcome.value.duration_ms === 'number') slowest = Math.max(slowest, outcome.value.duration_ms);
      items.push(...page);
      offset += page.length;
      if (page.length === 0 || offset >= total) break;
    }
    if (slowest > SYNC_TUNING.slowPollMs) {
      const stretched = Math.min(30_000, Math.max(SYNC_TUNING.pollMs, Math.round(slowest * 20)));
      if (stretched !== this.intervalMs) {
        this.intervalMs = stretched;
        this.deps.log(`listing takes ${Math.round(slowest)} ms in Studio; polling every ${stretched} ms`);
      }
    }
    return this.toRemote(items);
  }

  private toRemote(items: ListItem[]): Map<string, RemoteScript> {
    const chains = new Set(items.map((i) => i.n.join('\0')));
    const hasScriptDescendant = (names: string[]): boolean => {
      const prefix = `${names.join('\0')}\0`;
      for (const chain of chains) if (chain.startsWith(prefix)) return true;
      return false;
    };
    const out = new Map<string, RemoteScript>();
    for (const item of items) {
      if (!Array.isArray(item.n) || typeof item.c !== 'string' || typeof item.h !== 'string') continue;
      const file = fileOfInstance(item.n, item.c, hasScriptDescendant(item.n));
      if (!file.ok) {
        this.warnOnce(`map:${item.n.join('.')}`, `WARN cannot map ${item.n.join('.')} to a file: ${file.reason}`);
        continue;
      }
      const existing = out.get(file.rel);
      if (existing) {
        this.warnOnce(`dup:${file.rel}`, `WARN ${item.n.join('.')} and ${existing.names.join('.')} both map to ${file.rel}; keeping the first`);
        continue;
      }
      out.set(file.rel, { names: item.n, class: item.c, hash: item.h, rel: file.rel });
    }
    return out;
  }

  /** One full pass: list, fetch what differs from the sync record, write. Returns files written or null on failure. */
  async pullOnce(): Promise<number | null> {
    const remote = await this.listRemote();
    if (!remote) return null;
    const toFetch: RemoteScript[] = [];
    for (const script of remote.values()) {
      const record = this.deps.state.files[script.rel];
      const abs = path.join(this.deps.dir, ...script.rel.split('/'));
      const localHash = await this.localHash(abs);
      if (record && record.hash === script.hash && localHash === script.hash) continue;
      if (localHash === script.hash) {
        // Disk already matches Studio (e.g. a first pull into a Rojo checkout): just record it.
        this.deps.state.files[script.rel] = { hash: script.hash, mtime: await mtimeOf(abs) };
        continue;
      }
      if (record && localHash !== null && localHash !== record.hash && script.hash !== record.hash) {
        this.deps.log(`WARN conflict: ${script.rel} — both the file and Studio's copy changed since the last sync; Studio's version wins (pull mode)`);
      } else if (record && localHash !== null && localHash !== record.hash && script.hash === record.hash) {
        // Local edit, Studio unchanged: nothing to pull; the file is left alone.
        continue;
      } else if (!record && localHash !== null) {
        this.deps.log(`WARN ${script.rel}: no sync record and the file differs from Studio; Studio's version wins (pull mode)`);
      }
      toFetch.push(script);
    }
    for (const rel of Object.keys(this.deps.state.files)) {
      if (remote.has(rel)) continue;
      const abs = path.join(this.deps.dir, ...rel.split('/'));
      if (await exists(abs)) {
        this.warnOnce(`gone:${rel}`, `WARN ${rel}: the script no longer exists in Studio; the file is kept (deletions are not propagated)`);
      } else {
        delete this.deps.state.files[rel];
      }
    }
    const written = toFetch.length === 0 ? 0 : await this.fetchAndWrite(toFetch);
    if (written === null) return null;
    try {
      await saveState(this.deps.dir, this.deps.state);
    } catch (err) {
      this.deps.log(`WARN cannot write sync state: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (written > 0) this.deps.onPulled(written);
    return written;
  }

  private async fetchAndWrite(scripts: RemoteScript[]): Promise<number | null> {
    const pending = new Map<string, { script: RemoteScript; from: number; parts: string[]; class?: ScriptClass; hash?: string }>();
    for (const s of scripts) pending.set(s.names.join('\0'), { script: s, from: 1, parts: [] });
    let written = 0;
    let guard = 0;
    while (pending.size > 0) {
      if (this.deps.signal.aborted) return null;
      if (++guard > 10_000) {
        this.deps.log('ERROR fetch did not converge; giving up on this pass');
        this.deps.onError();
        return null;
      }
      const reqs: FetchRequest[] = [];
      for (const p of pending.values()) {
        reqs.push(p.from > 1 ? { n: p.script.names, from: p.from } : { n: p.script.names });
        if (reqs.length >= LIST_PAGE) break;
      }
      const outcome = await this.readOnlyRun(fetchRunArgs(reqs, this.budget, FETCH_PART_BYTES));
      if (!outcome.ok) {
        this.deps.log(`ERROR fetching ${reqs.length} script(s) failed (${outcome.code}): ${outcome.message}`);
        this.deps.onError();
        return null;
      }
      const value = outcome.value.value as { items?: unknown; truncated?: unknown } | undefined;
      const items = Array.isArray(value?.items) ? (value.items as FetchItem[]) : [];
      if (value?.truncated === true || items.some((i) => (i.parts ?? []).some((p) => TRUNCATION_MARK.test(p)))) {
        // The bridge cut the result to its budget: ask for less per call and try again.
        if (this.budget <= 2000) {
          this.deps.log('ERROR the bridge truncates even the smallest fetch page; cannot pull sources');
          this.deps.onError();
          return null;
        }
        this.budget = Math.max(2000, Math.floor(this.budget / 2));
        this.deps.log(`fetch page was truncated by the bridge; retrying with ${this.budget}-byte pages`);
        continue;
      }
      if (items.length === 0) {
        this.deps.log('ERROR fetch returned no items');
        this.deps.onError();
        return null;
      }
      for (const item of items) {
        const key = (item.n ?? []).join('\0');
        const p = pending.get(key);
        if (!p) continue;
        if (item.missing) {
          this.warnOnce(`missing:${p.script.rel}`, `WARN ${p.script.rel}: script disappeared before it could be read`);
          pending.delete(key);
          continue;
        }
        if (typeof item.from === 'number' && item.from !== p.from) continue; // stale answer, ask again
        p.parts.push(...(item.parts ?? []));
        if (item.c) p.class = item.c;
        if (item.h) p.hash = item.h;
        if (item.eof === true) {
          pending.delete(key);
          if (await this.writeScript(p.script, p.parts.join(''), p.hash ?? null)) written += 1;
        } else if (typeof item.next === 'number' && item.next > p.from) {
          p.from = item.next;
        } else {
          this.warnOnce(`stuck:${p.script.rel}`, `WARN ${p.script.rel}: fetch made no progress; skipped`);
          pending.delete(key);
        }
      }
    }
    return written;
  }

  private async writeScript(script: RemoteScript, source: string, remoteHash: string | null): Promise<boolean> {
    const normalized = normalizeSource(source);
    const hash = hashSource(normalized);
    if (remoteHash !== null && remoteHash !== hash) {
      this.warnOnce(`parity:${script.rel}`, `WARN ${script.rel}: checksum computed in Studio (${remoteHash}) differs from the file's (${hash}); the file is written anyway — please report this`);
    }
    const abs = path.join(this.deps.dir, ...script.rel.split('/'));
    try {
      await writeFileAtomic(abs, normalized);
    } catch (err) {
      this.deps.log(`ERROR cannot write ${script.rel}: ${err instanceof Error ? err.message : String(err)}`);
      this.deps.onError();
      return false;
    }
    this.deps.state.files[script.rel] = { hash: remoteHash ?? hash, mtime: await mtimeOf(abs) };
    this.deps.log(`pulled ${script.rel} (${script.class}, ${Buffer.byteLength(normalized, 'utf8')} bytes)`);
    await this.warnStaleTwin(script.rel);
    return true;
  }

  /** A script that switched between flat and directory form leaves its old file behind; say so. */
  private async warnStaleTwin(rel: string): Promise<void> {
    const m = /^(.*)\/init(\.server|\.client)?\.luau$/.exec(rel);
    let twin: string | null = null;
    if (m) twin = `${m[1]}${m[2] ?? ''}.luau`;
    else {
      const flat = /^(.*?)(\.server|\.client)?\.luau$/.exec(rel);
      if (flat) twin = `${flat[1]}/init${flat[2] ?? ''}.luau`;
    }
    if (!twin || twin === rel) return;
    if (await exists(path.join(this.deps.dir, ...twin.split('/')))) {
      this.warnOnce(`twin:${twin}`, `WARN ${twin} is stale (the same script is now ${rel}); delete it by hand`);
    }
  }

  private async localHash(abs: string): Promise<string | null> {
    try {
      return hashSource(normalizeSource(await fsp.readFile(abs, 'utf8')));
    } catch {
      return null;
    }
  }
}

function isDryRunRefusal(outcome: RpcOutcome): boolean {
  return !outcome.ok && outcome.code === 'busy' && /dry_run/.test(outcome.message);
}

async function exists(abs: string): Promise<boolean> {
  try {
    await fsp.access(abs);
    return true;
  } catch {
    return false;
  }
}

async function mtimeOf(abs: string): Promise<number> {
  try {
    return (await fsp.stat(abs)).mtimeMs;
  } catch {
    return Date.now();
  }
}
