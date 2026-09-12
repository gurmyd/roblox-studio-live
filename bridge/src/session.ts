import { randomBytes } from 'node:crypto';
import type { WebSocket } from 'ws';
import { ChunkAssembler, nextChunkId, splitFrame } from './chunk.js';
import { BridgeError } from './errors.js';
import { Journal, type JournalStats } from './journal.js';
import { JobStore, type Job, type JobOrigin } from './jobs.js';
import type { Logger } from './log.js';
import { PersistStore } from './persist.js';
import {
  DEFAULT_DEADLINE_MS,
  L1_CHUNK_THRESHOLD_BYTES,
  PROTO_VERSION,
  isChunkFrame,
  isErrorFrame,
  isEvFrame,
  isHbFrame,
  isHelloFrame,
  isProgressFrame,
  isResFrame,
  parseFrame,
  playtestInfoFromEvent,
  type AnyFrame,
  type BridgeToHubFrame,
  type BundlePayload,
  type HelloFrame,
  type JsonObject,
  type PeerInfo,
  type PlaytestInfo,
  type ResFrame,
  type StudioInfo,
} from './protocol.js';

export const STALE_AFTER_MS = 25_000;
/** Protocol asks for an ack at least every 2 s while events flow; 1 s keeps a comfortable margin. */
export const ACK_INTERVAL_MS = 1_000;
/** Local timer slack beyond `deadline_ms` before the bridge gives up on a response itself. */
export const REQUEST_GRACE_MS = 5_000;
/** A hub that has been disconnected this long (and has nothing in flight) is forgotten, journal included. */
export const SESSION_EVICT_MS = 30 * 60 * 1000;
/** Upper bound on disconnected sessions kept for backfill; the oldest go first. */
export const MAX_DISCONNECTED_SESSIONS = 8;
const STALE_CHECK_MS = 5_000;
const WS_OPEN = 1;

/**
 * Random per process. Request ids embed it so a restarted bridge never reuses an id the hub (or an
 * agent) still holds for a request from the previous process (protocol Notes, "Job handles").
 */
export const BRIDGE_ID = randomBytes(3).toString('hex');
export const REQUEST_ID_PATTERN = /^r-[0-9a-f]{6}-\d+$/;

let requestCounter = 0;

export function nextRequestId(): string {
  requestCounter += 1;
  return `r-${BRIDGE_ID}-${requestCounter}`;
}

export interface BundleSource {
  readonly current: BundlePayload;
}

export interface SessionRegistryOptions {
  bundle: BundleSource;
  jobs: JobStore;
  log: Logger;
  bridgeVersion: string;
  /** Persisted-controller registry pushed to hubs as `persist_sync`; memory-only when omitted (tests). */
  persist?: PersistStore;
  /** Bootstrap version this package ships; hubs announcing an older one are flagged (§8). */
  shippedBootstrap?: string | null;
  ackIntervalMs?: number;
  requestGraceMs?: number;
  evictAfterMs?: number;
}

/** Numeric semver order (`1.2.10` > `1.2.9`); anything unparsable compares equal so it is never flagged. */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string): number[] | null => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    return m ? m.slice(1, 4).map(Number) : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Fields only the hub's heartbeats can fill in (resolved place name, universe / creator identity). */
const LEARNED_FROM_HB = ['placeName', 'universeId', 'creatorType', 'creatorId'] as const;

/**
 * `hello.studio` on top of what the session knows, except that identity learned from heartbeats is
 * kept when the hello names the same place (`placeId` unchanged or absent); a different placeId is
 * a different place and the hello wins outright.
 */
export function mergeHelloStudio(known: StudioInfo | null, hello: StudioInfo | undefined): StudioInfo {
  const merged: StudioInfo = { ...known, ...hello };
  if (!known || !hello) return merged;
  const samePlace = hello.placeId === undefined || known.placeId === undefined || hello.placeId === known.placeId;
  if (!samePlace) return merged;
  for (const field of LEARNED_FROM_HB) {
    const learned = known[field];
    if (learned !== undefined) (merged as Record<string, unknown>)[field] = learned;
  }
  return merged;
}

