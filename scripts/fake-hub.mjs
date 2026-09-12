// A stand-in for the Studio hub over L1 (docs/protocol.md §1.1): connects to ws://127.0.0.1:<port>/studio,
// completes the hello handshake, answers run / observe (status, logs incl. dm "all", script ranges,
// geometry) / playtest (start play|run|multiplayer, stop, status, list, run_until, install, uninstall,
// hotpatch, add_players) / push (with `replace`) / input / persist_sync requests, emits `ev` and `hb`
// frames (with the v1.1 place identity fields), honours cancel / cancel_all and reassembles §3 chunks.
// Like the hub it re-installs the persisted controllers the bridge synced whenever their DM (re)appears
// (and, on a sync, on connected peers that lack them — never one they already run), answers
// `syntax_error: Malformed string` for code with a raw newline inside a quoted literal (the heredoc bug),
// and applies `body.geometry_policy` to the program "overlap" (warn → geometry + warnings in the body,
// reject → error geometry_violation carrying the report, off / absent → no check; §4.1).
// scripts/selftest.mjs drives it against an in-process bridge; it also runs standalone against a live
// bridge so the MCP side can be exercised without Studio:
//   node scripts/fake-hub.mjs [--port 47800] [--session <guid>]
// Requires "npm run build" (imports the compiled protocol helpers so both sides share one definition).
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = (name) => path.join(root, 'dist', 'bridge', name);
if (!existsSync(dist('protocol.js'))) {
  console.error('fake-hub: dist/bridge is missing; run "npm run build" first');
  process.exit(2);
}
const { ChunkAssembler, splitFrame } = await import(pathToFileURL(dist('chunk.js')).href);
const { L1_CHUNK_THRESHOLD_BYTES, PROTO_VERSION, isAckFrame, isCancelAllFrame, isCancelFrame, isChunkFrame, isReqFrame, parseFrame } =
  await import(pathToFileURL(dist('protocol.js')).href);
// The same literal scanner the bridge uses for its transport hint: a raw newline inside a quoted Luau
// literal (the heredoc bug) is what the compiler reports as `Malformed string`.
const { rawNewlineInsideString } = await import(pathToFileURL(dist('program.js')).href);

const MAX_BUFFERED_FRAMES = 2000;
/** Place identity the hub reports in every `hb` and in `observe status` (protocol Notes, "Identity"). */
const DEFAULT_IDENTITY = { placeId: 1, placeName: 'FakeHub', universeId: 4242, creatorType: 'User', creatorId: 100000001 };
const MAX_PLAYERS = 8;
const DEFAULT_PLAYERS = 2;
/** Delay between successive peers appearing during `playtest start` (real clients take seconds; keep the selftest fast). */
const PEER_SPAWN_MS = 10;
const IDLE_PLAYTEST = () => ({ running: false, starting: false, mode: null, players: null, startedAt: null, externallyStarted: false });
/** True for Luau text a shell heredoc mangled (a raw newline inside a quoted literal); the compiler would say `Malformed string`. */
const malformed = (text) => rawNewlineInsideString(String(text ?? ''));
/** The fake script served by `observe script`: 60 lines of ~200 chars, so the whole text exceeds the §7 8 KB string cap. */
const SCRIPT_LINES = Array.from({ length: 60 }, (_, i) => `-- line ${i + 1} ${'x'.repeat(200)}`);
/** The merged log journal `observe logs` serves; each line carries its `src`. */
const LOG_LINES = [
  { seq: 1, t: 1, level: 'print', msg: 'edit-side line', src: 'edit' },
  { seq: 2, t: 2, level: 'print', msg: '[Server] started (seeded from GetLogHistory)', src: 'server' },
  { seq: 3, t: 3, level: 'warn', msg: 'client warning', src: 'client:1' },
  { seq: 4, t: 4, level: 'print', msg: 'later server line', src: 'server' },
];

/** The fake scene's geometry violations, as the runtime's `geometry.report` lists them (§4.1 / §4.2). */
const GEOMETRY_OVERLAPS = [
  { a: 'Workspace.Map.Deck', b: 'Workspace.Map.WallEast', depth: 1.5, aClass: 'Part', bClass: 'Part' },
  { a: 'Workspace.Map.Ramp', b: 'Workspace.Map.Platform', depth: 0.75, aClass: 'WedgePart', bClass: 'Part', approximate: true },
  { a: 'Workspace.Map.Lamp', b: 'Workspace.Map.Deck', depth: 0.3, aClass: 'Part', bClass: 'Part', decor: true },
];
const GEOMETRY_NESTED = [{ path: 'Workspace.Map.Pillar.Cap', parent: 'Workspace.Map.Pillar', class: 'Part' }];
const GEOMETRY_POLICIES = ['warn', 'reject', 'off'];
const GEOMETRY_DEFAULT_TOLERANCE = 0.05;

