/**
 * A fake studio-live bridge for the sync tests: `POST /rpc {tool,args}` on a random port with an
 * in-memory "Studio" that applies the sync's programs from their ARGS (the Luau text itself is not
 * executed; the fake mirrors what PUSH_PROGRAM / LIST_PROGRAM / FETCH_PROGRAM do with the same inputs).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ScriptClass } from '../../bridge/src/sync/layout.js';
import type { FetchItem, FetchRequest, PushItem, PushResult } from '../../bridge/src/sync/luau.js';
import { hashSource, normalizeSource } from '../../bridge/src/sync/state.js';

export interface FakeNode {
  name: string;
  class: string;
  source?: string;
  children: FakeNode[];
}

export interface RpcCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface FakeFailure {
  /** Tool error code to answer with (`isError` body), or 'http500' / 'garbage' for transport-level failures. */
  code: string;
  message?: string;
}

const SERVICES = ['Workspace', 'ServerScriptService', 'ServerStorage', 'ReplicatedStorage', 'ReplicatedFirst', 'StarterPlayer', 'StarterGui', 'StarterPack', 'Lighting', 'SoundService', 'TextChatService', 'Stats', 'CoreGui'];

export class FakeStudio {
  readonly game: FakeNode = { name: 'game', class: 'DataModel', children: [] };
  playtestRunning = false;
  /** Scripts whose paths exist in the play server (hotpatch succeeds only for these). */
  serverScripts = new Set<string>();

  constructor() {
    for (const name of SERVICES) this.game.children.push({ name, class: name, children: [] });
    const sp = this.service('StarterPlayer');
    sp.children.push({ name: 'StarterPlayerScripts', class: 'StarterPlayerScripts', children: [] });
    sp.children.push({ name: 'StarterCharacterScripts', class: 'StarterCharacterScripts', children: [] });
  }

  service(name: string): FakeNode {
    const svc = this.game.children.find((c) => c.name === name);
    if (!svc) throw new Error(`'${name}' is not a valid Service name`);
    return svc;
  }

  find(names: readonly string[]): FakeNode | null {
    let node: FakeNode = this.game;
    for (const name of names) {
      const next = node.children.find((c) => c.name === name);
      if (!next) return null;
      node = next;
    }
    return node;
  }

  /** Creates a script at the name chain (parents become Folders), returning it. */
  put(names: readonly string[], cls: ScriptClass, source: string): FakeNode {
    let node: FakeNode = this.service(names[0] as string);
    for (const name of names.slice(1, -1)) {
      let next = node.children.find((c) => c.name === name);
      if (!next) {
        next = { name, class: 'Folder', children: [] };
        node.children.push(next);
      }
      node = next;
    }
    const last = names[names.length - 1] as string;
    let script = node.children.find((c) => c.name === last);
    if (!script) {
      script = { name: last, class: cls, source, children: [] };
      node.children.push(script);
    } else {
      script.class = cls;
      script.source = source;
    }
    return script;
  }

  *scripts(): Generator<{ names: string[]; node: FakeNode }> {
    const skip = new Set(['Stats', 'CoreGui', 'CorePackages', 'PluginGuiService', 'PluginDebugService', 'RobloxPluginGuiService', 'StudioService']);
    const walk = function* (node: FakeNode, names: string[]): Generator<{ names: string[]; node: FakeNode }> {
      for (const child of node.children) {
        const chain = [...names, child.name];
        if (isScript(child)) yield { names: chain, node: child };
        yield* walk(child, chain);
      }
    };
    for (const svc of this.game.children) {
      if (skip.has(svc.name)) continue;
      yield* walk(svc, [svc.name]);
    }
  }

  applyPush(items: PushItem[]): PushResult {
    const r: PushResult = { created: 0, updated: 0, unchanged: 0, replaced: 0, parents: 0, outcomes: [], skipped: [], conflicts: [], overwrote: [] };
    items.forEach((it, idx) => {
      const i = idx + 1;
      let parent: FakeNode;
      try {
        parent = this.service(it.service);
      } catch (err) {
        r.outcomes[idx] = 'skipped';
        r.skipped.push({ i, why: (err as Error).message });
        return;
      }
      for (const spec of it.parents) {
        let child = parent.children.find((c) => c.name === spec.name);
        if (!child) {
          child = { name: spec.name, class: spec.class, children: [], ...(spec.class !== 'Folder' ? { source: '' } : {}) };
          parent.children.push(child);
          r.parents += 1;
        }
        parent = child;
      }
      const inst = parent.children.find((c) => c.name === it.name);
      if (inst && !isScript(inst)) {
        r.outcomes[idx] = 'skipped';
        r.skipped.push({ i, why: `${it.name} is a ${inst.class}, not a script` });
        return;
      }
      if (!inst) {
        parent.children.push({ name: it.name, class: it.class, source: it.src, children: [] });
        r.created += 1;
        r.outcomes[idx] = 'created';
        return;
      }
      if (inst.class !== it.class) {
        inst.class = it.class;
        inst.source = it.src;
        r.replaced += 1;
        r.outcomes[idx] = 'replaced';
        return;
      }
      const cur = normalizeSource(inst.source ?? '');
      if (cur === it.src) {
        r.unchanged += 1;
        r.outcomes[idx] = 'unchanged';
        return;
      }
      if (it.prev !== null) {
        if (hashSource(cur) !== it.prev) r.conflicts.push(i);
      } else if (cur !== '') {
        r.overwrote.push(i);
      }
      inst.source = it.src;
      r.updated += 1;
      r.outcomes[idx] = 'updated';
    });
    return r;
  }