export interface HbState {
  seq: number;
  t: number;
  peers: PeerInfo[];
  playtest: PlaytestInfo;
  dropped: number;
  fps: number | null;
  at: number;
}

export interface RequestOptions {
  dm?: string;
  deadlineMs?: number;
  origin?: JobOrigin;
  /** MCP request cancellation: aborting while the request is in flight sends `cancel` to Studio. */
  signal?: AbortSignal;
}

export interface SessionStatus {
  session: string;
  connected: boolean;
  stale: boolean;
  active: boolean;
  role: string;
  bootstrap: string;
  /** The hub's bootstrap is older than the one this package ships: reinstall the plugin and restart Studio. */
  bootstrapOutdated: boolean;
  studio: StudioInfo | null;
  /** Place identity (game.GameId / CreatorType / CreatorId) as reported by the hub; null until it says. */
  universeId: number | null;
  creatorType: string | null;
  creatorId: number | null;
  bundleHash: string | null;
  peers: PeerInfo[];
  /** Latest hub heartbeat, corrected by any newer `playtest` event (see `HubSession.playtest`). */
  playtest: PlaytestInfo | null;
  fps: number | null;
  hubDropped: number;
  journal: JournalStats;
  inflight: number;
  /** Controllers the bridge persists for this session (`playtest install persist=true`). */
  persisted: number;
  connectedAt: number | null;
  lastSeenAt: number | null;
  lastHbAt: number | null;
}

/** Deadline of bridge-internal requests (`persist_sync`); they are never surfaced as jobs. */
const INTERNAL_DEADLINE_MS = DEFAULT_DEADLINE_MS;

interface InternalRequest {
  op: string;
  timer: NodeJS.Timeout;
  onResult?: ((frame: ResFrame) => void) | undefined;
}

export type SessionChange = 'connected' | 'disconnected' | 'hb';
export type EventListener = (session: HubSession, ev: import('./protocol.js').EvFrame) => void;
export type SessionListener = (session: HubSession, change: SessionChange) => void;

interface SessionEnv {
  jobs: JobStore;
  log: Logger;
  shippedBootstrap: string | null;
  ackIntervalMs: number;
  requestGraceMs: number;
  emitEvent: EventListener;
  emitChange: SessionListener;
}

/** One hub (edit-DM runtime) identified by the GUID in its `hello`. Survives socket reconnects. */
export class HubSession {
  readonly id: string;
  readonly journal = new Journal();
  role = 'edit';
  bootstrap = '';
  bootstrapOutdated = false;
  studio: StudioInfo | null = null;
  bundleHash: string | null = null;
  hb: HbState | null = null;
  /**
   * Playtest state as the bridge best knows it: the last `hb.playtest`, overridden by any
   * `playtest` event with a higher seq than that heartbeat, so consumers (the `/events`
   * heartbeat, `/status`) are never more than one event behind rather than up to 10 s.
   */
  playtest: PlaytestInfo | null = null;
  /** Seq of the frame (`hb.seq` or `ev.seq`) that last set `playtest`. */
  private playtestSeq = 0;
  stale = false;
  connectedAt: number | null = null;
  lastSeenAt: number | null = null;
  lastHbAt: number | null = null;
  /**
   * Requests awaiting a `res`. They deliberately survive socket closes and rebinds: the hub runtime
   * keeps executing across the bootstrap's reconnects (25-minute refresh, transient drops) and answers
   * with the same id on the new socket. A job ends only on its response, its deadline, or a cancel.
   */
  readonly inflight = new Map<string, Job>();
  /** Persisted controllers known for this session at the last sync (for status / list). */
  persistedCount = 0;
  /** Set once the hub answered `unsupported` to `persist_sync` (older runtime); logged once. */
  persistSyncUnsupported = false;