/**
 * `geometry.report` over the fake scene: pairs penetrating deeper than `tolerance` (the runtime's shrunken
 * query never sees shallower ones), lists capped at 200 like the runtime's (`max` is the number of parts
 * checked, which the caller passes as `checked`), totals uncapped, nesting unless `include_nested` is false.
 */
function geometryReport({ tolerance, include_nested, checked } = {}) {
  const tol = typeof tolerance === 'number' ? tolerance : GEOMETRY_DEFAULT_TOLERANCE;
  const cap = 200;
  const overlaps = GEOMETRY_OVERLAPS.filter((o) => o.depth > tol);
  const nested = include_nested === false ? [] : GEOMETRY_NESTED;
  return {
    overlaps: overlaps.slice(0, cap),
    nested: nested.slice(0, cap),
    checked: checked ?? 4,
    sampled: false,
    ms: 1,
    totals: { overlaps: overlaps.length, nested: nested.length },
  };
}

/** The run body's copy of a report (`geometry.trim`): `sampled` only when set. */
function trimReport(report) {
  const { sampled, ...rest } = report;
  return sampled ? { ...rest, sampled: true } : rest;
}

/** One warning line per non-empty list, worded like the runtime's `geometry.warnings`. */
function geometryWarnings(report) {
  const out = [];
  const n = report.totals.overlaps;
  if (n > 0) {
    const f = report.overlaps[0];
    const example = f ? ` (e.g. ${f.a} ⟂ ${f.b}, ${f.depth} stud${f.depth === 1 ? '' : 's'}${f.approximate ? ', approximate' : ''})` : '';
    out.push(`${n} overlapping part pair${n === 1 ? '' : 's'}${example} — fix before continuing (move, resize or S.placeOn them); see geometry`);
  }
  const m = report.totals.nested;
  if (m > 0) {
    const f = report.nested[0];
    out.push(`${m} part${m === 1 ? '' : 's'} parented under another part${f ? ` (e.g. ${f.path} under ${f.parent})` : ''} — parts belong in a Model or Folder, never under a BasePart; see geometry`);
  }
  return out;
}

/** Drops null / undefined fields the way the Luau runtime's JSON encoder drops nil ones. */
function compact(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) if (value !== null && value !== undefined) out[key] = value;
  return out;
}

export class FakeHub {
  /** Highest event seq this hub has stamped (§2.5). */
  seq = 0;
  /** `upto` of the last ack received and how many acks arrived (§2.6). */
  lastAck = null;
  ackCount = 0;
  /** Chunk frames received / sent and every request reassembled from chunks (§3). */
  chunksIn = 0;
  chunksOut = 0;
  reassembled = [];
  /** Every `req` frame seen, in order. */
  requests = [];
  /** Every `push` the hub "forwarded" as `push_apply`: {dm, paths, parent, replace, replaced}. */
  pushes = [];
  /** Every `persist_sync` body's controllers, in order; `persisted` is the current in-memory list (what the hub keeps). */
  persistSyncs = [];
  persisted = [];
  /** Every persisted re-install this hub issued: {dm, name, why: 'peer hello' | 'persist_sync'}. */
  persistInstalls = [];
  /** Every `run` of the program "overlap": {dm, policy} with the `body.geometry_policy` it carried (null when absent). */
  geometryRuns = [];
  /** Every `observe geometry`: {dm, root, max, tolerance, include_nested} as received (null when absent). */
  geometryObserves = [];
  /** dm → Map<name, {code, persist}> of controllers installed on that peer (gone with the peer). */
  #controllers = new Map();
  /** dm → Set<path> of roots a `push` landed there (for `replace` counting). */
  #landed = new Map();
  /** Playtest bookkeeping as the hub's playtest module keeps it (§4.3 + v1.1 Notes). */
  playtest = IDLE_PLAYTEST();
  /** When true, `observe status` omits universeId/creatorType/creatorId so the bridge has to fill them from `hb`. */
  statusOmitsIdentity = false;
  #frames = [];
  #waiters = [];
  #assembler = new ChunkAssembler();
  #inflight = new Map();
  #cidCounter = 0;
  /** dm → {userId, playerName} for client peers (multiplayer test players are Player1.. with userId −1, −2, …). */
  #peerMeta = new Map();

  constructor(ws, options = {}) {
    this.ws = ws;
    this.session = options.session ?? randomUUID();
    this.bootstrap = options.bootstrap ?? '1.0.0';
    this.peers = options.peers ?? ['server', 'client:1'];
    this.identity = { ...DEFAULT_IDENTITY, ...(options.identity ?? {}) };
    this.log = options.log ?? (() => {});
    this.closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
    ws.on('message', (data, isBinary) => {
      if (!isBinary) this.#receive(data.toString());
    });
  }