  applyList(offset: number, limit: number): { total: number; items: Array<{ n: string[]; c: string; h: string }> } {
    const all = [...this.scripts()];
    const page = all.slice(offset, offset + Math.min(200, limit)).map(({ names, node }) => ({ n: names, c: node.class, h: hashSource(normalizeSource(node.source ?? '')) }));
    return { total: all.length, items: page };
  }

  applyFetch(reqs: FetchRequest[], budget: number, part: number): { items: FetchItem[] } {
    const out: FetchItem[] = [];
    let used = 0;
    for (const r of reqs) {
      if (used >= budget) break;
      const inst = this.find(r.n);
      if (!inst || !isScript(inst)) {
        out.push({ n: r.n, missing: true });
        continue;
      }
      const src = Buffer.from(normalizeSource(inst.source ?? ''), 'utf8');
      const len = src.length;
      const from = Math.max(1, r.from ?? 1);
      const parts: string[] = [];
      let pos = from;
      while (pos <= len && used < budget) {
        let e = Math.min(len, pos + part - 1);
        let limit = e;
        while (limit < len && limit > pos) {
          const b = src[limit] as number; // byte at 1-based index limit+1
          if (b >= 0x80 && b < 0xc0) limit -= 1;
          else break;
        }
        if (limit >= pos) e = limit;
        parts.push(src.subarray(pos - 1, e).toString('utf8'));
        used += e - pos + 1;
        pos = e + 1;
      }
      out.push({ n: r.n, c: inst.class as ScriptClass, h: hashSource(src.toString('utf8')), len, from, next: pos, eof: pos > len, parts });
    }
    return { items: out };
  }
}

function isScript(node: FakeNode): boolean {
  return node.class === 'Script' || node.class === 'LocalScript' || node.class === 'ModuleScript';
}

export interface FakeBridge {
  port: number;
  studio: FakeStudio;
  calls: RpcCall[];
  /** Queue of failures answered before the real handler runs (one per call). */
  failures: FakeFailure[];
  /** When set, `run` results are post-processed (e.g. to simulate bridge truncation). */
  mangle: ((tool: string, body: Record<string, unknown>) => Record<string, unknown>) | null;
  /**
   * While > 0, each `run` is applied at once but answered with a job handle `{job_id, status:'running'}`
   * (the real bridge does that after wait_ms); `job wait` answers `running` `deferPolls` times, then `done`.
   */
  deferRuns: number;
  deferPolls: number;
  /** Job ids the sync asked to cancel. */
  cancelled: string[];
  close(): Promise<void>;
  /** Stops listening without touching state; `listen()` binds the same port again. */
  pause(): Promise<void>;
  listen(): Promise<void>;
}

function toolResult(body: unknown, isError = false): string {
  return JSON.stringify(isError ? { content: [{ type: 'text', text: JSON.stringify(body) }], isError: true } : { content: [{ type: 'text', text: JSON.stringify(body) }] });
}