  private socket: WebSocket | null = null;
  /** Bridge-internal requests (`persist_sync`): answered frames are consumed here, never jobs. */
  private readonly internal = new Map<string, InternalRequest>();
  private ackTimer: NodeJS.Timeout | null = null;
  private readonly env: SessionEnv;
  private readonly log: Logger;

  constructor(id: string, env: SessionEnv) {
    this.id = id;
    this.env = env;
    this.log = env.log.child(`hub:${id.slice(0, 8)}`);
  }

  get connected(): boolean {
    return this.socket !== null && this.socket.readyState === WS_OPEN;
  }

  get peers(): PeerInfo[] {
    return this.hb?.peers ?? [];
  }

  /** Short human label for logs and multi-session hints. */
  get label(): string {
    const place = this.studio?.placeName;
    return place ? `${this.id.slice(0, 8)} (${place})` : this.id.slice(0, 8);
  }

  /** DMs reachable right now: `edit` when the hub is connected plus every connected peer. */
  alive(): string[] {
    const list: string[] = this.connected ? ['edit'] : [];
    for (const peer of this.peers) if (peer.connected) list.push(peer.dm);
    return list;
  }

  bind(socket: WebSocket, hello: HelloFrame): void {
    const previous = this.socket;
    if (previous && previous !== socket) {
      this.log.info('replacing hub socket (duplicate hello)', { inflight: this.inflight.size });
      this.socket = null;
      previous.close(1000, 'replaced');
    }
    const now = Date.now();
    this.socket = socket;
    this.role = hello.role;
    this.bootstrap = hello.bootstrap;
    // A re-hello (socket refresh) repeats game.Name ("Place1" for a cloud place) and cannot carry the
    // universe/creator ids: whatever the hub already reported over hb wins, as long as it is the same place.
    this.studio = hello.studio || this.studio ? mergeHelloStudio(this.studio, hello.studio) : null;
    this.connectedAt = now;
    this.lastSeenAt = now;
    this.stale = false;
    const shipped = this.env.shippedBootstrap;
    this.bootstrapOutdated = shipped !== null && compareSemver(hello.bootstrap, shipped) < 0;
    this.log.info('hub connected', {
      role: hello.role,
      bootstrap: hello.bootstrap,
      place: hello.studio?.placeName,
      lastSeq: hello.lastSeq ?? 0,
      journalSeq: this.journal.latestSeq,
      inflight: this.inflight.size,
    });
    if (this.bootstrapOutdated) {
      this.log.warn('Studio runs an older bootstrap than this package ships; run "studio-live install" and restart Studio', {
        installed: hello.bootstrap,
        shipped,
      });
    }
    this.env.emitChange(this, 'connected');
  }

  onSocketClosed(socket: WebSocket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.clearAckTimer();
    this.log.info('hub disconnected', { inflight: this.inflight.size });
    this.env.emitChange(this, 'disconnected');
  }