  static connect(port, options = {}) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/studio`);
    return new Promise((resolve, reject) => {
      ws.once('open', () => resolve(new FakeHub(ws, options)));
      ws.once('error', reject);
    });
  }

  /** Sends `hello`; resolves with the `hello_ack` (or `error`) frame and the bundle, inline or from a following `bundle` frame. */
  async hello(extra = {}) {
    this.send({
      v: PROTO_VERSION,
      kind: 'hello',
      proto: PROTO_VERSION,
      bootstrap: this.bootstrap,
      role: 'edit',
      session: this.session,
      studio: { version: '0.738.0.7381393', placeId: 1, placeName: 'FakeHub', dataModelName: 'Place1' },
      lastSeq: this.seq,
      ...extra,
    });
    const ack = await this.next((f) => f.kind === 'hello_ack' || f.kind === 'error');
    let bundle = null;
    if (ack.kind === 'hello_ack') bundle = ack.bundle ?? (await this.next((f) => f.kind === 'bundle'));
    return { ack, bundle };
  }

  /** Sends one frame, chunking it past the L1 threshold exactly like the hub would (§3). */
  send(frame) {
    const text = JSON.stringify(frame);
    if (Buffer.byteLength(text, 'utf8') <= L1_CHUNK_THRESHOLD_BYTES) {
      this.ws.send(text);
      return;
    }
    this.#cidCounter += 1;
    for (const chunk of splitFrame(text, `h-${this.#cidCounter}`)) {
      this.chunksOut += 1;
      this.ws.send(JSON.stringify(chunk));
    }
  }

  /** Stamps and sends an `ev` frame (§2.5); returns its seq. */
  emit(ev) {
    this.seq += 1;
    this.send({ v: PROTO_VERSION, kind: 'ev', seq: this.seq, t: performance.now() / 1000, wall: Math.floor(Date.now() / 1000), src: 'edit', ...ev });
    return this.seq;
  }

  /**
   * Sends an `hb` frame (§2.7) carrying the tracked peers / playtest state plus the place identity
   * (placeName, universeId, creatorType, creatorId — v1.1 Notes); `extra` overrides any field.
   */
  hb(extra = {}) {
    const { placeName, universeId, creatorType, creatorId } = this.identity;
    this.send({
      v: PROTO_VERSION,
      kind: 'hb',
      seq: this.seq,
      t: performance.now() / 1000,
      peers: this.#peerList(),
      playtest: this.#playtestInfo(),
      dropped: 0,
      fps: 60,
      placeName,
      universeId,
      creatorType,
      creatorId,
      ...extra,
    });
  }

  /** Connected client dms in join order. */
  clients() {
    return this.peers.filter((dm) => /^client:\d+$/.test(dm));
  }

  /** Controllers installed on `dm` as the agent lists them. */
  controllers(dm) {
    return [...(this.#controllers.get(dm) ?? new Map()).entries()].map(([name, c]) => ({ dm, name, state: 'installed', persist: c.persist }));
  }

  /** Makes a live controller vanish on the hub side only (as if its DM was restarted without the bridge knowing). */
  dropController(dm, name) {
    return this.#controllers.get(dm)?.delete(name) ?? false;
  }

  #controllersOf(dm) {
    let map = this.#controllers.get(dm);
    if (!map) {
      map = new Map();
      this.#controllers.set(dm, map);
    }
    return map;
  }

  ok(id, dm, body) {
    this.send({ v: PROTO_VERSION, kind: 'res', id, ok: true, dm, body });
  }

  fail(id, dm, code, message, extra = {}) {
    this.send({ v: PROTO_VERSION, kind: 'res', id, ok: false, dm, error: { code, message, ...extra } });
  }

  /** Resolves with the first buffered (or next incoming) frame matching `pred`. `ack` frames are never buffered. */
  next(pred = () => true, timeoutMs = 3000) {
    const index = this.#frames.findIndex(pred);
    if (index >= 0) return Promise.resolve(this.#frames.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters.splice(this.#waiters.findIndex((w) => w.timer === timer), 1);
        reject(new Error(`timeout waiting for a frame; buffered kinds: ${this.#frames.map((f) => f.kind).join(',') || 'none'}`));
      }, timeoutMs);
      this.#waiters.push({ pred, resolve, timer });
    });
  }

  close() {
    this.ws.close();
  }

  #receive(text) {
    const frame = parseFrame(text);
    if (!frame) return;
    if (isChunkFrame(frame)) {
      this.chunksIn += 1;
      const whole = this.#assembler.accept(frame);
      if (whole === null) return;
      this.reassembled.push({ cid: frame.cid, parts: frame.n, length: whole.length });
      const inner = parseFrame(whole);
      if (inner) this.#dispatch(inner);
      return;
    }
    this.#dispatch(frame);
  }

  #dispatch(frame) {
    if (isReqFrame(frame)) {
      this.requests.push(frame);
      this.log(`req ${frame.id} ${frame.op} dm=${frame.dm} deadline_ms=${frame.deadline_ms}`);
      this.#answer(frame);
    } else if (isCancelFrame(frame)) {
      this.#cancel(frame.id);
    } else if (isCancelAllFrame(frame)) {
      for (const id of [...this.#inflight.keys()]) this.#cancel(id);
    } else if (isAckFrame(frame)) {
      this.lastAck = frame.upto;
      this.ackCount += 1;
      return;
    }
    this.#offer(frame);
  }

  #offer(frame) {
    const index = this.#waiters.findIndex((w) => w.pred(frame));
    if (index >= 0) {
      const waiter = this.#waiters.splice(index, 1)[0];
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
      return;
    }
    this.#frames.push(frame);
    if (this.#frames.length > MAX_BUFFERED_FRAMES) this.#frames.shift();
  }

  #peerList() {
    return this.peers.map((dm) => ({ dm, connected: true, ...(this.#peerMeta.get(dm) ?? {}) }));
  }

  /** `hb.playtest` / `observe status → playtest` as the runtime's `Playtest.info()` builds it (nil fields omitted). */
  #playtestInfo() {
    const p = this.playtest;
    return compact({ running: p.running, starting: p.starting, mode: p.mode, players: p.players, startedAt: p.startedAt, externallyStarted: p.externallyStarted });
  }

  /**
   * Adds a connected peer (with its identity), emitting the `peer` event the star would, and — like
   * `Playtest.onPeerConnected` — installs every controller the bridge persisted for that DM.
   */
  #addPeer(dm, meta = null) {
    if (this.peers.includes(dm)) return;
    this.peers.push(dm);
    if (meta) this.#peerMeta.set(dm, meta);
    this.emit({ type: 'peer', dm, connected: true, ...(meta ?? {}) });
    for (const entry of this.persisted) {
      if (entry.dm !== dm) continue;
      this.#controllersOf(dm).set(entry.name, { code: entry.code, persist: true });
      this.persistInstalls.push({ dm, name: entry.name, why: 'peer hello' });
      this.emit({ type: 'controller', dm, name: entry.name, state: 'installed', detail: 'persisted re-install' });
    }
  }

  #removePeers() {
    for (const dm of this.peers) this.emit({ type: 'peer', dm, connected: false, ...(this.#peerMeta.get(dm) ?? {}) });
    this.peers = [];
    this.#peerMeta.clear();
    // The agents die with their DMs: controllers and pushed instances go with them.
    this.#controllers.clear();
    this.#landed.clear();
  }

  /** Emits a `playtest` state event (§2.5) and the extra `hb` the runtime sends on every state change. */
  #playtestState(state, extra = {}) {
    this.emit(compact({ type: 'playtest', state, mode: this.playtest.mode, players: this.playtest.players, ...extra }));
    this.hb();
  }

  /** `edit` → hub; `client` → lowest client; a listed peer → itself; anything else → null (no_peer). */
  #resolveDm(dm) {
    if (dm === 'edit') return 'edit';
    if (dm === 'client') return this.peers.find((p) => /^client:\d+$/.test(p)) ?? null;
    return this.peers.includes(dm) ? dm : null;
  }

  #answer(req) {
    const dm = this.#resolveDm(req.dm);
    if (dm === null) {
      // Like the runtime's forward path (hub/init.luau `forward` → protocol.err(id, "edit", …)):
      // the refusal is answered by the hub's own dispatcher, so the frame's dm is `edit`, not the target.
      this.fail(req.id, 'edit', 'no_peer', `dm '${req.dm}' is not connected`);
      return;
    }
    const body = req.body;
    switch (req.op) {
      case 'run':
        this.#run(req, dm);
        return;
      case 'observe':
        this.#observe(req, dm);
        return;
      case 'playtest':
        this.#playtest(req, dm);
        return;
      case 'push':
        // Always executed on the hub (req.dm is ignored); the destination is body.dm.
        this.#push(req);
        return;
      case 'persist_sync': {
        // The bridge owns the persisted list (L1 finding). Like the hub's Persist.replaceAll the
        // in-memory copy is replaced wholesale (malformed entries rejected, `client` → `client:1`, the
        // last duplicate wins), and like Playtest.onPersistSync every peer already connected receives
        // the entries it does not have yet (its hello beat the sync, or the hub runtime restarted after
        // its agents) — never a controller it already runs. Answer: {persisted, rejected, installs_issued}.
        const list = Array.isArray(body.controllers) ? body.controllers : [];
        const controllers = [];
        let rejected = 0;
        for (const c of list) {
          if (!c || typeof c.dm !== 'string' || typeof c.name !== 'string' || typeof c.code !== 'string') {
            rejected += 1;
            continue;
          }
          const dm = c.dm === 'client' ? 'client:1' : c.dm;
          if (dm !== 'server' && !/^client:\d+$/.test(dm)) {
            rejected += 1;
            continue;
          }
          const index = controllers.findIndex((e) => e.dm === dm && e.name === c.name);
          if (index >= 0) controllers.splice(index, 1);
          controllers.push({ dm, name: c.name, code: c.code });
        }
        this.persistSyncs.push(controllers);
        this.persisted = controllers;
        let issued = 0;
        for (const entry of controllers) {
          if (!this.peers.includes(entry.dm) || this.#controllersOf(entry.dm).has(entry.name)) continue;
          this.#controllersOf(entry.dm).set(entry.name, { code: entry.code, persist: true });
          this.persistInstalls.push({ dm: entry.dm, name: entry.name, why: 'persist_sync' });
          this.emit({ type: 'controller', dm: entry.dm, name: entry.name, state: 'installed', detail: 'persisted re-install (persist_sync)' });
          issued += 1;
        }
        this.ok(req.id, 'edit', { persisted: controllers.length, rejected, installs_issued: issued });
        return;
      }
      case 'input':
        this.ok(req.id, dm, { steps: (body.actions ?? []).map((_, i) => ({ i: i + 1, ok: true })), elapsed_ms: 1 });
        return;
      default:
        this.fail(req.id, dm, 'unsupported', `unknown op '${req.op}'`);
    }
  }

  /** `observe`: status (hub), logs (hub's merged journal filtered by body.dm, or all), script (line ranges, text uncut), geometry (§4.2). */
  #observe(req, dm) {
    const body = req.body;
    switch (body.what) {
      case 'geometry': {
        // Routed by req.dm like `tree`; the executor defaults root to Workspace and validates the rest (§4.2).
        const root = typeof body.root === 'string' && body.root !== '' ? body.root : 'Workspace';
        if (body.tolerance !== undefined && (typeof body.tolerance !== 'number' || body.tolerance < 0)) {
          this.fail(req.id, dm, 'bad_request', "observe geometry: 'tolerance' must be a number ≥ 0");
          return;
        }
        if (body.max !== undefined && (!Number.isInteger(body.max) || body.max < 1)) {
          this.fail(req.id, dm, 'bad_request', "observe geometry: 'max' must be a positive integer");
          return;
        }
        if (root.startsWith('Nowhere')) {
          this.fail(req.id, dm, 'bad_request', `observe geometry: root '${root}' not found`);
          return;
        }
        this.geometryObserves.push({ dm, root, max: body.max ?? null, tolerance: body.tolerance ?? null, include_nested: body.include_nested ?? null });
        this.ok(req.id, dm, geometryReport({ tolerance: body.tolerance, include_nested: body.include_nested, checked: Math.min(body.max ?? 5000, 4) }));
        return;
      }
      case 'status':
        this.ok(req.id, dm, this.#status(dm));
        return;
      case 'logs': {
        const filter = typeof body.dm === 'string' ? body.dm : 'edit';
        const items = filter === 'all' ? LOG_LINES : LOG_LINES.filter((line) => line.src === filter);
        this.ok(req.id, 'edit', { items, next: items.at(-1)?.seq ?? 0 });
        return;
      }
      case 'script': {
        if (typeof body.path !== 'string' || body.path === '') {
          this.fail(req.id, dm, 'bad_request', "observe script: 'path' is required");
          return;
        }
        const total = SCRIPT_LINES.length;
        const from = Number.isInteger(body.from) ? Math.max(1, body.from) : 1;
        const to = Number.isInteger(body.to) ? Math.min(total, body.to) : total;
        const slice = from <= to ? SCRIPT_LINES.slice(from - 1, to) : [];
        this.ok(req.id, dm, { path: body.path, class: 'Script', from, to: from <= to ? to : from - 1, lines: slice.length, total_lines: total, text: slice.join('\n') });
        return;
      }
      default:
        this.fail(req.id, dm, 'bad_request', `fake hub cannot observe '${body.what}'`);
    }
  }

  /** §4.3 actions the hub itself answers; run_until / install / uninstall / hotpatch stand in for the forwarded agent ops. */
  #playtest(req, dm) {
    const body = req.body;
    const p = this.playtest;
    switch (body.action) {
      case 'status':
        this.ok(
          req.id,
          'edit',
          compact({
            running: p.running,
            starting: p.starting,
            mode: p.mode,
            players: p.players,
            externally_started: p.externallyStarted,
            // A multiplayer test leaves the edit DM in edit mode (v1.1 Notes).
            edit_mode_active: !p.running || p.mode === 'multiplayer',
            peers: this.#peerList(),
            elapsed_s: p.startedAt === null ? 0 : Math.round((performance.now() / 1000 - p.startedAt) * 10) / 10,
            controllers: [],
            persisted: [],
          }),
        );
        return;
      case 'list':
        this.ok(req.id, 'edit', { controllers: this.peers.flatMap((peer) => this.controllers(peer)) });
        return;
      case 'run_until':
        if (malformed(body.predicate)) {
          this.fail(req.id, dm, 'syntax_error', 'StudioLivePredicate:1: Malformed string', { stack: '', output: [] });
          return;
        }
        this.ok(req.id, dm, { result: true, value: true, elapsed_ms: 1, checks: 1 });
        return;
      case 'install': {
        if (typeof body.name !== 'string' || typeof body.code !== 'string') {
          this.fail(req.id, dm, 'bad_request', "install: 'name' and 'code' are required");
          return;
        }
        if (malformed(body.code)) {
          this.fail(req.id, dm, 'syntax_error', 'StudioLiveController:1: Malformed string', { stack: '', output: [] });
          return;
        }
        const map = this.#controllersOf(dm);
        const replaced = map.has(body.name);
        map.set(body.name, { code: body.code, persist: body.persist === true });
        this.emit({ type: 'controller', dm, name: body.name, state: 'installed' });
        this.ok(req.id, dm, { installed: body.name, replaced, persist: body.persist === true });
        return;
      }
      case 'uninstall': {
        const map = this.#controllersOf(dm);
        if (typeof body.name !== 'string' || !map.has(body.name)) {
          this.fail(req.id, dm, 'bad_request', `uninstall: no controller '${body.name}' on ${dm}`);
          return;
        }
        map.delete(body.name);
        this.emit({ type: 'controller', dm, name: body.name, state: 'unloaded' });
        this.ok(req.id, dm, { uninstalled: body.name });
        return;
      }
      case 'hotpatch':
        if (typeof body.path !== 'string' || typeof body.source !== 'string') {
          this.fail(req.id, dm, 'bad_request', "hotpatch: 'path' and 'source' are required");
          return;
        }
        this.ok(req.id, dm, { patched: body.path, class: 'Script', restarted: body.restart !== false });
        return;
      case 'start':
        this.#start(req);
        return;
      case 'stop':
        this.#stop(req);
        return;
      case 'add_players':
        this.#addPlayers(req);
        return;
      default:
        this.fail(req.id, dm, 'unsupported', `fake hub does not implement playtest ${body.action}`);
    }
  }

  /**
   * `start {mode, players}`: `starting` event, then the server peer and the clients appear one by one
   * (play: one client with a real user id; run: none; multiplayer: `players` test players Player1..N
   * with userId −1, −2, …), then `running` and the §4.3 response. `busy` while a test is starting/running.
   */
  #start(req) {
    const { id } = req;
    const body = req.body;
    if (this.playtest.starting) {
      this.fail(id, 'edit', 'busy', 'a playtest is already starting');
      return;
    }
    if (this.playtest.running) {
      this.fail(id, 'edit', 'busy', 'a playtest is already running; stop it first');
      return;
    }
    const mode = body.mode === 'run' || body.mode === 'multiplayer' ? body.mode : 'play';
    const requested = Number.isInteger(body.players) ? Math.min(MAX_PLAYERS, Math.max(1, body.players)) : DEFAULT_PLAYERS;
    const players = mode === 'multiplayer' ? requested : null;
    const t0 = performance.now();
    this.playtest = { running: false, starting: true, mode, players, startedAt: t0 / 1000, externallyStarted: false };
    this.#removePeers();
    this.#playtestState('starting');
    const arrivals = [() => this.#addPeer('server')];
    if (mode === 'play') arrivals.push(() => this.#addPeer('client:1', { userId: 100000001, playerName: 'roblox_user_100000001' }));
    if (mode === 'multiplayer') for (let n = 1; n <= players; n += 1) arrivals.push(() => this.#addPeer(`client:${n}`, { userId: -n, playerName: `Player${n}` }));
    const step = () => {
      const arrive = arrivals.shift();
      if (arrive) {
        arrive();
        this.hb();
        entry.timer = setTimeout(step, PEER_SPAWN_MS);
        return;
      }
      this.#inflight.delete(id);
      this.playtest.starting = false;
      this.playtest.running = true;
      this.#playtestState('running');
      this.ok(id, 'edit', compact({ running: true, mode, players, peers: this.#peerList(), started_ms: Math.round(performance.now() - t0) }));
    };
    const entry = { dm: 'edit', timer: setTimeout(step, PEER_SPAWN_MS), onCancel: () => this.#endTest() };
    this.#inflight.set(id, entry);
  }

  /** `add_players {count}`: the server agent's `addplayers`, then the new clients join as client:N+1… */
  #addPlayers(req) {
    const { id } = req;
    const count = Number.isInteger(req.body.count) ? Math.min(MAX_PLAYERS, Math.max(1, req.body.count)) : 1;
    if (!this.peers.includes('server')) {
      this.fail(id, 'edit', 'no_peer', 'no server peer; start a multiplayer playtest first');
      return;
    }
    if (this.playtest.mode !== null && this.playtest.mode !== 'multiplayer') {
      this.fail(id, 'edit', 'bad_request', `add_players needs a multiplayer playtest (current mode: ${this.playtest.mode})`);
      return;
    }
    const t0 = performance.now();
    const before = this.clients().length;
    for (let i = 1; i <= count; i += 1) {
      const n = before + i;
      this.#addPeer(`client:${n}`, { userId: -n, playerName: `Player${n}` });
    }
    this.playtest.players = Math.max(this.playtest.players ?? before, before + count);
    this.hb();
    this.ok(id, 'edit', {
      added: count,
      joined: count,
      complete: true,
      players: this.playtest.players,
      peers: this.#peerList(),
      waited_ms: Math.round(performance.now() - t0),
    });
  }

  /** `stop`: `endtest` through the server peer → stopping, peers gone, stopped. Without a server peer: nothing to end. */
  #stop(req) {
    const { id } = req;
    const t0 = performance.now();
    if (!this.peers.includes('server')) {
      this.playtest = IDLE_PLAYTEST();
      this.ok(id, 'edit', { stopped_ms: 0, note: 'no playtest was running' });
      return;
    }
    this.playtest.running = true;
    this.playtest.starting = false;
    this.#playtestState('stopping');
    this.#endTest();
    this.ok(id, 'edit', { stopped_ms: Math.max(1, Math.round(performance.now() - t0)) });
  }

  #endTest() {
    const mode = this.playtest.mode;
    this.#removePeers();
    this.playtest = IDLE_PLAYTEST();
    this.#playtestState('stopped', { mode });
  }

  /**
   * `push {paths, dm, parent, replace}` (v1.1 Notes): validates like the hub, resolves body.dm to a peer and
   * answers the hub's shape {dm, paths, count, bytes, b64_bytes, serialize_ms, apply_ms, replaced, replicated, note}
   * on a `res` whose frame dm is `edit` (the hub's dispatcher) while body.dm names the destination.
   * Each root lands under `parent` when given, else at its edit-DM path; with `replace` (the tool's
   * default) a root already landed at that path is destroyed first and counted in `replaced`.
   */
  #push(req) {
    const { id } = req;
    const body = req.body;
    const list = body.paths;
    if (!Array.isArray(list) || list.length === 0) {
      this.fail(id, 'edit', 'bad_request', "push: 'paths' must be a non-empty array of instance paths");
      return;
    }
    if (list.length > 200) {
      this.fail(id, 'edit', 'bad_request', 'push: at most 200 paths per call');
      return;
    }
    const target = typeof body.dm === 'string' && body.dm !== '' ? body.dm : 'server';
    if (!/^(server|client(:\d+)?)$/.test(target)) {
      this.fail(id, 'edit', 'bad_request', `push: 'dm' must be "server", "client" or "client:N", got '${target}'`);
      return;
    }
    if (body.parent !== undefined && (typeof body.parent !== 'string' || body.parent === '')) {
      this.fail(id, 'edit', 'bad_request', "push: 'parent' must be an instance path");
      return;
    }
    const dm = this.#resolveDm(target);
    if (dm === null || dm === 'edit') {
      this.fail(id, 'edit', 'no_peer', `push: dm '${target}' is not connected`);
      return;
    }
    const paths = list.map((p) => (body.parent ? `${body.parent}.${String(p).split('.').pop()}` : String(p)));
    const bytes = 20 * list.length;
    const replace = body.replace !== false;
    let landed = this.#landed.get(dm);
    if (!landed) {
      landed = new Set();
      this.#landed.set(dm, landed);
    }
    let replaced = 0;
    for (const p of paths) {
      if (landed.has(p) && replace) replaced += 1;
      landed.add(p);
    }
    this.pushes.push({ dm, paths: list, parent: body.parent ?? null, replace, replaced });
    this.ok(id, 'edit', {
      dm,
      paths,
      count: paths.length,
      bytes,
      b64_bytes: Math.ceil(bytes / 3) * 4,
      serialize_ms: 1,
      apply_ms: 1,
      replaced,
      replicated: dm === 'server',
      note: dm === 'server' ? 'pushed to the server: replicates to every client' : 'pushed to a client: local to that client only',
    });
  }

  /**
   * `run` behaviours keyed on `body.code`: "error" → luau_error; "hang" → never answers (until cancelled);
   * "sleep:<ms>" → progress, then ok after ms or `timeout` at deadline_ms; "big:…" → echoes length + sha256
   * and pads the response past the chunk threshold; "overlap" → a program that built intersecting and
   * nested parts, judged by `body.geometry_policy` (§4.1: warn → ok with `geometry` + `warnings`, reject →
   * `geometry_violation` with the report and the recording cancelled, off / absent → no check); a raw
   * newline inside a quoted literal → the compiler's `syntax_error: Malformed string`; anything else →
   * echoes code and args.
   */
  #run(req, dm) {
    const { id } = req;
    const code = String(req.body.code ?? '');
    const base = {
      output: [{ level: 'print', msg: 'fake hub ran the program', t: 1 }],
      duration_ms: 1,
      changes: { added: 0, removed: 0, paths: [] },
      undo: dm === 'edit' ? 'committed' : 'n/a',
      ephemeral: dm !== 'edit',
    };
    if (malformed(code)) {
      this.fail(id, dm, 'syntax_error', 'StudioLiveProgram:1: Malformed string', { stack: '', output: [] });
      return;
    }
    if (code === 'error') {
      this.fail(id, dm, 'luau_error', 'boom', { stack: 'StudioLiveProgram:1: boom', output: [] });
      return;
    }
    if (code.trimEnd() === 'overlap') {
      // (trimEnd: a saved skill's source ends with a newline)
      const policy = req.body.geometry_policy;
      if (policy !== undefined && !GEOMETRY_POLICIES.includes(policy)) {
        this.fail(id, dm, 'bad_request', `run: geometry_policy must be warn | reject | off, got '${policy}'`);
        return;
      }
      this.geometryRuns.push({ dm, policy: policy ?? null });
      const built = { value: { built: 4 }, ...base, changes: { added: 4, removed: 0, paths: ['Workspace.Map'] } };
      if (policy === undefined || policy === 'off') {
        this.ok(id, dm, built);
        return;
      }
      const report = trimReport(geometryReport({ checked: 4 }));
      const warnings = geometryWarnings(report);
      if (policy === 'reject') {
        // The recording is cancelled (the parts are gone), so undo says so and the change counts are omitted.
        const { overlaps, nested } = report.totals;
        this.fail(
          id,
          dm,
          'geometry_violation',
          `${overlaps} overlapping part pair${overlaps === 1 ? '' : 's'} and ${nested} part${nested === 1 ? '' : 's'} parented under a part — the program was rolled back (geometry_policy reject); see geometry`,
          { geometry: report, warnings, undo: dm === 'edit' ? 'cancelled' : 'n/a', output: base.output },
        );
        return;
      }
      this.ok(id, dm, { ...built, geometry: report, warnings });
      return;
    }
    if (code === 'hang') {
      this.#inflight.set(id, { dm, timer: null });
      return;
    }
    const sleep = /^sleep:(\d+)$/.exec(code);
    if (sleep) {
      const ms = Number(sleep[1]);
      this.send({ v: PROTO_VERSION, kind: 'progress', id, note: `sleeping ${ms} ms`, pct: 0.1 });
      const timer = setTimeout(() => {
        this.#inflight.delete(id);
        if (ms > req.deadline_ms) this.fail(id, dm, 'timeout', `deadline of ${req.deadline_ms} ms exceeded`);
        else this.ok(id, dm, { value: { slept_ms: ms }, ...base });
      }, Math.min(ms, req.deadline_ms));
      this.#inflight.set(id, { dm, timer });
      return;
    }
    if (code.startsWith('big:')) {
      const sha256 = createHash('sha256').update(code).digest('hex');
      this.ok(id, dm, { value: { len: code.length, sha256 }, big: 'y'.repeat(code.length), ...base });
      return;
    }
    this.ok(id, dm, { value: { echo: code, args: req.body.args ?? null }, ...base });
  }

  #cancel(id) {
    const entry = this.#inflight.get(id);
    if (!entry) return;
    this.#inflight.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.onCancel) entry.onCancel();
    this.fail(id, entry.dm, 'cancelled', 'cancelled by request');
  }

  #status(dm) {
    const { placeId, placeName, universeId, creatorType, creatorId } = this.identity;
    const place = { placeId, placeName, dataModelName: 'Place1' };
    if (!this.statusOmitsIdentity) Object.assign(place, { universeId, creatorType, creatorId });
    return {
      session: this.session,
      bootstrap: this.bootstrap,
      bundleHash: 'sha256-fake',
      role: 'edit',
      place,
      peers: this.#peerList(),
      playtest: this.#playtestInfo(),
      capabilities: { loadstring: true, virtualInput: false, capture: false, pluginConnection: true },
      fps: 60,
      instanceCount: 0,
      journal: { seq: this.seq, dropped: 0, unacked: 0 },
      writeQueue: { waiting: 0 },
      persisted: this.persisted.length,
      dm,
    };
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
  };
  const port = Number(flag('--port', process.env.STUDIO_LIVE_PORT ?? '47800'));
  const hub = await FakeHub.connect(port, { session: flag('--session', undefined), log: (line) => console.error(`[fake-hub] ${line}`) });
  const { ack, bundle } = await hub.hello();
  if (ack.kind !== 'hello_ack') {
    console.error(`[fake-hub] bridge refused hello: ${JSON.stringify(ack)}`);
    process.exit(1);
  }
  console.error(
    `[fake-hub] connected to ws://127.0.0.1:${port}/studio as ${hub.session}: bridge ${ack.bridge}, bundle ${bundle?.hash ?? 'none'} (${Object.keys(bundle?.modules ?? {}).length} modules)`,
  );
  hub.hb();
  const heartbeat = setInterval(() => hub.hb(), 10_000);
  const ticker = setInterval(() => hub.emit({ type: 'milestone', name: 'fake-hub-tick', data: { uptime_s: Math.round(performance.now() / 1000) } }), 15_000);
  const code = await hub.closed;
  clearInterval(heartbeat);
  clearInterval(ticker);
  console.error(`[fake-hub] socket closed (${code})`);
}