export async function startFakeBridge(studio = new FakeStudio()): Promise<FakeBridge> {
  const calls: RpcCall[] = [];
  const failures: FakeFailure[] = [];
  const cancelled: string[] = [];
  const state: { server: http.Server | null; port: number; mangle: FakeBridge['mangle']; deferRuns: number; deferPolls: number } = {
    server: null,
    port: 0,
    mangle: null,
    deferRuns: 0,
    deferPolls: 1,
  };
  const jobs = new Map<string, { result: Record<string, unknown>; polls: number }>();
  let jobCounter = 0;

  const handle = (tool: string, args: Record<string, unknown>): { status: number; body: string } => {
    const failure = failures.shift();
    if (failure) {
      if (failure.code === 'http500') return { status: 500, body: JSON.stringify({ error: { code: 'internal', message: failure.message ?? 'boom' } }) };
      if (failure.code === 'garbage') return { status: 200, body: 'not json at all' };
      return { status: 200, body: toolResult({ error: { code: failure.code, message: failure.message ?? failure.code } }, true) };
    }
    const finish = (body: Record<string, unknown>): { status: number; body: string } => {
      const value = state.mangle ? state.mangle(tool, body) : body;
      if (tool === 'run' && state.deferRuns > 0) {
        state.deferRuns -= 1;
        jobCounter += 1;
        const jobId = `r-fake00-${jobCounter}`;
        jobs.set(jobId, { result: value, polls: 0 });
        return { status: 200, body: toolResult({ job_id: jobId, status: 'running', op: 'run', dm: 'edit', elapsed_ms: 50_000, progress: null }) };
      }
      return { status: 200, body: toolResult(value) };
    };
    switch (tool) {
      case 'job': {
        const jobId = String(args.job_id);
        const job = jobs.get(jobId);
        if (!job) return { status: 200, body: toolResult({ error: { code: 'not_found', message: `unknown job ${jobId}` } }, true) };
        if (args.action === 'cancel') {
          cancelled.push(jobId);
          return { status: 200, body: toolResult({ job_id: jobId, status: 'error', error: { code: 'cancelled', message: 'cancelled by request' }, cancel_sent: true }) };
        }
        if (args.action !== 'wait' && args.action !== 'status') return { status: 200, body: toolResult({ error: { code: 'bad_request', message: 'unsupported job action in fake' } }, true) };
        job.polls += 1;
        if (job.polls <= state.deferPolls) return { status: 200, body: toolResult({ job_id: jobId, status: 'running', op: 'run', dm: 'edit' }) };
        return { status: 200, body: toolResult({ job_id: jobId, status: 'done', op: 'run', dm: 'edit', result: job.result, responder: 'edit' }) };
      }
      case 'run': {
        const a = (args.args ?? {}) as Record<string, unknown>;
        const undo = args.dry_run === true ? 'cancelled' : studio.playtestRunning ? 'unavailable' : 'committed';
        const envelope = (value: unknown): Record<string, unknown> => ({ value, output: [], duration_ms: 1, changes: { added: 0, removed: 0, paths: [] }, undo, ephemeral: false, dm: 'edit' });
        if (args.dry_run === true && studio.playtestRunning) {
          return { status: 200, body: toolResult({ error: { code: 'busy', message: 'dry_run needs a ChangeHistory recording to roll back, and none could be opened (a playtest is running or another recording is open)' } }, true) };
        }
        switch (a.op) {
          case 'push':
            return finish(envelope(studio.applyPush(a.items as PushItem[])));
          case 'list':
            return finish(envelope(studio.applyList(Number(a.offset ?? 0), Number(a.limit ?? 200))));
          case 'fetch':
            return finish(envelope(studio.applyFetch(a.reqs as FetchRequest[], Number(a.budget ?? 24000), Number(a.part ?? 4000))));
          default:
            return { status: 200, body: toolResult({ error: { code: 'bad_request', message: `unknown sync op ${String(a.op)}` } }, true) };
        }
      }
      case 'observe':
        if (args.what === 'status') return finish({ playtest: { running: studio.playtestRunning, mode: 'play' }, peers: [] });
        return { status: 200, body: toolResult({ error: { code: 'bad_request', message: 'unsupported observe in fake' } }, true) };
      case 'playtest': {
        if (args.action !== 'hotpatch') return { status: 200, body: toolResult({ error: { code: 'bad_request', message: 'unsupported action in fake' } }, true) };
        const path = String(args.path);
        if (!studio.serverScripts.has(path)) return { status: 200, body: toolResult({ error: { code: 'luau_error', message: `no instance at path '${path}'` } }, true) };
        const cls = path.endsWith('Module') ? 'ModuleScript' : 'Script';
        return finish(cls === 'ModuleScript' ? { patched: true, class: cls, restarted: false, note: 'require cache unaffected; re-require a clone' } : { patched: true, class: cls, restarted: true });
      }
      default:
        return { status: 200, body: toolResult({ error: { code: 'bad_request', message: `unknown tool ${tool}` } }, true) };
    }
  };

  const listen = (): Promise<void> =>
    new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (chunk: Buffer) => {
          raw += chunk.toString();
        });
        req.on('end', () => {
          if (req.method !== 'POST' || req.url !== '/rpc') {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { code: 'not_found', message: 'no route' } }));
            return;
          }
          const parsed = JSON.parse(raw) as { tool: string; args?: Record<string, unknown> };
          const args = parsed.args ?? {};
          calls.push({ tool: parsed.tool, args });
          const { status, body } = handle(parsed.tool, args);
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(body);
        });
      });
      server.once('error', reject);
      server.listen(state.port, '127.0.0.1', () => {
        state.server = server;
        state.port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  const closeServer = (): Promise<void> =>
    new Promise((resolve) => {
      const server = state.server;
      state.server = null;
      if (!server) return resolve();
      server.close(() => resolve());
      server.closeAllConnections();
    });

  await listen();
  return {
    get port() {
      return state.port;
    },
    studio,
    calls,
    failures,
    get mangle() {
      return state.mangle;
    },
    set mangle(fn) {
      state.mangle = fn;
    },
    get deferRuns() {
      return state.deferRuns;
    },
    set deferRuns(n) {
      state.deferRuns = n;
    },
    get deferPolls() {
      return state.deferPolls;
    },
    set deferPolls(n) {
      state.deferPolls = n;
    },
    cancelled,
    close: closeServer,
    pause: closeServer,
    listen,
  };
}