  /** Handles any post-hello frame from this hub. */
  handleFrame(frame: AnyFrame): void {
    this.touch();
    if (isResFrame(frame)) {
      const internal = this.internal.get(frame.id);
      if (internal) {
        clearTimeout(internal.timer);
        this.internal.delete(frame.id);
        internal.onResult?.(frame);
        return;
      }
      const job = this.inflight.get(frame.id);
      if (!job) {
        this.log.debug('response for unknown request ignored', { id: frame.id });
        return;
      }
      if (frame.ok) job.complete(frame.body, frame.dm);
      else if (frame.error) job.fail(frame.error, frame.dm);
    } else if (isProgressFrame(frame)) {
      if (this.internal.has(frame.id)) return;
      this.inflight.get(frame.id)?.note(frame.note, frame.pct);
    } else if (isEvFrame(frame)) {
      if (this.journal.ingest(frame)) {
        this.scheduleAck();
        // A playtest event newer than the last heartbeat moves the flag now; re-sent (deduped) events never do.
        const implied = playtestInfoFromEvent(frame, this.playtest);
        if (implied && frame.seq > this.playtestSeq) {
          this.playtest = implied;
          this.playtestSeq = frame.seq;
        }
        this.env.emitEvent(this, frame);
      }
    } else if (isHbFrame(frame)) {
      const now = Date.now();
      this.hb = {
        seq: frame.seq,
        t: frame.t,
        peers: frame.peers,
        playtest: frame.playtest,
        dropped: frame.dropped,
        fps: typeof frame.fps === 'number' ? frame.fps : null,
        at: now,
      };
      this.lastHbAt = now;
      // The heartbeat is the hub's own snapshot at hb.seq: it supersedes any event-derived guess up to that seq.
      if (frame.seq >= this.playtestSeq) {
        this.playtest = frame.playtest;
        this.playtestSeq = frame.seq;
      }
      // The hello only knows game.Name ("Place1"); the hub reports the real place name once it has looked it up.
      const learned: StudioInfo = {};
      if (typeof frame.placeName === 'string' && frame.placeName !== '') learned.placeName = frame.placeName;
      if (typeof frame.universeId === 'number') learned.universeId = frame.universeId;
      if (typeof frame.creatorType === 'string') learned.creatorType = frame.creatorType;
      if (typeof frame.creatorId === 'number') learned.creatorId = frame.creatorId;
      if (Object.keys(learned).length > 0) this.studio = { ...(this.studio ?? {}), ...learned };
      this.sendAckNow();
      this.env.emitChange(this, 'hb');
    } else if (isErrorFrame(frame)) {
      this.log.warn('hub reported error', { code: frame.code, message: frame.message });
    } else {
      this.log.debug('ignoring frame', { kind: frame.kind });
    }
  }

  /** Sends one frame, chunking it when the encoded text exceeds the L1 threshold. */
  send(frame: BridgeToHubFrame): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WS_OPEN) {
      throw new BridgeError('disconnected', `hub ${this.id} is not connected`);
    }
    const text = JSON.stringify(frame);
    if (Buffer.byteLength(text, 'utf8') <= L1_CHUNK_THRESHOLD_BYTES) {
      socket.send(text);
      return;
    }
    for (const chunk of splitFrame(text, nextChunkId())) socket.send(JSON.stringify(chunk));
  }

  /** Best-effort send for frames where a closed socket is not an error (cancel, ack). */
  trySend(frame: BridgeToHubFrame): boolean {
    try {
      this.send(frame);
      return true;
    } catch {
      return false;
    }
  }

  request(op: string, body: JsonObject, options: RequestOptions = {}): Job {
    if (!this.connected) throw new BridgeError('disconnected', `hub ${this.id} is not connected`);
    const id = nextRequestId();
    const dm = options.dm ?? 'edit';
    const deadline = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
    const job = this.env.jobs.create({
      id,
      op,
      dm,
      session: this.id,
      origin: options.origin ?? 'stdio',
      onCancel: () => {
        this.trySend({ v: PROTO_VERSION, kind: 'cancel', id });
      },
    });
    this.inflight.set(id, job);
    const timer = setTimeout(() => {
      if (!job.running) return;
      const limit = deadline + this.env.requestGraceMs;
      if (this.connected) {
        job.fail({ code: 'timeout', message: `${op} on ${dm} did not answer within ${limit} ms` });
      } else {
        job.fail({ code: 'disconnected', message: `${op} on ${dm}: the hub did not reconnect within ${limit} ms of the request` });
      }
      this.trySend({ v: PROTO_VERSION, kind: 'cancel', id });
    }, deadline + this.env.requestGraceMs);
    const signal = options.signal;
    const onAbort = (): void => {
      if (job.cancel()) this.log.info('request cancelled by the MCP client', { id, op, dm });
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    job.onFinish(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      this.inflight.delete(id);
    });
    try {
      this.send({ v: PROTO_VERSION, kind: 'req', id, op, dm, deadline_ms: deadline, body });
    } catch (err) {
      job.fail({ code: 'disconnected', message: err instanceof Error ? err.message : String(err) });
      throw err;
    }
    return job;
  }

  /**
   * Sends a `req` the bridge itself owns (`persist_sync`): the response is handed to `onResult`
   * (or dropped) instead of becoming a job, so it never shows in `job list`. Returns the request
   * id, or null when the hub is not connected.
   */
  sendInternal(op: string, body: JsonObject, onResult?: (frame: ResFrame) => void): string | null {
    if (!this.connected) return null;
    const id = nextRequestId();
    const timer = setTimeout(() => {
      this.internal.delete(id);
      this.log.debug('internal request unanswered', { id, op });
    }, INTERNAL_DEADLINE_MS + this.env.requestGraceMs);
    timer.unref();
    this.internal.set(id, { op, timer, onResult });
    try {
      this.send({ v: PROTO_VERSION, kind: 'req', id, op, dm: 'edit', deadline_ms: INTERNAL_DEADLINE_MS, body });
    } catch (err) {
      clearTimeout(timer);
      this.internal.delete(id);
      this.log.debug('internal request not sent', { id, op, err });
      return null;
    }
    return id;
  }

  deliverBundle(bundle: BundlePayload): void {
    this.send({ v: PROTO_VERSION, kind: 'bundle', hash: bundle.hash, entry: bundle.entry, modules: bundle.modules });
    this.bundleHash = bundle.hash;
  }

  cancelAll(): void {
    this.trySend({ v: PROTO_VERSION, kind: 'cancel_all' });
  }

  markStaleIfSilent(): void {
    if (!this.connected || this.stale || this.lastSeenAt === null) return;
    if (Date.now() - this.lastSeenAt > STALE_AFTER_MS) {
      this.stale = true;
      this.log.warn('hub is stale (no frames)', { silentMs: Date.now() - this.lastSeenAt });
    }
  }

  status(active: boolean): SessionStatus {
    return {
      session: this.id,
      connected: this.connected,
      stale: this.stale,
      active,
      role: this.role,
      bootstrap: this.bootstrap,
      bootstrapOutdated: this.bootstrapOutdated,
      studio: this.studio,
      universeId: this.studio?.universeId ?? null,
      creatorType: this.studio?.creatorType ?? null,
      creatorId: this.studio?.creatorId ?? null,
      bundleHash: this.bundleHash,
      peers: this.peers,
      playtest: this.playtest,
      fps: this.hb?.fps ?? null,
      hubDropped: this.hb?.dropped ?? 0,
      journal: this.journal.stats(),
      inflight: this.inflight.size,
      persisted: this.persistedCount,
      connectedAt: this.connectedAt,
      lastSeenAt: this.lastSeenAt,
      lastHbAt: this.lastHbAt,
    };
  }

  close(): void {
    this.clearAckTimer();
    for (const pending of this.internal.values()) clearTimeout(pending.timer);
    this.internal.clear();
    this.socket?.close(1001, 'bridge shutting down');
  }

  private touch(): void {
    this.lastSeenAt = Date.now();
    if (this.stale) {
      this.stale = false;
      this.log.info('hub is responsive again');
    }
  }

  private scheduleAck(): void {
    if (this.ackTimer) return;
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null;
      this.sendAckNow();
    }, this.env.ackIntervalMs);
  }

  private sendAckNow(): void {
    this.clearAckTimer();
    this.trySend({ v: PROTO_VERSION, kind: 'ack', upto: this.journal.latestSeq });
  }

  private clearAckTimer(): void {
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.ackTimer = null;
  }
}

export interface ResolveOptions {
  allowDisconnected?: boolean;
  /** Write tools: with several hubs connected the caller must name one, so a build never lands in the wrong place. */
  write?: boolean;
}

/** Owns every hub session, the L1 handshake, the bundle push and the persisted-controller sync. */
export class SessionRegistry {
  /** Persisted playtest controllers (bridge-side); tools mutate it and then call `syncPersisted`. */
  readonly persist: PersistStore;
  private readonly sessions = new Map<string, HubSession>();
  private readonly eventListeners = new Set<EventListener>();
  private readonly changeListeners = new Set<SessionListener>();
  private readonly staleTimer: NodeJS.Timeout;
  private readonly env: SessionEnv;
  private readonly bundle: BundleSource;
  private readonly bridgeVersion: string;
  private readonly evictAfterMs: number;
  private readonly log: Logger;
  /**
   * The session tools use when they omit `session`. Sticky: chosen when a hub connects while none is
   * active or when a tool names one explicitly, and re-elected only when that hub disconnects — never
   * on heartbeats, so two open Studios do not alternate.
   */
  private activeId: string | null = null;

  constructor(options: SessionRegistryOptions) {
    this.bundle = options.bundle;
    this.bridgeVersion = options.bridgeVersion;
    this.evictAfterMs = options.evictAfterMs ?? SESSION_EVICT_MS;
    this.log = options.log.child('sessions');
    this.persist = options.persist ?? new PersistStore(null, this.log.child('persist'));
    this.env = {
      jobs: options.jobs,
      log: options.log,
      shippedBootstrap: options.shippedBootstrap ?? null,
      ackIntervalMs: options.ackIntervalMs ?? ACK_INTERVAL_MS,
      requestGraceMs: options.requestGraceMs ?? REQUEST_GRACE_MS,
      emitEvent: (session, ev) => {
        for (const fn of this.eventListeners) fn(session, ev);
      },
      emitChange: (session, change) => {
        this.electActive(session, change);
        for (const fn of this.changeListeners) fn(session, change);
      },
    };
    this.staleTimer = setInterval(() => this.sweep(), STALE_CHECK_MS);
    this.staleTimer.unref();
  }

  /** Periodic housekeeping: flags silent hubs and forgets disconnected sessions past their grace. */
  sweep(): void {
    for (const session of this.sessions.values()) session.markStaleIfSilent();
    this.evictStale();
  }

  /** Wires a freshly upgraded `/studio` socket; the first frame must be `hello`. */
  attach(socket: WebSocket, remote: string): void {
    const assembler = new ChunkAssembler();
    let session: HubSession | null = null;
    const log = this.log;

    const dispatch = (frame: AnyFrame): void => {
      if (isChunkFrame(frame)) {
        let text: string | null;
        try {
          text = assembler.accept(frame);
        } catch (err) {
          log.warn('dropping oversized chunked frame', { err, remote });
          return;
        }
        if (text === null) return;
        const inner = parseFrame(text);
        if (inner && !isChunkFrame(inner)) dispatch(inner);
        return;
      }
      if (isHelloFrame(frame)) {
        session = this.handleHello(socket, frame, remote);
        return;
      }
      if (!session) {
        log.debug('frame before hello ignored', { kind: frame.kind, remote });
        return;
      }
      session.handleFrame(frame);
    };

    socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      const frame = parseFrame(data.toString());
      if (!frame) {
        log.debug('unparseable frame ignored', { remote });
        return;
      }
      dispatch(frame);
    });
    socket.on('close', () => {
      assembler.clear();
      session?.onSocketClosed(socket);
    });
    socket.on('error', (err) => log.warn('hub socket error', { err, remote }));
  }

  get(id: string): HubSession | undefined {
    return this.sessions.get(id);
  }

  all(): HubSession[] {
    return [...this.sessions.values()];
  }

  connected(): HubSession[] {
    return this.all().filter((s) => s.connected);
  }

  /** The sticky active session (see `activeId`), or null when no hub is connected. */
  get active(): HubSession | null {
    const session = this.activeId ? this.sessions.get(this.activeId) : undefined;
    return session?.connected ? session : null;
  }

  /**
   * Resolves the tool-facing `session` argument: exact GUID, unique prefix, or
   * the active session when omitted. Naming a connected session makes it the active one.
   */
  resolve(selector?: string | null, options: ResolveOptions = {}): HubSession {
    if (selector) {
      const exact = this.sessions.get(selector);
      const matches = exact ? [exact] : this.all().filter((s) => s.id.startsWith(selector));
      if (matches.length === 0) throw new BridgeError('no_session', `no Studio session matches "${selector}"`);
      if (matches.length > 1) throw new BridgeError('bad_request', `session prefix "${selector}" is ambiguous`);
      const session = matches[0] as HubSession;
      if (!session.connected && !options.allowDisconnected) {
        throw new BridgeError('disconnected', `Studio session ${session.id} is not connected`);
      }
      if (session.connected && this.activeId !== session.id) {
        this.activeId = session.id;
        this.log.info('active session switched by request', { session: session.label });
      }
      return session;
    }
    const active = this.active;
    if (active) {
      if (options.write && this.connected().length > 1) {
        throw new BridgeError(
          'bad_request',
          `several Studio sessions are connected; pass session=<prefix> so the write lands in the right place: ${this.describeConnected()}`,
          { sessions: this.connected().map((s) => ({ session: s.id, place: s.studio?.placeName ?? null, active: s.id === active.id })) },
        );
      }
      return active;
    }
    if (options.allowDisconnected) {
      const fallback = this.all().sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0))[0];
      if (fallback) return fallback;
    }
    throw new BridgeError(
      'no_session',
      'no Roblox Studio connected: install the plugin (studio-live install), open a place, and check GET /status',
    );
  }

  /** One line naming every connected hub, for hints in tool results. */
  describeConnected(): string {
    return this.connected()
      .map((s) => `${s.label}${s.id === this.activeId ? ' [active]' : ''}`)
      .join(', ');
  }

  onEvent(fn: EventListener): () => void {
    this.eventListeners.add(fn);
    return () => {
      this.eventListeners.delete(fn);
    };
  }

  onSessionChange(fn: SessionListener): () => void {
    this.changeListeners.add(fn);
    return () => {
      this.changeListeners.delete(fn);
    };
  }

  broadcastBundle(bundle: BundlePayload): number {
    let delivered = 0;
    for (const session of this.sessions.values()) {
      if (!session.connected) continue;
      try {
        session.deliverBundle(bundle);
        delivered += 1;
        // The replacement runtime starts with an empty persisted list; the bootstrap queues frames
        // until start() returns, so the sync sent now lands in the new runtime.
        void this.syncPersisted(session, 'bundle');
      } catch (err) {
        this.log.warn('bundle push failed', { session: session.id, err });
      }
    }
    if (delivered > 0) this.log.info('bundle pushed', { hubs: delivered, hash: bundle.hash });
    return delivered;
  }

  /**
   * Sends the hub the persisted controllers of its session as `persist_sync {controllers}` (the
   * whole list; the hub replaces its in-memory copy). Called on every hello, after a bundle push
   * and after every install / uninstall that changed the list. Resolves true when the request
   * left the bridge; never throws.
   */
  async syncPersisted(session: HubSession, reason: string): Promise<boolean> {
    let controllers: Array<{ dm: string; name: string; code: string }>;
    try {
      controllers = (await this.persist.attach(session.id, session.studio?.placeId ?? null)).map(({ dm, name, code }) => ({ dm, name, code }));
    } catch (err) {
      this.log.warn('persisted controllers unavailable', { session: session.label, err });
      return false;
    }
    session.persistedCount = controllers.length;
    const id = session.sendInternal('persist_sync', { controllers }, (frame) => {
      if (frame.ok) return;
      const code = frame.error?.code ?? 'error';
      if (code === 'unsupported') {
        if (!session.persistSyncUnsupported) {
          session.persistSyncUnsupported = true;
          this.log.info('hub runtime does not implement persist_sync; persisted controllers stay bridge-side until the runtime updates', { session: session.label });
        }
        return;
      }
      this.log.warn('persist_sync refused by the hub', { session: session.label, code, message: frame.error?.message });
    });
    if (id === null) return false;
    this.log.debug('persist_sync sent', { session: session.label, reason, controllers: controllers.length });
    return true;
  }

  cancelAll(): void {
    for (const session of this.sessions.values()) if (session.connected) session.cancelAll();
  }

  status(): SessionStatus[] {
    const activeId = this.active?.id ?? null;
    return this.all().map((session) => session.status(session.id === activeId));
  }

  close(): void {
    clearInterval(this.staleTimer);
    for (const session of this.sessions.values()) session.close();
  }

  private electActive(session: HubSession, change: SessionChange): void {
    if (change === 'connected') {
      if (!this.active) this.activeId = session.id;
      return;
    }
    if (change === 'disconnected' && this.activeId === session.id) {
      const next = this.connected().sort((a, b) => (b.connectedAt ?? 0) - (a.connectedAt ?? 0))[0];
      this.activeId = next?.id ?? null;
      if (next) this.log.info('active session failed over', { session: next.label });
    }
  }

  /** Forgets disconnected hubs after the grace period, and the oldest ones beyond the cap. */
  private evictStale(): void {
    const now = Date.now();
    const idle = this.all()
      .filter((s) => !s.connected && s.inflight.size === 0)
      .sort((a, b) => (a.lastSeenAt ?? 0) - (b.lastSeenAt ?? 0));
    idle.forEach((session, index) => {
      const tooOld = now - (session.lastSeenAt ?? 0) > this.evictAfterMs;
      const overCap = idle.length - index > MAX_DISCONNECTED_SESSIONS;
      if (tooOld || overCap) {
        this.sessions.delete(session.id);
        this.persist.forgetSession(session.id);
        this.log.info('forgot disconnected session', { session: session.label, journalSize: session.journal.size });
      }
    });
  }

  private handleHello(socket: WebSocket, hello: HelloFrame, remote: string): HubSession | null {
    if (hello.proto !== PROTO_VERSION) {
      this.log.warn('rejecting hub with protocol mismatch', { proto: hello.proto, remote });
      socket.send(
        JSON.stringify({
          v: PROTO_VERSION,
          kind: 'error',
          code: 'proto_mismatch',
          message: `bridge speaks proto ${PROTO_VERSION}, hub sent proto ${hello.proto}; update the plugin or the bridge`,
        }),
      );
      socket.close(1002, 'proto_mismatch');
      return null;
    }
    let session = this.sessions.get(hello.session);
    if (!session) {
      session = new HubSession(hello.session, this.env);
      this.sessions.set(hello.session, session);
    }
    session.bind(socket, hello);
    this.sendHelloAck(session);
    // Every hello (fresh runtime or a socket refresh) gets the session's persisted controllers.
    void this.syncPersisted(session, 'hello');
    return session;
  }

  private sendHelloAck(session: HubSession): void {
    const bundle = this.bundle.current;
    const payload: BundlePayload = { hash: bundle.hash, entry: bundle.entry, modules: bundle.modules };
    const inline = {
      v: PROTO_VERSION,
      kind: 'hello_ack',
      proto: PROTO_VERSION,
      bridge: this.bridgeVersion,
      bridgeId: BRIDGE_ID,
      serverTime: Date.now(),
      ackUpto: session.journal.latestSeq,
      bundle: payload,
    } as const;
    if (Buffer.byteLength(JSON.stringify(inline), 'utf8') <= L1_CHUNK_THRESHOLD_BYTES) {
      session.send(inline);
      session.bundleHash = bundle.hash;
      return;
    }
    session.send({ ...inline, bundle: null });
    session.deliverBundle(payload);
  }
}
